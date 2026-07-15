// Fulfillment Assistant — Slack app on Cloudflare Workers.
//
// Endpoints:
//   POST /slack/commands      slash commands           (Slack manifest)
//   POST /slack/interactions  buttons + modals         (Slack manifest)
//   POST /slack/events        Events API / App Home    (Slack manifest)
//   GET  /api/board           wallboard data           (React app polls this)
//   POST /api/board/action    wallboard claim/done     (React app)
// The wallboard itself is a static React app (board/dist) served from "/".
// Cron: hourly, posts the morning digest at DIGEST_HOUR in TIMEZONE.

import { boardAction, boardData } from './api';
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
    const url = new URL(request.url);

    if (request.method === 'GET') {
      if (url.pathname === '/api/board') {
        return boardData(env, url);
      }
      // Old wallboard bookmark — the app now lives at the site root.
      if (url.pathname === '/board') {
        return Response.redirect(`${url.origin}/${url.search}`, 302);
      }
      if (url.pathname === '/health') {
        return new Response('Fulfillment Assistant is running. 🚚', {
          headers: { 'content-type': 'text/plain; charset=utf-8' },
        });
      }
      // Static assets (the React board) are served before the Worker runs;
      // any GET that reaches here matched nothing.
      return new Response('Not found', { status: 404 });
    }
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    if (url.pathname === '/api/board/action') {
      return boardAction(env, request);
    }

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
