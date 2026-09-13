import { describe, expect, it } from 'vitest';
import { DatadogProvider } from '../src/datadog/datadog-provider.js';
import { SlackApiError, SlackProvider } from '../src/slack/slack-provider.js';

function jsonFetch(handler: (url: string, init: RequestInit) => unknown): typeof fetch {
  return (async (input: string | URL, init: RequestInit = {}) =>
    new Response(JSON.stringify(handler(String(input), init)), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
}

const range = { from: new Date('2026-09-13T14:00:00Z'), to: new Date('2026-09-13T14:30:00Z') };

describe('DatadogProvider', () => {
  it('converts a pointlist into a typed series', async () => {
    const dd = new DatadogProvider({
      baseUrl: 'https://pub-r1--datadog.arga.test',
      fetchImpl: jsonFetch(() => ({
        series: [{ metric: 'x', pointlist: [[1757772000000, 0.004], [1757772060000, 0.178]] }],
      })),
    });
    const series = await dd.queryMetric('checkout-api', 'error_rate', range);
    expect(series.points).toHaveLength(2);
    expect(series.points[1]!.value).toBeCloseTo(0.178);
    expect(series.unit).toBe('ratio');
  });

  it('drops null gaps rather than reading them as zero', async () => {
    const dd = new DatadogProvider({
      baseUrl: 'https://dd.test',
      fetchImpl: jsonFetch(() => ({
        series: [{ metric: 'x', pointlist: [[1, 0.5], [2, null], [3, 0.6]] }],
      })),
    });
    const series = await dd.queryMetric('s', 'error_rate', range);
    expect(series.points.map((p) => p.value)).toEqual([0.5, 0.6]);
  });

  it('throws on a 200-with-error payload instead of reporting an empty series', async () => {
    const dd = new DatadogProvider({
      baseUrl: 'https://dd.test',
      fetchImpl: jsonFetch(() => ({ status: 'error', error: 'invalid query' })),
    });
    await expect(dd.queryMetric('s', 'error_rate', range)).rejects.toThrow(/invalid query/);
  });

  it('extracts stack traces and normalises log levels', async () => {
    const dd = new DatadogProvider({
      baseUrl: 'https://dd.test',
      fetchImpl: jsonFetch(() => ({
        data: [
          {
            attributes: {
              timestamp: '2026-09-13T14:35:00Z',
              status: 'ERROR',
              message: 'TypeError: Cannot read properties of null',
              service: 'checkout-api',
              attributes: { error: { stack: 'at CheckoutService.createOrder (src/checkout/service.ts:88)' } },
            },
          },
        ],
      })),
    });
    const logs = await dd.queryLogs('checkout-api', range, { level: 'error' });
    expect(logs[0]!.level).toBe('error');
    expect(logs[0]!.stackTrace).toContain('src/checkout/service.ts:88');
  });

  it('maps monitor states', async () => {
    const dd = new DatadogProvider({
      baseUrl: 'https://dd.test',
      fetchImpl: jsonFetch(() => [
        { id: 1, name: 'checkout errors', overall_state: 'Alert', query: 'q', overall_state_modified: '2026-09-13T14:34:00Z' },
        { id: 2, name: 'idle', overall_state: 'No Data' },
      ]),
    });
    const monitors = await dd.listMonitors('checkout-api');
    expect(monitors[0]!.status).toBe('ALERT');
    expect(monitors[0]!.transitionedAt).toBeInstanceOf(Date);
    expect(monitors[1]!.status).toBe('NO_DATA');
  });
});

describe('SlackProvider', () => {
  it('opens a thread and replies into it', async () => {
    const bodies: unknown[] = [];
    const slack = new SlackProvider({
      baseUrl: 'https://pub-r1--slack.arga.test',
      token: 'xoxb-test',
      fetchImpl: jsonFetch((_u, init) => {
        bodies.push(JSON.parse(String(init.body)));
        return { ok: true, ts: '1757772000.000100', channel: 'C123' };
      }),
    });

    const thread = await slack.openThread('#incidents', 'Production regression detected');
    await slack.replyInThread(thread, 'Investigation update');

    expect(thread.id).toBe('1757772000.000100');
    expect(bodies[1]).toMatchObject({ thread_ts: '1757772000.000100', channel: 'C123' });
  });

  it('treats ok:false as a failure rather than a successful send', async () => {
    const slack = new SlackProvider({
      baseUrl: 'https://slack.test',
      fetchImpl: jsonFetch(() => ({ ok: false, error: 'channel_not_found' })),
    });
    await expect(slack.openThread('#nope', 'hi')).rejects.toThrow(SlackApiError);
    await expect(slack.openThread('#nope', 'hi')).rejects.toThrow(/channel_not_found/);
  });

  it('refuses to invent a thread id when Slack returns ok without one', async () => {
    const slack = new SlackProvider({
      baseUrl: 'https://slack.test',
      fetchImpl: jsonFetch(() => ({ ok: true })),
    });
    await expect(slack.openThread('#c', 'hi')).rejects.toThrow(/no message ts/);
  });

  it('reads a thread back for verifying what was actually communicated', async () => {
    const slack = new SlackProvider({
      baseUrl: 'https://slack.test',
      fetchImpl: jsonFetch(() => ({ ok: true, messages: [{ text: 'first', ts: '1757772000.000100' }] })),
    });
    const msgs = await slack.readThread({ id: '1757772000.000100', channel: 'C1' });
    expect(msgs[0]!.text).toBe('first');
  });
});
