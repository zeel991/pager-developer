import type { Route } from './router.js';

/**
 * Slack Web API surface.
 *
 * Reproduces Slack's convention of answering HTTP 200 with `{ ok: false, error }`
 * for application-level failures, so the adapter's `ok` checking is exercised rather
 * than bypassed by a twin that always succeeds.
 */
export function slackRoutes(): Route[] {
  return [
    {
      method: 'POST',
      pattern: /^\/api\/chat\.postMessage$/,
      handler: (ctx) => {
        const body = ctx.json as { channel?: string; text?: string; thread_ts?: string; blocks?: unknown };
        const channel = body.channel ?? '';
        if (!channel) return { status: 200, body: { ok: false, error: 'invalid_arguments' } };
        if (!ctx.state.channels.has(channel)) {
          return { status: 200, body: { ok: false, error: 'channel_not_found' } };
        }

        const ts = `${(ctx.now() / 1000).toFixed(6)}`;
        ctx.state.messages.push({
          ts,
          channel,
          threadTs: body.thread_ts ?? null,
          text: body.text ?? '',
          blocks: body.blocks ?? null,
        });
        return { status: 200, body: { ok: true, ts, channel } };
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/conversations\.replies$/,
      handler: (ctx) => {
        const channel = ctx.query.channel ?? '';
        const ts = ctx.query.ts ?? '';
        if (!ctx.state.channels.has(channel)) {
          return { status: 200, body: { ok: false, error: 'channel_not_found' } };
        }
        const messages = ctx.state.messages.filter(
          (m) => m.channel === channel && (m.ts === ts || m.threadTs === ts),
        );
        return {
          status: 200,
          body: { ok: true, messages: messages.map((m) => ({ ts: m.ts, text: m.text, thread_ts: m.threadTs })) },
        };
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/conversations\.list$/,
      handler: (ctx) => ({
        status: 200,
        body: { ok: true, channels: [...ctx.state.channels].map((name) => ({ id: name, name })) },
      }),
    },
  ];
}
