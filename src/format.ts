// Block Kit builders — everything the bot renders in Slack lives here.

import type { RequestRow, ShipmentRow } from './db';
import { dueLabel, daysUntil, formatDate, todayInTZ } from './dates';

/** Escape text for Slack mrkdwn. */
export function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const PRIORITY_EMOJI: Record<string, string> = {
  urgent: '🔴',
  high: '🟠',
  normal: '⚪',
  low: '🔵',
};

export function priorityEmoji(priority: string): string {
  return PRIORITY_EMOJI[priority] ?? '⚪';
}

function pt(text: string) {
  return { type: 'plain_text' as const, text, emoji: true };
}

function mrkdwn(text: string) {
  return { type: 'section', text: { type: 'mrkdwn', text } };
}

function option(text: string, value: string) {
  return { text: pt(text), value };
}

function button(text: string, actionId: string, id: number, style?: 'primary' | 'danger') {
  return {
    type: 'button',
    text: pt(text),
    action_id: actionId,
    value: String(id),
    ...(style ? { style } : {}),
  };
}

/** The message posted to the team channel for a request (with action buttons). */
export function requestBlocks(req: RequestRow, tz: string): unknown[] {
  if (req.status === 'done') {
    const by = req.assigned_to ? ` by <@${req.assigned_to}>` : '';
    return [mrkdwn(`✅ ~*#${req.id} · ${esc(req.title)}*~\n_Completed${by}_`)];
  }
  if (req.status === 'cancelled') {
    return [mrkdwn(`🚫 ~*#${req.id} · ${esc(req.title)}*~\n_Cancelled_`)];
  }

  const lines = [`${priorityEmoji(req.priority)} *#${req.id} · ${esc(req.title)}*`];
  if (req.company) lines.push(`🏢 For *${esc(req.company)}*`);
  if (req.details) lines.push(esc(req.details));
  if (req.due_date) lines.push(`📅 Due *${dueLabel(req.due_date, tz)}*`);

  const status = req.status === 'in_progress' ? '🔄 In progress' : '📥 Open';
  const who = req.assigned_to ? `Assigned to <@${req.assigned_to}>` : 'Unassigned';

  return [
    mrkdwn(lines.join('\n')),
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `${status}  •  ${who}  •  Requested by <@${req.created_by}>` }],
    },
    {
      type: 'actions',
      elements: [
        button('🙋 Claim', 'req_claim', req.id),
        button('🔄 In progress', 'req_progress', req.id),
        button('✅ Done', 'req_done', req.id, 'primary'),
      ],
    },
  ];
}

/** One-line summary of a request for lists and digests. */
export function requestLine(req: RequestRow, tz: string): string {
  const parts = [`${priorityEmoji(req.priority)} *#${req.id}*  ${esc(req.title)}`];
  if (req.company) parts.push(`🏢 ${esc(req.company)}`);
  if (req.due_date) parts.push(`due ${dueLabel(req.due_date, tz)}`);
  if (req.assigned_to) parts.push(`<@${req.assigned_to}>`);
  if (req.status === 'in_progress') parts.push('🔄');
  return parts.join('  ·  ');
}

/** Split long line lists across section blocks (Slack caps text at 3000 chars). */
function lineSections(lines: string[], chunkSize = 12): unknown[] {
  const sections: unknown[] = [];
  for (let i = 0; i < lines.length; i += chunkSize) {
    sections.push(mrkdwn(lines.slice(i, i + chunkSize).join('\n')));
  }
  return sections;
}

/** The /requests list, grouped by urgency. */
export function openRequestsBlocks(requests: RequestRow[], tz: string): unknown[] {
  if (requests.length === 0) {
    return [mrkdwn('✨ *No open requests.* Use `/request` to add one.')];
  }

  const today = todayInTZ(tz);
  const overdue = requests.filter((r) => r.due_date && r.due_date < today);
  const dueToday = requests.filter((r) => r.due_date === today);
  const upcoming = requests.filter((r) => r.due_date && r.due_date > today);
  const noDate = requests.filter((r) => !r.due_date);

  const blocks: unknown[] = [mrkdwn(`*📋 Open requests (${requests.length})*`)];
  const group = (label: string, rows: RequestRow[]) => {
    if (rows.length === 0) return;
    blocks.push(mrkdwn(`*${label}*`));
    blocks.push(...lineSections(rows.map((r) => requestLine(r, tz))));
  };
  group('🚨 Overdue', overdue);
  group('⏰ Due today', dueToday);
  group('📆 Upcoming', upcoming);
  group('🗒️ No due date', noDate);

  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: 'Mark items complete with the ✅ button on each request, or `/done <id>`' }],
  });
  return blocks;
}

/** The /shipping calendar view, grouped by date. */
export function shipmentsBlocks(shipments: ShipmentRow[], days: number, tz: string): unknown[] {
  if (shipments.length === 0) {
    return [mrkdwn(`🚚 *Nothing scheduled to ship in the next ${days} days.* Use \`/ship\` to add something.`)];
  }

  const today = todayInTZ(tz);
  const blocks: unknown[] = [mrkdwn(`*🚚 Shipping calendar — next ${days} days*`)];
  let currentDate = '';
  let lines: string[] = [];
  const flush = () => {
    if (lines.length > 0) blocks.push(...lineSections(lines));
    lines = [];
  };
  for (const s of shipments) {
    if (s.ship_date !== currentDate) {
      flush();
      currentDate = s.ship_date;
      const suffix = s.ship_date === today ? '  ⬅️ today' : '';
      blocks.push(mrkdwn(`*${formatDate(s.ship_date)}*${suffix}`));
    }
    lines.push(`  •  *#${s.id}*  ${esc(s.description)}${s.notes ? ` — _${esc(s.notes)}_` : ''}`);
  }
  flush();
  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: 'Add with `/ship <date> <description>` · remove with `/ship remove <id>`' }],
  });
  return blocks;
}

