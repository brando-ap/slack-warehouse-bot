// Scheduled morning digest. The cron trigger fires every hour; this posts
// only when the current hour in TIMEZONE matches DIGEST_HOUR.

import { listOpenRequests, listShipments } from './db';
import { addDays, hourInTZ, todayInTZ } from './dates';
import { digestBlocks } from './format';
import { slackApi } from './slack';

export async function maybeRunDigest(env: Env): Promise<void> {
  if (!env.DIGEST_CHANNEL) return;

  const digestHour = Number(env.DIGEST_HOUR || '8');
  if (hourInTZ(env.TIMEZONE) !== digestHour) return;

  const today = todayInTZ(env.TIMEZONE);
  const [open, shipments] = await Promise.all([
    listOpenRequests(env),
    listShipments(env, today, addDays(today, 7)),
  ]);

  const { text, blocks } = digestBlocks(open, shipments, env.TIMEZONE);
  await slackApi(env, 'chat.postMessage', {
    channel: env.DIGEST_CHANNEL,
    text,
    blocks,
    unfurl_links: false,
  });
}
