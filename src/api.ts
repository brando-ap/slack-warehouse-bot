// JSON API for the React wallboard (board/). The page itself is a static
// asset; these endpoints are what it polls and posts to. Both require the
// BOARD_KEY. Board actions are attributed to real Slack users via the names
// the bot has learned, so a "Done" tapped on the TV updates the Slack card
// exactly like a button click in Slack.

import * as db from './db';
import { todayInTZ } from './dates';
import { requestBlocks, ticketRef } from './format';
import { photoCount } from './photos';
import { slackApi } from './slack';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

async function keyMatches(provided: string, expected: string): Promise<boolean> {
  const digest = (s: string) => crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  const [a, b] = await Promise.all([digest(provided), digest(expected)]);
  return crypto.subtle.timingSafeEqual(a, b);
}

async function checkKey(env: Env, provided: string | null): Promise<Response | null> {
  if (!env.BOARD_KEY) {
    return json({ error: 'Wallboard is disabled. Set the BOARD_KEY secret and redeploy.' }, 404);
  }
  if (!provided || !(await keyMatches(provided, env.BOARD_KEY))) {
    return json({ error: 'Missing or wrong key.' }, 403);
  }
  return null;
}

export interface BoardTicket {
  id: number;
  ref: string;
  title: string;
  details: string | null;
  company: string | null;
  contact: string | null;
  category: string | null;
  status: string;
  priority: string;
  due: string | null;
  assignee: string | null;
  assigneeName: string | null;
  photos: number;
  createdByName: string | null;
}

function toBoardTicket(r: db.RequestRow, names: Map<string, string>): BoardTicket {
  return {
    id: r.id,
    ref: ticketRef(r.id),
    title: r.title,
    details: r.details,
    company: r.company,
    contact: r.contact,
    category: r.category,
    status: r.status,
    priority: r.priority,
    due: r.due_date,
    assignee: r.assigned_to,
    assigneeName: r.assigned_to ? (names.get(r.assigned_to) ?? null) : null,
    photos: photoCount(r.photos),
    createdByName: names.get(r.created_by) ?? null,
  };
}

/** GET /api/board?key=... — everything the wallboard needs for one render. */
export async function boardData(env: Env, url: URL): Promise<Response> {
  const denied = await checkKey(env, url.searchParams.get('key'));
  if (denied) return denied;

  const [open, categories, names] = await Promise.all([
    db.listOpenRequests(env),
    db.listDirectory(env, 'categories'),
    db.getUserNames(env),
  ]);

  // "Done today" = completed timestamps that land on today's date in TIMEZONE.
  const today = todayInTZ(env.TIMEZONE);
  const dayFmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: env.TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const since = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
  const completed = await db.listCompletedSince(env, since);
  const doneToday = completed.filter((ts) => dayFmt.format(new Date(ts)) === today).length;

  return json({
    generatedAt: new Date().toISOString(),
    timezone: env.TIMEZONE,
    today,
    doneToday,
    categories: categories.map((c) => c.name),
    people: [...names.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)),
    tickets: open.map((r) => toBoardTicket(r, names)),
  });
}

interface BoardActionBody {
  key?: string;
  id?: number;
  action?: string;
  userId?: string;
}

/** POST /api/board/action — claim / progress / done from the wallboard. */
export async function boardAction(env: Env, request: Request): Promise<Response> {
  let body: BoardActionBody;
  try {
    body = (await request.json()) as BoardActionBody;
  } catch {
    return json({ error: 'Invalid JSON body.' }, 400);
  }

  const denied = await checkKey(env, body.key ?? null);
  if (denied) return denied;

  const id = Number(body.id);
  const action = body.action;
  const userId = body.userId ?? '';
  if (!Number.isFinite(id) || !['claim', 'progress', 'done'].includes(action ?? '')) {
    return json({ error: 'Expected { id, action: claim|progress|done, userId }.' }, 400);
  }

  // Only people the bot has seen in Slack can be attributed.
  const names = await db.getUserNames(env);
  if (!names.has(userId)) {
    return json({ error: 'Unknown user — use the bot in Slack once so it learns who you are.' }, 400);
  }

  const existing = await db.getRequest(env, id);
  if (!existing) return json({ error: `No ticket ${ticketRef(id)}.` }, 404);
  if (existing.status === 'done' || existing.status === 'cancelled') {
    return json({ error: `${ticketRef(id)} is already closed.` }, 409);
  }

  let updated: db.RequestRow | null = null;
  if (action === 'claim') {
    updated = await db.assignRequest(env, id, userId);
  } else if (action === 'progress') {
    updated = await db.setRequestStatus(env, id, 'in_progress');
  } else {
    if (!existing.assigned_to) {
      await db.assignRequest(env, id, userId);
    }
    updated = await db.setRequestStatus(env, id, 'done');
  }
  if (!updated) return json({ error: 'Update failed.' }, 500);

  // Mirror the change onto the ticket's Slack card.
  if (updated.channel_id && updated.message_ts) {
    await slackApi(env, 'chat.update', {
      channel: updated.channel_id,
      ts: updated.message_ts,
      text: `Ticket ${ticketRef(updated.id)}: ${updated.title} (${updated.status})`,
      blocks: requestBlocks(updated, env.TIMEZONE),
    });
  }

  return json({ ok: true, ticket: toBoardTicket(updated, names) });
}
