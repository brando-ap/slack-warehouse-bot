// Slash command handlers. Each runs after the HTTP request has already been
// acked (Slack requires a response within 3 seconds), so replies go through
// response_url or chat.postMessage.

import * as db from './db';
import { parseDueDate, formatDate } from './dates';
import { esc, newRequestModal, openRequestsBlocks, requestBlocks, ticketRef } from './format';
import { respond, slackApi } from './slack';

const REQUEST_USAGE = [
  '*How to use `/request`*',
  '• `/request` — open a form (easiest)',
  '• `/request Pull 3 pallets of SKU-1234` — quick add',
  '• `/request Restock bay 12 due tomorrow` — with a due date (`due today`, `due friday`, `due 7/20`)',
  '• `/request Unload truck 14 #receiving` — tag a category (`#ship`, `#fulfillment`, … — new tags are saved automatically)',
  '• `/request Stage order #99 for:Acme Logistics due 7/20` — tag the customer/company',
  '• `/request Rush order #99 due today !urgent` — priority: `!low` `!high` `!urgent`',
  '_Order matters: title, then `for:company`, then `due`. Change things later with `/edit`._',
].join('\n');

const EDIT_USAGE = [
  '*How to use `/edit`* — change a request after it exists (find ids with `/requests`)',
  '• `/edit 12 due friday` — change the due date (`due none` clears it)',
  '• `/edit 12 !urgent` — change priority (`!low` `!normal` `!high` `!urgent`)',
  '• `/edit 12 #receiving` — change the category (`#none` clears it)',
  '• `/edit 12 for:Acme Logistics` — set the customer/company (`for:none` clears it)',
  '• `/edit 12 assign @dave` — reassign (also `assign me`, `assign none`)',
  '• `/edit 12 title Corrected description here` — rewrite the title',
  '• `/edit 12 cancel` — cancel a request created by mistake',
  'Combine several: `/edit 12 assign me !high due friday for:Acme`',
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
    case '/customer':
      return handleDirectory(env, form, 'contacts');
    case '/company':
      return handleDirectory(env, form, 'companies');
    case '/category':
      return handleDirectory(env, form, 'categories');
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

/** Parse "/request <title> [#category] [for:<company>] [due <date>] [!priority]" quick syntax. */
function parseQuickRequest(
  text: string,
  tz: string
): { title: string; priority: string; due: string | null; company: string | null; category: string | null } {
  let working = text;
  let priority = 'normal';
  const priMatch = working.match(/\s*!(urgent|high|normal|low)\b/i);
  if (priMatch) {
    priority = priMatch[1].toLowerCase();
    working = working.replace(priMatch[0], ' ');
  }

  // #category must start with a letter so ticket-ish text like "Order #4498"
  // never reads as a category.
  let category: string | null = null;
  const catMatch = working.match(/(^|\s)#([a-z][\w-]*)/i);
  if (catMatch) {
    category = catMatch[2].toLowerCase();
    working = working.replace(catMatch[0], ' ');
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

  return { title: working.trim().replace(/\s+/g, ' '), priority, due, company, category };
}

/**
 * Canonicalize a category against the saved list (case-insensitive); unknown
 * tags are added automatically so the vocabulary grows as the team uses it.
 */
async function resolveCategory(env: Env, raw: string | null): Promise<string | null> {
  if (!raw) return null;
  const name = raw.toLowerCase().slice(0, 40);
  const existing = await db.matchCategory(env, name);
  if (existing) return existing;
  await db.addDirectoryEntry(env, 'categories', name);
  return name;
}

async function handleRequest(env: Env, form: Record<string, string>): Promise<void> {
  const text = (form.text ?? '').trim();

  if (text.toLowerCase() === 'help') {
    return respond(form.response_url, { text: REQUEST_USAGE });
  }

  if (!text) {
    const [contacts, companies, categories] = await Promise.all([
      db.listDirectory(env, 'contacts'),
      db.listDirectory(env, 'companies'),
      db.listDirectory(env, 'categories'),
    ]);
    const res = await slackApi(env, 'views.open', {
      trigger_id: form.trigger_id,
      view: newRequestModal(form.channel_id, contacts, companies, categories),
    });
    if (!res.ok) {
      await respond(form.response_url, {
        text: `⚠️ Couldn't open the form (\`${res.error}\`). Try the quick syntax instead:\n${REQUEST_USAGE}`,
      });
    }
    return;
  }

  const { title, priority, due, company, category } = parseQuickRequest(text, env.TIMEZONE);
  if (!title) {
    return respond(form.response_url, { text: REQUEST_USAGE });
  }

  // Snap free-typed company text to the saved directory ("acme" -> "Acme Logistics")
  const canonical = company ? await db.matchCompany(env, company) : null;

  const request = await db.createRequest(env, {
    title,
    priority,
    due_date: due,
    company: canonical ?? company,
    category: await resolveCategory(env, category),
    created_by: form.user_id,
    channel_id: form.channel_id,
  });

  const posted = await postRequestMessage(env, request, form.channel_id);
  if (posted.ok) {
    await respond(form.response_url, {
      text: `✅ Logged ticket *${ticketRef(request.id)}* and posted it to the channel.`,
    });
  } else {
    await respond(form.response_url, {
      text: `✅ Logged ticket *${ticketRef(request.id)} · ${esc(request.title)}* — but ${notPostedHint(posted.error)}`,
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
    const lines = done.map(
      (r) => `✅ ~*${ticketRef(r.id)}*  ${esc(r.title)}~${r.assigned_to ? `  ·  <@${r.assigned_to}>` : ''}`
    );
    return respond(form.response_url, { text: `*Recently completed*\n${lines.join('\n')}` });
  }

  let open = await db.listOpenRequests(env);

  // Any other text filters the list by category, company, contact, or title —
  // e.g. `/requests acme` or `/requests #ship`
  if (text) {
    const needle = text.replace(/^#/, '');
    open = open.filter(
      (r) =>
        r.title.toLowerCase().includes(needle) ||
        (r.company ?? '').toLowerCase().includes(needle) ||
        (r.contact ?? '').toLowerCase().includes(needle) ||
        (r.category ?? '').toLowerCase().includes(needle)
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
  const match = (form.text ?? '').trim().match(/^(?:req-?)?#?(\d+)$/i);
  if (!match) {
    return respond(form.response_url, {
      text: 'Usage: `/done <ticket number>` — e.g. `/done 12` or `/done REQ-0012`. Find tickets with `/requests`.',
    });
  }
  const id = Number(match[1]);
  const existing = await db.getRequest(env, id);
  if (!existing) {
    return respond(form.response_url, { text: `Couldn't find ticket *${ticketRef(id)}*. Check \`/requests\` for open tickets.` });
  }
  if (existing.status === 'done' || existing.status === 'cancelled') {
    return respond(form.response_url, { text: `*${ticketRef(id)}* is already closed (${existing.status}).` });
  }

  if (!existing.assigned_to) {
    await db.assignRequest(env, id, form.user_id);
  }
  const updated = await db.setRequestStatus(env, id, 'done');

  if (updated && updated.channel_id && updated.message_ts) {
    await slackApi(env, 'chat.update', {
      channel: updated.channel_id,
      ts: updated.message_ts,
      text: `Ticket ${ticketRef(updated.id)} completed: ${updated.title}`,
      blocks: requestBlocks(updated, env.TIMEZONE),
    });
  }
  return respond(form.response_url, { text: `✅ Closed *${ticketRef(id)} · ${esc(existing.title)}*. Nice work!` });
}

async function handleEdit(env: Env, form: Record<string, string>): Promise<void> {
  const match = (form.text ?? '').trim().match(/^(?:req-?)?#?(\d+)\s*([\s\S]*)$/i);
  if (!match || !match[2].trim()) {
    return respond(form.response_url, { text: EDIT_USAGE });
  }
  const id = Number(match[1]);
  const existing = await db.getRequest(env, id);
  if (!existing) {
    return respond(form.response_url, { text: `Couldn't find ticket *${ticketRef(id)}*. Check \`/requests\` for tickets.` });
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

    const catMatch = rest.match(/(^|\s)#([a-z][\w-]*)\b/i);
    if (catMatch) {
      rest = rest.replace(catMatch[0], ' ');
      if (/^none$/i.test(catMatch[2])) {
        edits.category = null;
        changes.push('category cleared');
      } else {
        edits.category = await resolveCategory(env, catMatch[2]);
        changes.push(`category → #${edits.category}`);
      }
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
        edits.company = (await db.matchCompany(env, company)) ?? company;
        changes.push(`company → ${esc(edits.company)}`);
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
      text: `Ticket ${ticketRef(updated.id)}: ${updated.title} (${updated.status})`,
      blocks: requestBlocks(updated, env.TIMEZONE),
    });
  }
  return respond(form.response_url, {
    text: `✏️ Updated *${ticketRef(id)} · ${esc(existing.title)}*: ${changes.join(', ')}`,
  });
}

const DIRECTORY_LABELS: Record<db.DirectoryKind, { singular: string; command: string; hint: string }> = {
  contacts: { singular: 'customer', command: '/customer', hint: 'the people who send you requests' },
  companies: { singular: 'company', command: '/company', hint: 'the companies requests are for' },
  categories: { singular: 'category', command: '/category', hint: 'the #categories tickets can be tagged with' },
};

async function handleDirectory(env: Env, form: Record<string, string>, kind: db.DirectoryKind): Promise<void> {
  const { singular, command, hint } = DIRECTORY_LABELS[kind];
  const text = (form.text ?? '').trim();

  const usage = [
    `*How to use \`${command}\`* — manage ${hint} (shown as dropdowns in the \`/request\` form)`,
    `• \`${command} add Jane Doe\` — add to the list`,
    `• \`${command} list\` — see the list`,
    `• \`${command} remove Jane Doe\` (or \`remove 3\`) — take one off`,
    ...(kind === 'contacts'
      ? [
          '• `/customer link Jane Doe | Acme, Globex` — set which companies Jane requests for (her dropdown then shows only those; new company names are added automatically)',
          '• `/customer unlink Jane Doe | Acme` — remove a link',
        ]
      : []),
  ].join('\n');

  const linkMatch = text.match(/^(link|unlink)\s+([^|]+)\|(.+)$/i);
  if (linkMatch && kind === 'contacts') {
    const verb = linkMatch[1].toLowerCase();
    const contactName = linkMatch[2].trim().replace(/\s+/g, ' ');
    const contact = await db.getDirectoryEntryByName(env, 'contacts', contactName);
    if (!contact) {
      return respond(form.response_url, {
        text: `Couldn't find customer *${esc(contactName)}* — add them first with \`/customer add ${esc(contactName)}\`.`,
      });
    }
    const companyNames = linkMatch[3]
      .split(',')
      .map((s) => s.trim().replace(/\s+/g, ' ').slice(0, 70))
      .filter(Boolean);
    if (companyNames.length === 0) {
      return respond(form.response_url, { text: usage });
    }

    const touched: string[] = [];
    for (const name of companyNames) {
      let companyRow = await db.getDirectoryEntryByName(env, 'companies', name);
      if (verb === 'link' && !companyRow) {
        const added = await db.addDirectoryEntry(env, 'companies', name);
        companyRow = added === 'duplicate' ? await db.getDirectoryEntryByName(env, 'companies', name) : added;
      }
      if (!companyRow) continue;
      if (verb === 'link') {
        await db.linkContactCompany(env, contact.id, companyRow.id);
      } else {
        await db.unlinkContactCompany(env, contact.id, companyRow.id);
      }
      touched.push(companyRow.name);
    }

    if (touched.length === 0) {
      return respond(form.response_url, { text: `None of those companies matched — check \`/company list\`.` });
    }
    const linkedNow = await db.companiesForContact(env, contact.name);
    const summary = linkedNow.length
      ? `Their \`/request\` dropdown now shows: ${linkedNow.map((c) => esc(c.name)).join(', ')}.`
      : 'They have no linked companies now, so their dropdown shows the full company list.';
    return respond(form.response_url, {
      text: `${verb === 'link' ? '🔗 Linked' : '✂️ Unlinked'} *${esc(contact.name)}* ${verb === 'link' ? 'to' : 'from'}: ${touched.map(esc).join(', ')}.\n${summary}`,
    });
  }

  const addMatch = text.match(/^add\s+(.+)$/i);
  if (addMatch) {
    // Categories are stored as bare lowercase tags: "#Receiving" -> "receiving"
    const name =
      kind === 'categories'
        ? addMatch[1].trim().replace(/^#/, '').toLowerCase().replace(/[^\w-]/g, '').slice(0, 40)
        : addMatch[1].trim().replace(/\s+/g, ' ').slice(0, 70);
    if (!name) {
      return respond(form.response_url, { text: usage });
    }
    const added = await db.addDirectoryEntry(env, kind, name);
    return respond(form.response_url, {
      text:
        added === 'duplicate'
          ? `*${esc(name)}* is already on the ${singular} list.`
          : `✅ Added *${esc(name)}* to the ${singular} list. It now shows up in the \`/request\` form.`,
    });
  }

  const removeMatch = text.match(/^(?:remove|delete)\s+(.+)$/i);
  if (removeMatch) {
    const target =
      kind === 'categories'
        ? removeMatch[1].trim().replace(/^#/, '').toLowerCase()
        : removeMatch[1].trim();
    const removed = await db.removeDirectoryEntry(env, kind, target);
    return respond(form.response_url, {
      text: removed
        ? `🗑️ Removed *${esc(removed.name)}* from the ${singular} list.`
        : `Couldn't find that on the ${singular} list — check \`${command} list\`.`,
    });
  }

  if (!text || /^list$/i.test(text)) {
    const rows = await db.listDirectory(env, kind);
    if (rows.length === 0) {
      return respond(form.response_url, { text: `The ${singular} list is empty.\n\n${usage}` });
    }
    const lines =
      kind === 'contacts'
        ? await Promise.all(
            rows.map(async (r) => {
              const linked = await db.companiesForContact(env, r.name);
              const suffix = linked.length ? `  —  ${linked.map((c) => esc(c.name)).join(', ')}` : '';
              return `${r.id}. ${esc(r.name)}${suffix}`;
            })
          )
        : rows.map((r) => `${r.id}. ${kind === 'categories' ? '#' : ''}${esc(r.name)}`);
    return respond(form.response_url, {
      text: `*${singular[0].toUpperCase() + singular.slice(1)} list (${rows.length})*\n${lines.join('\n')}`,
    });
  }

  return respond(form.response_url, { text: usage });
}

