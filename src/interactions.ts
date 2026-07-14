// Handlers for interactive payloads: button clicks on request cards and
// modal (form) submissions.

import * as db from './db';
import { postRequestMessage } from './commands';
import { esc, newRequestModal, requestBlocks, ticketRef } from './format';
import { addDirectoryModal, linkCompaniesModal, publishHome, removeCompanyModal } from './home';
import { dmUser, slackApi } from './slack';
import { formatDate } from './dates';

interface BlockAction {
  action_id: string;
  block_id?: string;
  value?: string;
  selected_option?: { value: string } | null;
}

interface InteractionPayload {
  type: string;
  user: { id: string; username?: string; name?: string };
  channel?: { id: string };
  message?: { ts: string };
  trigger_id?: string;
  actions?: BlockAction[];
  view?: {
    id?: string;
    callback_id: string;
    private_metadata: string;
    state: { values: Record<string, Record<string, ViewValue>> };
  };
}

interface ViewValue {
  value?: string;
  selected_date?: string;
  selected_option?: { value: string };
  selected_options?: Array<{ value: string }>;
}

export async function handleInteraction(env: Env, payload: InteractionPayload): Promise<void> {
  // Learn display names as people click buttons, for the wallboard.
  const name = payload.user?.username ?? payload.user?.name;
  if (payload.user?.id && name) {
    await db.upsertUser(env, payload.user.id, name);
  }
  if (payload.type === 'block_actions') return handleBlockAction(env, payload);
  if (payload.type === 'view_submission') return handleViewSubmission(env, payload);
}

async function handleBlockAction(env: Env, payload: InteractionPayload): Promise<void> {
  const action = payload.actions?.[0];
  if (!action) return;

  // Customer picked inside the /request modal: narrow the company dropdown
  // to that customer's linked companies.
  if (action.block_id === 'contact_sel' && payload.view?.id) {
    return handleContactSelected(env, payload, action);
  }

  // Buttons and menus on the App Home tab.
  if (action.action_id.startsWith('home_')) {
    return handleHomeAction(env, payload, action);
  }

  const id = Number(action.value);
  if (!Number.isFinite(id)) return;
  const userId = payload.user.id;

  let updated: db.RequestRow | null = null;
  switch (action.action_id) {
    case 'req_claim':
      updated = await db.assignRequest(env, id, userId);
      break;
    case 'req_progress':
      updated = await db.setRequestStatus(env, id, 'in_progress');
      break;
    case 'req_done': {
      const existing = await db.getRequest(env, id);
      if (existing && !existing.assigned_to) {
        await db.assignRequest(env, id, userId);
      }
      updated = await db.setRequestStatus(env, id, 'done');
      break;
    }
    default:
      return;
  }

  if (!updated) return;
  const channel = payload.channel?.id ?? updated.channel_id;
  const ts = payload.message?.ts ?? updated.message_ts;
  if (channel && ts) {
    await slackApi(env, 'chat.update', {
      channel,
      ts,
      text: `Ticket ${ticketRef(updated.id)}: ${updated.title} (${updated.status})`,
      blocks: requestBlocks(updated, env.TIMEZONE),
    });
  }
}

async function handleContactSelected(
  env: Env,
  payload: InteractionPayload,
  action: BlockAction
): Promise<void> {
  const view = payload.view;
  if (!view?.id) return;
  const values = view.state.values;
  const contactName = action.selected_option?.value ?? null;

  const [contacts, allCompanies] = await Promise.all([
    db.listDirectory(env, 'contacts'),
    db.listDirectory(env, 'companies'),
  ]);
  const linked = contactName ? await db.companiesForContact(env, contactName) : [];
  const companies = linked.length > 0 ? linked : allCompanies;

  // Carry everything already in the form into the rebuilt modal.
  const state = {
    contact: contactName,
    company: values.company_sel?.v?.selected_option?.value ?? null,
    title: values.title?.v?.value ?? null,
    details: values.details?.v?.value ?? null,
    due: values.due?.v?.selected_date ?? null,
    priority: values.priority?.v?.selected_option?.value ?? null,
  };

  await slackApi(env, 'views.update', {
    view_id: view.id,
    view: newRequestModal(view.private_metadata, contacts, companies, state, linked.length > 0),
  });
}

