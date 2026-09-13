import { Http } from '../http.js';

/**
 * Email delivery, used for the post-incident write-up to the team.
 *
 * Written against Resend's API. Send-only by design: Pager needs to report, never to
 * read a mailbox, and an integration that cannot read cannot leak what it reads.
 */

export interface EmailRef {
  id: string;
  to: string[];
  subject: string;
  sentAt: Date;
}

export interface SendEmailInput {
  to: string[];
  subject: string;
  /** Plain text. Rendered to simple HTML when `html` is not supplied. */
  text: string;
  html?: string;
  from?: string;
  replyTo?: string;
}

export interface EmailProvider {
  readonly kind: 'email';
  send(input: SendEmailInput): Promise<EmailRef>;
}

export class EmailSendError extends Error {
  constructor(message: string) {
    super(`Email send failed: ${message}`);
    this.name = 'EmailSendError';
  }
}

/** Minimal, escaped HTML rendering of a plain-text write-up. */
export function textToHtml(text: string): string {
  const escape = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const blocks = text.split(/\n{2,}/).map((block) => {
    const heading = /^(#{1,3})\s+(.*)$/.exec(block.trim());
    if (heading) {
      const level = heading[1]!.length + 1;
      return `<h${level}>${escape(heading[2]!)}</h${level}>`;
    }
    if (block.trim().startsWith('- ')) {
      const items = block
        .split('\n')
        .filter((l) => l.trim().startsWith('- '))
        .map((l) => `<li>${escape(l.trim().slice(2))}</li>`)
        .join('');
      return `<ul>${items}</ul>`;
    }
    return `<p>${escape(block).replace(/\n/g, '<br>')}</p>`;
  });

  return `<div style="font-family:system-ui,sans-serif;font-size:14px;line-height:1.5">${blocks.join('')}</div>`;
}

export interface ResendProviderOptions {
  baseUrl?: string;
  apiKey?: string;
  /** Default sender. Resend requires a verified domain in production. */
  from?: string;
  fetchImpl?: typeof globalThis.fetch;
}

export class ResendProvider implements EmailProvider {
  readonly kind = 'email' as const;
  private readonly http: Http;
  private readonly defaultFrom: string;

  constructor(opts: ResendProviderOptions) {
    this.defaultFrom = opts.from ?? 'pager-developer@example.com';
    this.http = new Http({
      baseUrl: opts.baseUrl ?? 'https://api.resend.com',
      headers: opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {},
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    });
  }

  async send(input: SendEmailInput): Promise<EmailRef> {
    if (input.to.length === 0) {
      // Refused rather than treated as a successful no-op: a write-up nobody
      // received must not look like one that was delivered.
      throw new EmailSendError('no recipients supplied');
    }

    const res = await this.http.post<{ id?: string; message?: string; name?: string }>('/emails', {
      from: input.from ?? this.defaultFrom,
      to: input.to,
      subject: input.subject,
      text: input.text,
      html: input.html ?? textToHtml(input.text),
      ...(input.replyTo ? { reply_to: input.replyTo } : {}),
    });

    if (!res.id) {
      throw new EmailSendError(res.message ?? res.name ?? 'response carried no message id');
    }
    return { id: res.id, to: input.to, subject: input.subject, sentAt: new Date() };
  }
}
