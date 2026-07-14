// Block Kit builders — everything the bot renders in Slack lives here.

import type { DirectoryRow, RequestRow, ShipmentRow } from './db';
import { dueLabel, daysUntil, formatDate, todayInTZ } from './dates';

/** Ticket-style reference for a request id: 42 -> "REQ-0042". */
export function ticketRef(id: number): string {
  return `REQ-${String(id).padStart(4, '0')}`;
}

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
    return [mrkdwn(`✅ ~*${ticketRef(req.id)} · ${esc(req.title)}*~\n_Completed${by}_`)];
  }
  if (req.status === 'cancelled') {
    return [mrkdwn(`🚫 ~*${ticketRef(req.id)} · ${esc(req.title)}*~\n_Cancelled_`)];
  }

  const lines = [`${priorityEmoji(req.priority)} *${ticketRef(req.id)} · ${esc(req.title)}*`];
  const customer = [
    req.company ? `🏢 *${esc(req.company)}*` : '',
    req.contact ? `👤 ${esc(req.contact)}` : '',
  ]
    .filter(Boolean)
    .join('  ·  ');
  if (customer) lines.push(customer);
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
  const parts = [`${priorityEmoji(req.priority)} *${ticketRef(req.id)}*  ${esc(req.title)}`];
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
    elements: [{ type: 'mrkdwn', text: 'Mark tickets complete with the ✅ button on each request, or `/done <ticket number>`' }],
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

/** Dropdown options from a directory list (Slack caps a static_select at 100). */
function directoryOptions(rows: DirectoryRow[]): unknown[] {
  return rows.slice(0, 100).map((r) => option(r.name.slice(0, 75), r.name.slice(0, 75)));
}

/**
 * Values already in the form, carried across the views.update that fires when
 * a customer is selected — so picking a customer never wipes what was typed.
 */
export interface RequestModalState {
  title?: string | null;
  details?: string | null;
  due?: string | null;
  priority?: string | null;
  contact?: string | null;
  company?: string | null;
}

const PRIORITY_OPTIONS: Array<[label: string, value: string]> = [
  ['🔵 Low', 'low'],
  ['⚪ Normal', 'normal'],
  ['🟠 High', 'high'],
  ['🔴 Urgent', 'urgent'],
];

/**
 * Modal for creating a request via /request with no arguments.
 * `companies` is either the full list or, when `companiesFiltered` is true,
 * just the ones linked to the selected contact.
 */
export function newRequestModal(
  channelId: string,
  contacts: DirectoryRow[],
  companies: DirectoryRow[],
  state: RequestModalState = {},
  companiesFiltered = false
): unknown {
  const customerBlocks: unknown[] = [];
  if (contacts.length > 0) {
    const selectedContact = state.contact?.slice(0, 75);
    customerBlocks.push({
      type: 'input',
      block_id: 'contact_sel',
      optional: true,
      // Selecting a customer sends a block_actions event so the company
      // dropdown can narrow to that customer's linked companies.
      dispatch_action: true,
      label: pt('Customer (who is asking)'),
      element: {
        type: 'static_select',
        action_id: 'v',
        placeholder: pt('Select a customer — add more with /customer add'),
        options: directoryOptions(contacts),
        ...(selectedContact ? { initial_option: option(selectedContact, selectedContact) } : {}),
      },
    });
  }
  if (companies.length > 0) {
    const selectedCompany = state.company?.slice(0, 75);
    const keepCompany = selectedCompany && companies.some((c) => c.name.slice(0, 75) === selectedCompany);
    const placeholder =
      companiesFiltered && state.contact
        ? `${state.contact.slice(0, 60)}’s companies`
        : 'Select a company — add more with /company add';
    customerBlocks.push({
      type: 'input',
      block_id: 'company_sel',
      optional: true,
      label: pt('Company (who it’s for)'),
      element: {
        type: 'static_select',
        action_id: 'v',
        placeholder: pt(placeholder),
        options: directoryOptions(companies),
        ...(keepCompany ? { initial_option: option(selectedCompany, selectedCompany) } : {}),
      },
    });
  } else {
    // No saved companies yet: fall back to free text.
    customerBlocks.push({
      type: 'input',
      block_id: 'company',
      optional: true,
      label: pt('Customer / company'),
      element: {
        type: 'plain_text_input',
        action_id: 'v',
        max_length: 100,
        placeholder: pt('e.g. Acme Logistics — or save companies with /company add'),
        ...(state.company ? { initial_value: state.company.slice(0, 100) } : {}),
      },
    });
  }

  const priority = PRIORITY_OPTIONS.find(([, v]) => v === state.priority) ?? PRIORITY_OPTIONS[1];

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
          ...(state.title ? { initial_value: state.title.slice(0, 150) } : {}),
        },
      },
      ...customerBlocks,
      {
        type: 'input',
        block_id: 'details',
        optional: true,
        label: pt('Details'),
        element: {
          type: 'plain_text_input',
          action_id: 'v',
          multiline: true,
          max_length: 1000,
          ...(state.details ? { initial_value: state.details.slice(0, 1000) } : {}),
        },
      },
      {
        type: 'input',
        block_id: 'due',
        optional: true,
        label: pt('Due date'),
        element: { type: 'datepicker', action_id: 'v', ...(state.due ? { initial_date: state.due } : {}) },
      },
      {
        type: 'input',
        block_id: 'priority',
        label: pt('Priority'),
        element: {
          type: 'static_select',
          action_id: 'v',
          initial_option: option(priority[0], priority[1]),
          options: PRIORITY_OPTIONS.map(([label, value]) => option(label, value)),
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
