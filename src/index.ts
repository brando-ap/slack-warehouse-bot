// Fulfillment Assistant — Slack app on Cloudflare Workers.
//
// Endpoints (configured in the Slack app manifest):
//   POST /slack/commands      slash commands
//   POST /slack/interactions  buttons + modal submissions
//   POST /slack/events        Events API (App Home opened)
// Cron: hourly, posts the morning digest at DIGEST_HOUR in TIMEZONE.

import { renderBoard } from './board';
import { handleSlashCommand } from './commands';
import { maybeRunDigest } from './digest';
import { publishHome } from './home';
import { handleInteraction } from './interactions';
import { respond } from './slack';
import { verifySlackSignature } from './verify';

function logError(context: string, err: unknown): void {
  console.log(
    JSON.stringify({
      level: 'error',
      event: context,
      error: err instanceof Error ? `${err.message}\n${err.stack}` : String(err),
    })
  );
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    if (request.method === 'GET') {
      const url = new URL(request.url);
      if (url.pathname === '/board') {
        return renderBoard(env, url);
      }
      return new Response('Fulfillment Assistant is running. 🚚', {
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    const url = new URL(request.url);
    const body = await request.text();

    if (!(await verifySlackSignature(env.SLACK_SIGNING_SECRET, request, body))) {
      return new Response('Invalid signature', { status: 401 });
    }

    if (url.pathname === '/slack/commands') {
      const form = Object.fromEntries(new URLSearchParams(body));
      ctx.waitUntil(
        handleSlashCommand(env, form).catch(async (err) => {
          logError('slash_command_failed', err);
          if (form.response_url) {
            await respond(form.response_url, {
              text: '⚠️ Something went wrong handling that command. Try again in a moment.',
            });
          }
        })
      );
      // Ack immediately (Slack's 3-second rule); the real reply arrives via response_url.
      return new Response(null, { status: 200 });
    }

    if (url.pathname === '/slack/events') {
      const payload = JSON.parse(body) as {
        type?: string;
        challenge?: string;
        event?: { type?: string; tab?: string; user?: string };
      };
      // Slack verifies this URL when the manifest is saved.
      if (payload.type === 'url_verification') {
        return new Response(JSON.stringify({ challenge: payload.challenge }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      if (
        payload.type === 'event_callback' &&
        payload.event?.type === 'app_home_opened' &&
        payload.event.tab === 'home' &&
        payload.event.user
      ) {
        const userId = payload.event.user;
        ctx.waitUntil(publishHome(env, userId).catch((err) => logError('home_publish_failed', err)));
      }
      return new Response(null, { status: 200 });
    }

    if (url.pathname === '/slack/interactions') {
      const raw = new URLSearchParams(body).get('payload');
      if (!raw) return new Response('Bad request', { status: 400 });
      const payload = JSON.parse(raw);
      ctx.waitUntil(
        handleInteraction(env, payload).catch((err) => logError('interaction_failed', err))
      );
      return new Response(null, { status: 200 });
    }

    return new Response('Not found', { status: 404 });
  },

  async scheduled(_controller, env, ctx): Promise<void> {
    ctx.waitUntil(maybeRunDigest(env).catch((err) => logError('digest_failed', err)));
  },
} satisfies ExportedHandler<Env>;