/** The scheduled morning digest. */
export function digestBlocks(
  open: RequestRow[],
  shipments: ShipmentRow[],
  tz: string
): { text: string; blocks: unknown[] } {
  const today = todayInTZ(tz);
  const overdue = open.filter((r) => r.due_date && r.due_date < today);
  const dueToday = open.filter((r) => r.due_date === today);
  const rest = open.filter((r) => !r.due_date || r.due_date > today);
  const shipsToday = shipments.filter((s) => s.ship_date === today);
  const shipsSoon = shipments.filter((s) => s.ship_date > today);

  const blocks: unknown[] = [
    { type: 'header', text: pt(`☀️ Fulfillment digest — ${formatDate(today)}`) },
  ];

  if (open.length === 0 && shipments.length === 0) {
    blocks.push(mrkdwn('✨ No open requests and nothing shipping this week. Enjoy the quiet!'));
    return { text: 'Fulfillment digest: all clear', blocks };
  }

  const limited = (rows: RequestRow[], max = 10): string[] => {
    const lines = rows.slice(0, max).map((r) => requestLine(r, tz));
    if (rows.length > max) lines.push(`_…and ${rows.length - max} more — see \`/requests\`_`);
    return lines;
  };

  if (overdue.length > 0) {
    blocks.push(mrkdwn(`*🚨 Overdue (${overdue.length})*\n${limited(overdue).join('\n')}`));
  }
  if (dueToday.length > 0) {
    blocks.push(mrkdwn(`*⏰ Due today (${dueToday.length})*\n${limited(dueToday).join('\n')}`));
  }
  if (rest.length > 0) {
    blocks.push(mrkdwn(`*📋 Also open (${rest.length})*\n${limited(rest, 8).join('\n')}`));
  }

  if (shipsToday.length > 0 || shipsSoon.length > 0) {
    blocks.push({ type: 'divider' });
    if (shipsToday.length > 0) {
      const lines = shipsToday.map((s) => `  •  *#${s.id}*  ${esc(s.description)}`);
      blocks.push(mrkdwn(`*🚚 Shipping TODAY (${shipsToday.length})*\n${lines.join('\n')}`));
    }
    if (shipsSoon.length > 0) {
      const lines = shipsSoon.map(
        (s) => `  •  *${formatDate(s.ship_date)}* — ${esc(s.description)} (${daysUntil(s.ship_date, tz)}d)`
      );
      blocks.push(mrkdwn(`*📦 Shipping in the next 7 days*\n${lines.join('\n')}`));
    }
  }

  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: '`/request` new · `/requests` list · `/ship` schedule · `/shipping` calendar' }],
  });

  const summary = `Fulfillment digest: ${open.length} open request${open.length === 1 ? '' : 's'}${
    overdue.length ? `, ${overdue.length} overdue` : ''
  }${shipsToday.length ? `, ${shipsToday.length} shipping today` : ''}`;
  return { text: summary, blocks };
}

/** Modal for creating a request via /request with no arguments. */
export function newRequestModal(channelId: string): unknown {
  return {
    type: 'modal',
    callback_id: 'new_request',
    private_metadata: channelId,
    title: pt('New request'),
    submit: pt('Create'),
    close: pt('Cancel'),
    blocks: [
      {
        type: 'input',
        block_id: 'title',
        label: pt('What do you need?'),
        element: {
          type: 'plain_text_input',
          action_id: 'v',
          max_length: 150,
          placeholder: pt('e.g. Pull 3 pallets of SKU-1234 for Order #567'),
        },
      },
      {
        type: 'input',
        block_id: 'company',
        optional: true,
        label: pt('Customer / company'),
        element: {
          type: 'plain_text_input',
          action_id: 'v',
          max_length: 100,
          placeholder: pt('e.g. Acme Logistics — John'),
        },
      },
      {
        type: 'input',
        block_id: 'details',
        optional: true,
        label: pt('Details'),
        element: { type: 'plain_text_input', action_id: 'v', multiline: true, max_length: 1000 },
      },
      {
        type: 'input',
        block_id: 'due',
        optional: true,
        label: pt('Due date'),
        element: { type: 'datepicker', action_id: 'v' },
      },
      {
        type: 'input',
        block_id: 'priority',
        label: pt('Priority'),
        element: {
          type: 'static_select',
          action_id: 'v',
          initial_option: option('⚪ Normal', 'normal'),
          options: [
            option('🔵 Low', 'low'),
            option('⚪ Normal', 'normal'),
            option('🟠 High', 'high'),
            option('🔴 Urgent', 'urgent'),
          ],
        },
      },
    ],
  };
}

/** Modal for scheduling a shipment via /ship with no arguments. */
export function newShipmentModal(channelId: string): unknown {
  return {
    type: 'modal',
    callback_id: 'new_shipment',
    private_metadata: channelId,
    title: pt('Schedule a shipment'),
    submit: pt('Schedule'),
    close: pt('Cancel'),
    blocks: [
      {
        type: 'input',
        block_id: 'description',
        label: pt('What is shipping?'),
        element: {
          type: 'plain_text_input',
          action_id: 'v',
          max_length: 150,
          placeholder: pt('e.g. Order #4512 — 6 pallets to Dallas DC'),
        },
      },
      {
        type: 'input',
        block_id: 'ship_date',
        label: pt('Ship date'),
        element: { type: 'datepicker', action_id: 'v' },
      },
      {
        type: 'input',
        block_id: 'notes',
        optional: true,
        label: pt('Notes'),
        element: { type: 'plain_text_input', action_id: 'v', multiline: true, max_length: 1000 },
      },
    ],
  };
}
