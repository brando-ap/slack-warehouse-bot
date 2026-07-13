// Warehouse wallboard: a read-only, auto-refreshing page served at /board,
// meant for a TV in the warehouse. Dark theme, large type, no interaction.
// Access requires ?key=<BOARD_KEY> so the URL isn't guessable.

import { getUserNames, listOpenRequests, listShipments, type RequestRow, type ShipmentRow } from './db';
import { addDays, daysUntil, formatDate, todayInTZ } from './dates';

function escHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function keyMatches(provided: string, expected: string): Promise<boolean> {
  const digest = (s: string) => crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  const [a, b] = await Promise.all([digest(provided), digest(expected)]);
  return crypto.subtle.timingSafeEqual(a, b);
}

const PRIORITY_LABEL: Record<string, string> = {
  urgent: '<span class="tag critical">▲ URGENT</span>',
  high: '<span class="tag serious">▲ HIGH</span>',
};

export async function renderBoard(env: Env, url: URL): Promise<Response> {
  if (!env.BOARD_KEY) {
    return new Response('Wallboard is disabled. Set BOARD_KEY in wrangler.jsonc and redeploy.', {
      status: 404,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }
  const provided = url.searchParams.get('key') ?? '';
  if (!(await keyMatches(provided, env.BOARD_KEY))) {
    return new Response('Missing or wrong key. Open the board as /board?key=YOUR-BOARD-KEY', {
      status: 403,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }

  const tz = env.TIMEZONE;
  const today = todayInTZ(tz);
  const [open, shipments, names] = await Promise.all([
    listOpenRequests(env),
    listShipments(env, today, addDays(today, 14)),
    getUserNames(env),
  ]);

  const overdue = open.filter((r) => r.due_date && r.due_date < today);
  const dueToday = open.filter((r) => r.due_date === today);
  const later = open.filter((r) => !r.due_date || r.due_date > today);
  const shipsToday = shipments.filter((s) => s.ship_date === today);

  const who = (id: string | null) => (id ? escHtml(names.get(id) ?? id) : null);

  const requestRow = (r: RequestRow): string => {
    const status =
      r.due_date && r.due_date < today
        ? `<span class="tag critical">⚠ OVERDUE ${-daysUntil(r.due_date, tz)}d</span>`
        : r.due_date === today
          ? '<span class="tag warning">● DUE TODAY</span>'
          : r.due_date
            ? `<span class="meta">due ${escHtml(formatDate(r.due_date))}</span>`
            : '<span class="meta">no due date</span>';
    const assignee = who(r.assigned_to);
    return `<li>
      <div class="row-main">
        <span class="rid">#${r.id}</span>
        <span class="rtitle">${escHtml(r.title)}</span>
        ${PRIORITY_LABEL[r.priority] ?? ''}
      </div>
      <div class="row-sub">
        ${r.company ? `<span class="company">${escHtml(r.company)}</span>` : ''}
        ${status}
        ${assignee ? `<span class="meta">👤 ${assignee}${r.status === 'in_progress' ? ' (working)' : ''}</span>` : '<span class="meta">unclaimed</span>'}
      </div>
    </li>`;
  };

  const section = (title: string, rows: RequestRow[]): string =>
    rows.length === 0 ? '' : `<h2>${title} <span class="count">${rows.length}</span></h2><ul>${rows.map(requestRow).join('')}</ul>`;

  let shippingHtml = '';
  let currentDate = '';
  for (const s of shipments) {
    if (s.ship_date !== currentDate) {
      if (currentDate) shippingHtml += '</ul>';
      currentDate = s.ship_date;
      const badge = s.ship_date === today ? ' <span class="tag warning">● TODAY</span>' : '';
      shippingHtml += `<h2>${escHtml(formatDate(s.ship_date))}${badge}</h2><ul>`;
    }
    shippingHtml += `<li>
      <div class="row-main"><span class="rid">#${s.id}</span><span class="rtitle">${escHtml(s.description)}</span></div>
      ${s.notes ? `<div class="row-sub"><span class="meta">${escHtml(s.notes)}</span></div>` : ''}
    </li>`;
  }
  if (currentDate) shippingHtml += '</ul>';
  if (!shippingHtml) shippingHtml = '<p class="empty">Nothing scheduled in the next 14 days.</p>';

  const updatedAt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date());

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="60">
<title>Fulfillment Board</title>
<style>
  :root {
    --page: #0d0d0d; --surface: #1a1a19;
    --ink: #ffffff; --ink-2: #c3c2b7; --muted: #898781;
    --border: rgba(255,255,255,0.10);
    --good: #0ca30c; --warning: #fab219; --serious: #ec835a; --critical: #d03b3b;
  }
  * { box-sizing: border-box; margin: 0; }
  body {
    background: var(--page); color: var(--ink);
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    padding: 2rem; min-height: 100vh;
  }
  header { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 1.5rem; }
  header h1 { font-size: 1.6rem; font-weight: 650; }
  header .stamp { color: var(--muted); font-size: 1rem; }
  .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 1rem; margin-bottom: 1.5rem; }
  .stat { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 1rem 1.25rem; }
  .stat .val { font-size: 3rem; font-weight: 700; line-height: 1.1; }
  .stat .lbl { color: var(--ink-2); font-size: 1rem; margin-top: .25rem; }
  .stat.alert .lbl::before { content: "⚠ "; color: var(--critical); }
  .cols { display: grid; grid-template-columns: 3fr 2fr; gap: 1.5rem; align-items: start; }
  .panel { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 1.25rem 1.5rem; }
  .panel > .panel-title { font-size: 1.15rem; font-weight: 650; color: var(--ink-2); text-transform: uppercase; letter-spacing: .06em; padding-bottom: .75rem; border-bottom: 1px solid var(--border); }
  h2 { font-size: 1.1rem; font-weight: 650; color: var(--ink-2); margin: 1.1rem 0 .4rem; }
  h2 .count { color: var(--muted); font-weight: 500; }
  ul { list-style: none; }
  li { padding: .55rem 0; border-bottom: 1px solid var(--border); }
  li:last-child { border-bottom: none; }
  .row-main { display: flex; gap: .6rem; align-items: baseline; flex-wrap: wrap; }
  .rid { color: var(--muted); font-variant-numeric: tabular-nums; min-width: 2.6rem; }
  .rtitle { font-size: 1.35rem; font-weight: 550; }
  .row-sub { display: flex; gap: 1rem; margin-top: .2rem; padding-left: 3.2rem; flex-wrap: wrap; font-size: 1.05rem; }
  .company { color: var(--ink-2); font-weight: 600; }
  .meta { color: var(--muted); }
  .tag { font-weight: 700; font-size: .95rem; letter-spacing: .03em; }
  .tag.critical { color: var(--critical); }
  .tag.warning { color: var(--warning); }
  .tag.serious { color: var(--serious); }
  .empty { color: var(--muted); padding: 1rem 0; font-size: 1.15rem; }
  .allclear { color: var(--good); font-size: 1.3rem; padding: 1.5rem 0; }
  @media (max-width: 900px) { .cols, .stats { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<header>
  <h1>📦 Fulfillment Board</h1>
  <span class="stamp">${escHtml(formatDate(today))} · updated ${escHtml(updatedAt)} · refreshes every minute</span>
</header>
<div class="stats">
  <div class="stat"><div class="val">${open.length}</div><div class="lbl">Open requests</div></div>
  <div class="stat${overdue.length ? ' alert' : ''}"><div class="val">${overdue.length}</div><div class="lbl">Overdue</div></div>
  <div class="stat"><div class="val">${dueToday.length}</div><div class="lbl">Due today</div></div>
  <div class="stat"><div class="val">${shipsToday.length}</div><div class="lbl">Shipping today</div></div>
</div>
<div class="cols">
  <div class="panel">
    <div class="panel-title">Requests</div>
    ${
      open.length === 0
        ? '<p class="allclear">✔ All clear — no open requests.</p>'
        : section('⚠ Overdue', overdue) + section('Due today', dueToday) + section('Up next', later)
    }
  </div>
  <div class="panel">
    <div class="panel-title">Shipping — next 14 days</div>
    ${shippingHtml}
  </div>
</div>
</body>
</html>`;

  return new Response(html, {
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}
