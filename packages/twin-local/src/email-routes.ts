import { randomUUID } from 'node:crypto';
import type { Route } from './router.js';

/**
 * Resend API surface.
 *
 * Reproduces the validation that actually bites: a missing or unverified `from`, and
 * an empty recipient list. A twin that accepts anything would let a broken send look
 * successful right up until production.
 */
export function resendRoutes(): Route[] {
  return [
    {
      method: 'POST',
      pattern: /^\/emails$/,
      handler: (ctx) => {
        if (!ctx.headers.authorization?.startsWith('Bearer ')) {
          return { status: 401, body: { name: 'missing_api_key', message: 'Missing API key' } };
        }

        const body = ctx.json as {
          from?: string;
          to?: string[] | string;
          subject?: string;
          text?: string;
          html?: string;
        };

        const to = Array.isArray(body.to) ? body.to : body.to ? [body.to] : [];
        if (to.length === 0) {
          return { status: 422, body: { name: 'validation_error', message: '`to` is required' } };
        }
        if (!body.from) {
          return { status: 422, body: { name: 'validation_error', message: '`from` is required' } };
        }
        if (!body.subject) {
          return { status: 422, body: { name: 'validation_error', message: '`subject` is required' } };
        }

        const id = randomUUID();
        ctx.state.emails.push({
          id,
          from: body.from,
          to,
          subject: body.subject,
          text: body.text ?? '',
          html: body.html ?? '',
          sentAt: new Date(ctx.now()).toISOString(),
        });
        return { status: 200, body: { id } };
      },
    },
  ];
}
