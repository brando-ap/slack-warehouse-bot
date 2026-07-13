// Slash command handlers. Each runs after the HTTP request has already been
// acked (Slack requires a response within 3 seconds), so replies go through
// response_url or chat.postMessage.

import * as db from './db';
import { addDays, parseDueDate, formatDate, todayInTZ } from './dates';
import {
  esc,
  newRequestModal,
  newShipmentModal,
  openRequestsBlocks,
  requestBlocks,
  shipmentsBlocks,
} from './format';
import { respond, slackApi } from './slack';

const REQUEST_USAGE = [
  '*How to use `/request`*',
  '• `/request` — open a form (easiest)',
  '• `/request Pull 3 pallets of SKU-1234` — quick add',
  '• `/request Restock bay 12 due tomorrow` — with a due date (`due today`, `due friday`, `due 7/20`)',
  '• `/request Stage order #99 for:Acme Logistics due 7/20` — tag the customer/company',
  '• `/request Rush order #99 due today !urgent` — priority: `!low` `!high` `!urgent`',
  '_Order matters: title, then `for:company`, then `due`. Change things later with `/edit`._',
].join('\n');

const EDIT_USAGE = [
  '*How to use `/edit`* — change a request after it exists (find ids with `/requests`)',
  '• `/edit 12 due friday` — change the due date (`due none` clears it)',
  '• `/edit 12 !urgent` — change priority (`!low` `!normal` `!high` `!urgent`)',
  '• `/edit 12 for:Acme Logistics` — set the customer/company (`for:none` clears it)',
  '• `/edit 12 assign @dave` — reassign (also `assign me`, `assign none`)',
  '• `/edit 12 title Corrected description here` — rewrite the title',
  '• `/edit 12 cancel` — cancel a request created by mistake',
  'Combine several: `/edit 12 assign me !high due friday for:Acme`',
].join('\n');

const SHIP_USAGE = [
  '*How to use `/ship`*',
  '• `/ship` — open a form (easiest)',
  '• `/ship 7/20 Order #4512 — 6 pallets to Dallas` — quick add',
  '• `/ship remove 3` — take shipment #3 off the calendar',
  '• `/shipping` — see the calendar (or `/shipping 60` for 60 days out)',
].join('\n');

export async function handleSlashCommand(env: Env, form: Record<string, string>): Promise<void> {
  // Learn the invoker's display name so the wallboard can show names, not ids.
  if (form.user_id && form.user_name) {
    await db.upsertUser(env, form.user_id, form.user_name);
  }
  switch (form.command) {
    case '/request':
      return handleRequest(env, form);
    case '/requests':
      return handleRequestList(env, form);
    case '/done':
      return handleDone(env, form);
    case '/edit':
      return handleEdit(env, form);
    case '/ship':
      return handleShip(env, form);
    case '/shipping':
      return handleShipping(env, form);
    default:
      return respond(form.response_url, { text: `Unknown command: ${form.command}` });
  }
}

/** Post a request card (with buttons) to the team channel and remember where it landed. */
export async function postRequestMessage(
  env: Env,
  request: db.RequestRow,
  channelId: string
): Promise<{ ok: boolean; error?: string }> {
  const res = await slackApi(env, 'chat.postMessage', {
    channel: channelId,
    text: `New request #${request.id}: ${request.title}`,
    blocks: requestBlocks(request, env.TIMEZONE),
    unfurl_links: false,
  });
  if (res.ok && res.ts && typeof res.channel === 'string') {
    await db.setRequestMessage(env, request.id, res.channel, res.ts);
  }
  return { ok: res.ok, error: res.error };
}

function notPostedHint(error?: string): string {
  return error === 'not_in_channel' || error === 'channel_not_found'
    ? "I couldn't post in this channel — if it's private, run `/invite @Fulfillment Assistant` here and try again."
    : `I couldn't post the message (Slack said: \`${error ?? 'unknown'}\`).`;
}