async function handleHomeAction(
  env: Env,
  payload: InteractionPayload,
  action: BlockAction
): Promise<void> {
  const userId = payload.user.id;

  if (action.action_id === 'home_add_contact' || action.action_id === 'home_add_company') {
    const kind = action.action_id === 'home_add_contact' ? 'contacts' : 'companies';
    await slackApi(env, 'views.open', { trigger_id: payload.trigger_id, view: addDirectoryModal(kind) });
    return;
  }

  if (action.action_id === 'home_remove_company_pick') {
    const companies = await db.listDirectory(env, 'companies');
    if (companies.length === 0) return;
    await slackApi(env, 'views.open', { trigger_id: payload.trigger_id, view: removeCompanyModal(companies) });
    return;
  }

  if (action.action_id === 'home_contact_menu') {
    const [verb, idText] = (action.selected_option?.value ?? '').split(':');
    const contactId = Number(idText);
    if (!Number.isFinite(contactId)) return;

    if (verb === 'remove') {
      await db.removeDirectoryEntry(env, 'contacts', String(contactId));
      await publishHome(env, userId);
      return;
    }
    if (verb === 'link') {
      const contact = await db.getDirectoryEntryById(env, 'contacts', contactId);
      if (!contact) return;
      const [companies, linked] = await Promise.all([
        db.listDirectory(env, 'companies'),
        db.companiesForContact(env, contact.name),
      ]);
      await slackApi(env, 'views.open', {
        trigger_id: payload.trigger_id,
        view: linkCompaniesModal(contact, companies, new Set(linked.map((c) => c.id))),
      });
    }
  }
}

async function handleViewSubmission(env: Env, payload: InteractionPayload): Promise<void> {
  const view = payload.view;
  if (!view) return;
  const values = view.state.values;
  const channelId = view.private_metadata;
  const userId = payload.user.id;

  if (view.callback_id === 'new_request') {
    // Company comes from the dropdown when the directory has entries, or the
    // free-text fallback block when it doesn't.
    const company =
      values.company_sel?.v?.selected_option?.value ?? values.company?.v?.value?.trim() ?? null;
    const request = await db.createRequest(env, {
      title: values.title?.v?.value?.trim() ?? '(untitled)',
      company: company || null,
      contact: values.contact_sel?.v?.selected_option?.value ?? null,
      details: values.details?.v?.value?.trim() || null,
      due_date: values.due?.v?.selected_date ?? null,
      priority: values.priority?.v?.selected_option?.value ?? 'normal',
      created_by: userId,
      channel_id: channelId,
    });
    const posted = await postRequestMessage(env, request, channelId);
    if (!posted.ok) {
      await dmUser(
        env,
        userId,
        `✅ Your ticket *${ticketRef(request.id)} · ${esc(request.title)}* was saved, but I couldn't post it to the channel` +
          ` (\`${posted.error}\`). If it's a private channel, run \`/invite @Fulfillment Assistant\` there.`
      );
    }
    return;
  }

  // --- App Home admin modals ---

  if (view.callback_id === 'add_contact' || view.callback_id === 'add_company') {
    const kind = view.callback_id === 'add_contact' ? 'contacts' : 'companies';
    const name = values.name?.v?.value?.trim().replace(/\s+/g, ' ').slice(0, 70);
    if (name) {
      const added = await db.addDirectoryEntry(env, kind, name);
      if (added === 'duplicate') {
        await dmUser(env, userId, `*${esc(name)}* is already on the ${kind === 'contacts' ? 'customer' : 'company'} list.`);
      }
    }
    await publishHome(env, userId);
    return;
  }

  if (view.callback_id === 'link_contact') {
    // private_metadata carries the contact id for this modal
    const contact = await db.getDirectoryEntryById(env, 'contacts', Number(view.private_metadata));
    if (!contact) return;
    const selected = new Set(
      (values.companies?.v?.selected_options ?? []).map((o) => Number(o.value))
    );
    const current = new Set((await db.companiesForContact(env, contact.name)).map((c) => c.id));
    for (const companyId of selected) {
      if (!current.has(companyId)) await db.linkContactCompany(env, contact.id, companyId);
    }
    for (const companyId of current) {
      if (!selected.has(companyId)) await db.unlinkContactCompany(env, contact.id, companyId);
    }
    await publishHome(env, userId);
    return;
  }

  if (view.callback_id === 'remove_company') {
    const companyId = values.company?.v?.selected_option?.value;
    if (companyId) await db.removeDirectoryEntry(env, 'companies', companyId);
    await publishHome(env, userId);
    return;
  }

  if (view.callback_id === 'new_shipment') {
    const description = values.description?.v?.value?.trim() ?? '(untitled)';
    const shipDate = values.ship_date?.v?.selected_date;
    if (!shipDate) return;
    const notes = values.notes?.v?.value?.trim() || null;
    const shipment = await db.createShipment(env, shipDate, description, notes, userId);
    const res = await slackApi(env, 'chat.postMessage', {
      channel: channelId,
      text: `🚚 Shipment scheduled — #${shipment.id}: ${description} on ${formatDate(shipDate)}`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text:
              `🚚 *Shipment scheduled* — *#${shipment.id}*  ${esc(description)}\n` +
              `📅 Ships *${formatDate(shipDate)}*${notes ? `\n_${esc(notes)}_` : ''} (added by <@${userId}>)`,
          },
        },
      ],
    });
    if (!res.ok) {
      await dmUser(
        env,
        userId,
        `✅ Shipment *#${shipment.id}* saved for *${formatDate(shipDate)}*, but I couldn't post it to the channel` +
          ` (\`${res.error}\`). It will still show up in \`/shipping\` and the daily digest.`
      );
    }
  }
}
