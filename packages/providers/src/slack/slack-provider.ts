import { Http } from '../http.js';
import type { MessageThread, MessagingProvider } from '../types.js';

/**
 * Slack messaging adapter, written against the real Slack Web API.
 *
 * Slack answers 200 with `{ ok: false, error }` for application-level failures, so
 * every call checks `ok`. A message that silently failed to send would leave Pager
 * believing it had told the team something it never said — which is exactly the
 * class of failure this product exists to avoid.
 */

interface SlackOk {
  ok: boolean;
  error?: string;
}

interface SlackPostResponse extends SlackOk {
  ts?: string;
  channel?: string;
}

interface SlackRepliesResponse extends SlackOk {
  messages?: { text?: string; ts?: string }[];
}

export class SlackApiError extends Error {
  constructor(readonly method: string, readonly slackError: string) {
    super(`Slack ${method} failed: ${slackError}`);
    this.name = 'SlackApiError';
  }
}

export interface SlackProviderOptions {
  baseUrl: string;
  token?: string;
  fetchImpl?: typeof globalThis.fetch;
}

export class SlackProvider implements MessagingProvider {
  readonly kind = 'messaging' as const;
  private readonly http: Http;

  constructor(opts: SlackProviderOptions) {
    this.http = new Http({
      baseUrl: opts.baseUrl,
      headers: opts.token ? { authorization: `Bearer ${opts.token}` } : {},
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    });
  }

  async openThread(channel: string, text: string, blocks?: unknown): Promise<MessageThread> {
    const res = await this.http.post<SlackPostResponse>('/api/chat.postMessage', {
      channel,
      text,
      ...(blocks ? { blocks } : {}),
    });
    assertOk('chat.postMessage', res);
    if (!res.ts) throw new SlackApiError('chat.postMessage', 'response carried no message ts');
    return { id: res.ts, channel: res.channel ?? channel };
  }

  async replyInThread(thread: MessageThread, text: string, blocks?: unknown): Promise<void> {
    const res = await this.http.post<SlackPostResponse>('/api/chat.postMessage', {
      channel: thread.channel,
      thread_ts: thread.id,
      text,
      ...(blocks ? { blocks } : {}),
    });
    assertOk('chat.postMessage', res);
  }

  /** Reads back what was actually posted — used to verify communications, not to send. */
  async readThread(thread: MessageThread): Promise<{ text: string; at: Date }[]> {
    const res = await this.http.get<SlackRepliesResponse>('/api/conversations.replies', {
      channel: thread.channel,
      ts: thread.id,
    });
    assertOk('conversations.replies', res);
    return (res.messages ?? []).map((m) => ({
      text: m.text ?? '',
      at: m.ts ? new Date(Number(m.ts) * 1000) : new Date(0),
    }));
  }
}

function assertOk(method: string, res: SlackOk): void {
  if (!res.ok) throw new SlackApiError(method, res.error ?? 'unknown_error');
}
