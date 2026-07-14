// App Home tab: a point-and-click admin screen for the customer/company
// directory, published when someone opens the bot's Home tab.

import * as db from './db';
import { todayInTZ } from './dates';
import { esc } from './format';
import { slackApi } from './slack';

function pt(text: string) {
  return { type: 'plain_text' as const, text, emoji: true };
}

function mrkdwn(text: string) {
  return { type: 'section', text: { type: 'mrkdwn', text } };
}

function context(text: string) {
  return { type: 'context', elements: [{ type: 'mrkdwn', text }] };
}

function button(text: string, actionId: string) {
  return { type: 'button', text: pt(text), action_id: actionId };
}

function option(text: string, value: string) {
  return { text: pt(text.slice(0, 75)), value: value.slice(0, 75) };
}

const MAX_CONTACT_ROWS = 60;

/** Build and publish the Home tab for one user. Call after every change so the tab stays fresh. */
export async function publishHome(env: Env, userId: string): Promise<void> {
  const today = todayInTZ(env.TIMEZONE);
  const [contacts, companies, open, shipsToday] = await Promise.all([
    db.listDirectory(env, 'contacts'),
    db.listDirectory(env, 'companies'),
    db.listOpenRequests(env),
    db.listShipments(env, today, today),
  ]);

  const blocks: unknown[] = [
    { type: 'header', text: pt('📦 Fulfillment Assistant') },
    context(
      `📋 *${open.length}* open ticket${open.length === 1 ? '' : 's'}  ·  🚚 *${shipsToday.length}* shipping today  ·  file tickets with \`/request\` in a channel`
    ),
    { type: 'divider' },
    {
      ...mrkdwn(`*Customers (${contacts.length})*`),
      accessory: button('➕ Add customer', 'home_add_contact'),
    },
  ];

  for (const contact of contacts.slice(0, MAX_CONTACT_ROWS)) {
    const linked = await db.companiesForContact(env, contact.name);
    const companiesLine = linked.length
      ? linked.map((c) => esc(c.name)).join(', ')
      : '_no links — sees all companies_';
    blocks.push({
      ...mrkdwn(`*${esc(contact.name)}*\n${companiesLine}`),
      accessory: {
        type: 'overflow',
        action_id: 'home_contact_menu',
        options: [
          option('🔗 Edit companies', `link:${contact.id}`),
          option('🗑 Remove customer', `remove:${contact.id}`),
        ],
      },
    });
  }
  if (contacts.length === 0) {
    blocks.push(mrkdwn('_No customers yet — click ➕ Add customer to start the list._'));
  }
  if (contacts.length > MAX_CONTACT_ROWS) {
    blocks.push(context(`…and ${contacts.length - MAX_CONTACT_ROWS} more — see \`/customer list\``));
  }

  blocks.push({ type: 'divider' });
  blocks.push({
    ...mrkdwn(`*Companies (${companies.length})*`),
    accessory: button('➕ Add company', 'home_add_company'),
  });
  if (companies.length === 0) {
    blocks.push(mrkdwn('_No companies yet — click ➕ Add company, or they get created automatically when you link them to a customer._'));
  } else {
    // Names as running text, chunked to stay under Slack's 3000-char section limit.
    const names = companies.map((c) => esc(c.name));
    let line = '';
    for (const name of names) {
      if (line.length + name.length > 2800) {
        blocks.push(mrkdwn(line));
        line = '';
      }
      line += (line ? '  ·  ' : '') + name;
    }
    if (line) blocks.push(mrkdwn(line));
    blocks.push({
      type: 'actions',
      elements: [button('🗑 Remove a company', 'home_remove_company_pick')],
    });
  }

  blocks.push({ type: 'divider' });
  blocks.push(
    context('Everything here also works as slash commands: `/customer` and `/company` (type either one for help).')
  );

  await slackApi(env, 'views.publish', {
    user_id: userId,
    view: { type: 'home', blocks },
  });
}

/** Modal with a single name field, for adding a customer or company. */
export function addDirectoryModal(kind: db.DirectoryKind): unknown {
  const isContact = kind === 'contacts';
  return {
    type: 'modal',
    callback_id: isContact ? 'add_contact' : 'add_company',
    title: pt(isContact ? 'Add customer' : 'Add company'),
    submit: pt('Add'),
    close: pt('Cancel'),
    blocks: [
      {
        type: 'input',
        block_id: 'name',
        label: pt(isContact ? 'Customer name' : 'Company name'),
        element: {
          type: 'plain_text_input',
          action_id: 'v',
          max_length: 70,
          placeholder: pt(isContact ? 'e.g. John Smith' : 'e.g. Acme Logistics'),
        },
      },
    ],
  };
}

/** Modal to set which companies a customer requests for (multi-select). */
export function linkCompaniesModal(
  contact: db.DirectoryRow,
  companies: db.DirectoryRow[],
  linkedIds: Set<number>
): unknown {
  if (companies.length === 0) {
    return {
      type: 'modal',
      title: pt('Link companies'),
      close: pt('Close'),
      blocks: [mrkdwn(`No companies saved yet — add some first, then link them to *${esc(contact.name)}*.`)],
    };
  }
  const options = companies.slice(0, 100).map((c) => option(c.name, String(c.id)));
  const initial = companies
    .slice(0, 100)
    .filter((c) => linkedIds.has(c.id))
    .map((c) => option(c.name, String(c.id)));
  return {
    type: 'modal',
    callback_id: 'link_contact',
    private_metadata: String(contact.id),
    title: pt('Link companies'),
    submit: pt('Save'),
    close: pt('Cancel'),
    blocks: [
      mrkdwn(`Companies *${esc(contact.name)}* requests for — their \`/request\` dropdown shows only these. Leave empty to show all companies.`),
      {
        type: 'input',
        block_id: 'companies',
        optional: true,
        label: pt('Companies'),
        element: {
          type: 'multi_static_select',
          action_id: 'v',
          placeholder: pt('Select companies'),
          options,
          ...(initial.length > 0 ? { initial_options: initial } : {}),
        },
      },
    ],
  };
}

/** Modal to pick a company to remove. */
export function removeCompanyModal(companies: db.DirectoryRow[]): unknown {
  return {
    type: 'modal',
    callback_id: 'remove_company',
    title: pt('Remove a company'),
    submit: pt('Remove'),
    close: pt('Cancel'),
    blocks: [
      {
        type: 'input',
        block_id: 'company',
        label: pt('Company to remove'),
        element: {
          type: 'static_select',
          action_id: 'v',
          placeholder: pt('Select a company'),
          options: companies.slice(0, 100).map((c) => option(c.name, String(c.id))),
        },
      },
    ],
  };
}