/** Parse "/request <title> [for:<company>] [due <date>] [!priority]" quick syntax. */
function parseQuickRequest(
  text: string,
  tz: string
): { title: string; priority: string; due: string | null; company: string | null } {
  let working = text;
  let priority = 'normal';
  const priMatch = working.match(/\s*!(urgent|high|normal|low)\b/i);
  if (priMatch) {
    priority = priMatch[1].toLowerCase();
    working = working.replace(priMatch[0], ' ');
  }

  // "due" and "for:" both anchor to the end of the text, so try due, then
  // for:, then due again — this accepts either order of the two.
  let due: string | null = null;
  const tryDue = () => {
    if (due) return;
    const dueMatch = working.match(/\s+due[:\s]+(.+)$/i);
    if (!dueMatch) return;
    const parsed = parseDueDate(dueMatch[1], tz);
    if (parsed) {
      due = parsed;
      working = working.slice(0, dueMatch.index);
    }
  };
  tryDue();
  let company: string | null = null;
  const forMatch = working.match(/\s+for:\s*(.+)$/i);
  if (forMatch) {
    company = forMatch[1].trim();
    working = working.slice(0, forMatch.index);
  }
  tryDue();

  return { title: working.trim().replace(/\s+/g, ' '), priority, due, company };
}

async function handleRequest(env: Env, form: Record<string, string>): Promise<void> {
  const text = (form.text ?? '').trim();

  if (text.toLowerCase() === 'help') {
    return respond(form.response_url, { text: REQUEST_USAGE });
  }

  if (!text) {
    const res = await slackApi(env, 'views.open', {
      trigger_id: form.trigger_id,
      view: newRequestModal(form.channel_id),
    });
    if (!res.ok) {
      await respond(form.response_url, {
        text: `⚠️ Couldn't open the form (\`${res.error}\`). Try the quick syntax instead:\n${REQUEST_USAGE}`,
      });
    }
    return;
  }

  const { title, priority, due, company } = parseQuickRequest(text, env.TIMEZONE);
  if (!title) {
    return respond(form.response_url, { text: REQUEST_USAGE });
  }

  const request = await db.createRequest(env, {
    title,
    priority,
    due_date: due,
    company,
    created_by: form.user_id,
    channel_id: form.channel_id,
  });

  const posted = await postRequestMessage(env, request, form.channel_id);
  if (posted.ok) {
    await respond(form.response_url, {
      text: `✅ Logged *#${request.id}* and posted it to the channel.`,
    });
  } else {
    await respond(form.response_url, {
      text: `✅ Logged *#${request.id} · ${esc(request.title)}* — but ${notPostedHint(posted.error)}`,
    });
  }
}

async function handleRequestList(env: Env, form: Record<string, string>): Promise<void> {
  const text = (form.text ?? '').trim().toLowerCase();

  if (text === 'done' || text === 'completed') {
    const done = await db.listRecentDone(env);
    if (done.length === 0) {
      return respond(form.response_url, { text: 'No completed requests yet.' });
    }
    const lines = done.map((r) => `✅ ~*#${r.id}*  ${esc(r.title)}~${r.assigned_to ? `  ·  <@${r.assigned_to}>` : ''}`);
    return respond(form.response_url, { text: `*Recently completed*\n${lines.join('\n')}` });
  }

  let open = await db.listOpenRequests(env);

  // Any other text filters the list by company or title, e.g. `/requests acme`
  if (text) {
    open = open.filter(
      (r) => r.title.toLowerCase().includes(text) || (r.company ?? '').toLowerCase().includes(text)
    );
    if (open.length === 0) {
      return respond(form.response_url, {
        text: `No open requests matching *${esc(text)}*. Try \`/requests\` for the full list.`,
      });
    }
  }

  return respond(form.response_url, {
    text: `${open.length} open requests`,
    blocks: openRequestsBlocks(open, env.TIMEZONE),
  });
}

