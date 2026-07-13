// Handlers for interactive payloads: button clicks on request cards and
// modal (form) submissions.

import * as db from './db';
import { postRequestMessage } from './commands';
import { esc, requestBlocks } from './format';
import { dmUser, slackApi } from './slack';
import { formatDate } from './dates';

interface BlockAction {
  action_id: string;
  value?: string;
}

interface InteractionPayload {
  type: string;
  user: { id: string; username?: string; name?: string };
  channel?: { id: string };
  message?: { ts: string };
  actions?: BlockAction[];
  view?: {
    callback_id: string;
    private_metadata: string;
    state: { values: Record<string, Record<string, ViewValue>> };
  };
}

interface ViewValue {
  value?: string;
  selected_date?: string;
  selected_option?: { value: string };
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
      text: `Request #${updated.id}: ${updated.title} (${updated.status})`,
      blocks: requestBlocks(updated, env.TIMEZONE),
    });
  }
}

async function handleViewSubmission(env: Env, payload: InteractionPayload): Promise<void> {
  const view = payload.view;
  if (!view) return;
  const values = view.state.values;
  const channelId = view.private_metadata;
  const userId = payload.user.id;

  if (view.callback_id === 'new_request') {
    const request = await db.createRequest(env, {
      title: values.title?.v?.value?.trim() ?? '(untitled)',
      company: values.company?.v?.value?.trim() || null,
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
        `✅ Your request *#${request.id} · ${esc(request.title)}* was saved, but I couldn't post it to the channel` +
          ` (\`${posted.error}\`). If it's a private channel, run \`/invite @Fulfillment Assistant\` there.`
      );
    }
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
