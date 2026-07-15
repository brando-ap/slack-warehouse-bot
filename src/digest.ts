// Scheduled morning digest. The cron trigger fires every hour; this posts
// only when the current hour in TIMEZONE matches DIGEST_HOUR.

import { listOpenRequests } from './db';
import { hourInTZ } from './dates';
import { digestBlocks } from './format';
import { slackApi } from './slack';

export async function maybeRunDigest(env: Env): Promise<void> {
  if (!env.DIGEST_CHANNEL) return;

  const digestHour = Number(env.DIGEST_HOUR || '8');
  if (hourInTZ(env.TIMEZONE) !== digestHour) return;

  const open = await listOpenRequests(env);
  const { text, blocks } = digestBlocks(open, env.TIMEZONE);
  await slackApi(env, 'chat.postMessage', {
    channel: env.DIGEST_CHANNEL,
    text,
    blocks,
    unfurl_links: false,
  });
}