async function handleDone(env: Env, form: Record<string, string>): Promise<void> {
  const match = (form.text ?? '').trim().match(/^#?(\d+)$/);
  if (!match) {
    return respond(form.response_url, { text: 'Usage: `/done <request id>` — e.g. `/done 12`. Find ids with `/requests`.' });
  }
  const id = Number(match[1]);
  const existing = await db.getRequest(env, id);
  if (!existing) {
    return respond(form.response_url, { text: `Couldn't find request *#${id}*. Check \`/requests\` for open ids.` });
  }
  if (existing.status === 'done' || existing.status === 'cancelled') {
    return respond(form.response_url, { text: `*#${id}* is already closed (${existing.status}).` });
  }

  if (!existing.assigned_to) {
    await db.assignRequest(env, id, form.user_id);
  }
  const updated = await db.setRequestStatus(env, id, 'done');

  if (updated && updated.channel_id && updated.message_ts) {
    await slackApi(env, 'chat.update', {
      channel: updated.channel_id,
      ts: updated.message_ts,
      text: `Request #${updated.id} completed: ${updated.title}`,
      blocks: requestBlocks(updated, env.TIMEZONE),
    });
  }
  return respond(form.response_url, { text: `✅ Marked *#${id} · ${esc(existing.title)}* as done. Nice work!` });
}

async function handleEdit(env: Env, form: Record<string, string>): Promise<void> {
  const match = (form.text ?? '').trim().match(/^#?(\d+)\s*([\s\S]*)$/);
  if (!match || !match[2].trim()) {
    return respond(form.response_url, { text: EDIT_USAGE });
  }
  const id = Number(match[1]);
  const existing = await db.getRequest(env, id);
  if (!existing) {
    return respond(form.response_url, { text: `Couldn't find request *#${id}*. Check \`/requests\` for ids.` });
  }

  let rest = match[2].trim();
  const edits: db.RequestEdits = {};
  const changes: string[] = [];

  if (/^cancel$/i.test(rest)) {
    edits.status = 'cancelled';
    changes.push('cancelled');
    rest = '';
  } else if (/^title\s+/i.test(rest)) {
    edits.title = rest.replace(/^title\s+/i, '').trim();
    changes.push(`title → "${esc(edits.title)}"`);
    rest = '';
  } else {
    const priMatch = rest.match(/\s*!(urgent|high|normal|low)\b/i);
    if (priMatch) {
      edits.priority = priMatch[1].toLowerCase();
      changes.push(`priority → ${edits.priority}`);
      rest = rest.replace(priMatch[0], ' ');
    }

    const assignMatch = rest.match(/\bassign\s+(<@(\w+)(?:\|[^>]*)?>|me|none)/i);
    if (assignMatch) {
      rest = rest.replace(assignMatch[0], ' ');
      if (/^me$/i.test(assignMatch[1])) {
        edits.assigned_to = form.user_id;
        changes.push(`assigned → <@${form.user_id}>`);
      } else if (/^none$/i.test(assignMatch[1])) {
        edits.assigned_to = null;
        changes.push('unassigned');
      } else {
        edits.assigned_to = assignMatch[2];
        changes.push(`assigned → <@${assignMatch[2]}>`);
      }
    }

    // "due" and "for:" both anchor to the end; try due, then for:, then due
    // again so either order works (same trick as /request quick syntax).
    const tryDue = () => {
      if (edits.due_date !== undefined) return;
      const dueMatch = rest.match(/\s*\bdue[:\s]+(.+)$/i);
      if (!dueMatch) return;
      if (/^none$/i.test(dueMatch[1].trim())) {
        edits.due_date = null;
        changes.push('due date cleared');
        rest = rest.slice(0, dueMatch.index);
        return;
      }
      const parsed = parseDueDate(dueMatch[1], env.TIMEZONE);
      if (parsed) {
        edits.due_date = parsed;
        changes.push(`due → ${formatDate(parsed)}`);
        rest = rest.slice(0, dueMatch.index);
      }
    };
    tryDue();
    const forMatch = rest.match(/\s*\bfor:\s*(.+)$/i);
    if (forMatch) {
      rest = rest.slice(0, forMatch.index);
      const company = forMatch[1].trim();
      if (/^none$/i.test(company)) {
        edits.company = null;
        changes.push('company cleared');
      } else {
        edits.company = company;
        changes.push(`company → ${esc(company)}`);
      }
    }
    tryDue();
  }

  if (changes.length === 0 || rest.trim() !== '') {
    return respond(form.response_url, {
      text: `I didn't understand ${rest.trim() ? `\`${esc(rest.trim())}\`` : 'that'}.\n\n${EDIT_USAGE}`,
    });
  }

  const updated = await db.updateRequest(env, id, edits);
  if (updated && updated.channel_id && updated.message_ts) {
    await slackApi(env, 'chat.update', {
      channel: updated.channel_id,
      ts: updated.message_ts,
      text: `Request #${updated.id}: ${updated.title} (${updated.status})`,
      blocks: requestBlocks(updated, env.TIMEZONE),
    });
  }
  return respond(form.response_url, {
    text: `✏️ Updated *#${id} · ${esc(existing.title)}*: ${changes.join(', ')}`,
  });
}

async function handleShip(env: Env, form: Record<string, string>): Promise<void> {
  const text = (form.text ?? '').trim();

  if (text.toLowerCase() === 'help') {
    return respond(form.response_url, { text: SHIP_USAGE });
  }

  if (!text) {
    const res = await slackApi(env, 'views.open', {
      trigger_id: form.trigger_id,
      view: newShipmentModal(form.channel_id),
    });
    if (!res.ok) {
      await respond(form.response_url, {
        text: `⚠️ Couldn't open the form (\`${res.error}\`). Try the quick syntax instead:\n${SHIP_USAGE}`,
      });
    }
    return;
  }

  const removeMatch = text.match(/^(?:remove|cancel|delete)\s+#?(\d+)$/i);
  if (removeMatch) {
    const id = Number(removeMatch[1]);
    const shipment = await db.cancelShipment(env, id);
    return respond(form.response_url, {
      text: shipment
        ? `🗑️ Removed shipment *#${id} · ${esc(shipment.description)}* from the calendar.`
        : `Couldn't find shipment *#${id}*.`,
    });
  }

  const spaceIdx = text.indexOf(' ');
  const dateToken = spaceIdx === -1 ? text : text.slice(0, spaceIdx);
  const description = spaceIdx === -1 ? '' : text.slice(spaceIdx + 1).trim();
  const shipDate = parseDueDate(dateToken, env.TIMEZONE);

  if (!shipDate || !description) {
    return respond(form.response_url, { text: SHIP_USAGE });
  }

  const shipment = await db.createShipment(env, shipDate, description, null, form.user_id);
  const res = await slackApi(env, 'chat.postMessage', {
    channel: form.channel_id,
    text: `🚚 Shipment scheduled — #${shipment.id}: ${shipment.description} on ${formatDate(shipDate)}`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `🚚 *Shipment scheduled* — *#${shipment.id}*  ${esc(shipment.description)}\n📅 Ships *${formatDate(shipDate)}* (added by <@${form.user_id}>)`,
        },
      },
    ],
  });
  if (res.ok) {
    await respond(form.response_url, { text: `✅ Added to the shipping calendar for *${formatDate(shipDate)}*.` });
  } else {
    await respond(form.response_url, {
      text: `✅ Shipment *#${shipment.id}* saved for *${formatDate(shipDate)}* — but ${notPostedHint(res.error)}`,
    });
  }
}

async function handleShipping(env: Env, form: Record<string, string>): Promise<void> {
  const requested = Number((form.text ?? '').trim());
  const days = Number.isFinite(requested) && requested > 0 ? Math.min(Math.floor(requested), 365) : 30;
  const today = todayInTZ(env.TIMEZONE);
  const shipments = await db.listShipments(env, today, addDays(today, days));
  return respond(form.response_url, {
    text: `${shipments.length} shipments in the next ${days} days`,
    blocks: shipmentsBlocks(shipments, days, env.TIMEZONE),
  });
}
