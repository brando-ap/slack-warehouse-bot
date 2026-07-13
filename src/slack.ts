// Thin Slack Web API client + response_url helper.

export interface SlackApiResponse {
  ok: boolean;
  error?: string;
  ts?: string;
  channel?: string;
  [key: string]: unknown;
}

export async function slackApi(
  env: Env,
  method: string,
  payload: Record<string, unknown>
): Promise<SlackApiResponse> {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json; charset=utf-8',
      authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
    },
    body: JSON.stringify(payload),
  });
  const data = (await res.json()) as SlackApiResponse;
  if (!data.ok) {
    console.log(JSON.stringify({ level: 'error', event: 'slack_api_error', method, error: data.error }));
  }
  return data;
}

/** Reply to a slash command or interaction via its response_url (ephemeral by default). */
export async function respond(
  responseUrl: string,
  message: { text?: string; blocks?: unknown[]; response_type?: 'ephemeral' | 'in_channel'; replace_original?: boolean }
): Promise<void> {
  await fetch(responseUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ response_type: 'ephemeral', ...message }),
  });
}

/** Send a direct message to a user. */
export async function dmUser(env: Env, userId: string, text: string): Promise<void> {
  const open = await slackApi(env, 'conversations.open', { users: userId });
  const channel = (open.channel as { id?: string } | undefined)?.id;
  if (channel) await slackApi(env, 'chat.postMessage', { channel, text });
}
