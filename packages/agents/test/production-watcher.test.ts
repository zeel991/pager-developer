import { afterEach, describe, expect, it } from 'vitest';
import { DatadogProvider, NotionProvider } from '@pager/providers';
import { AgentTracer, InMemorySink } from '@pager/observability';
import { INC_001, INC_009, INC_011, LocalTwinServer, seedFromFixture } from '@pager/twin-local';
import { ProductionWatcher, describeAlert, extractKnownFailureModes } from '../src/production-watcher.js';

let server: LocalTwinServer;
let endpoints: Awaited<ReturnType<LocalTwinServer['start']>>;

async function start(fixtureSpec: Parameters<typeof seedFromFixture>[0]) {
  server = new LocalTwinServer({ now: () => Date.parse('2026-09-13T14:45:00Z') });
  server.seed(seedFromFixture(fixtureSpec));
  endpoints = await server.start();
}

afterEach(async () => {
  await server?.stop();
});

function watcher(withRunbooks = true) {
  const observability = new DatadogProvider({ baseUrl: endpoints.datadog });
  const knowledge = withRunbooks
    ? new NotionProvider({ baseUrl: endpoints.notion, token: 't' })
    : null;
  return new ProductionWatcher(observability, knowledge);
}

const tracer = () => {
  const sink = new InMemorySink();
  return { sink, tracer: new AgentTracer({ sink, lemma: null }) };
};

describe('extractKnownFailureModes', () => {
  it('picks up error type names a runbook mentions', () => {
    const modes = extractKnownFailureModes([
      { title: 'Runbook', content: '- PaymentGatewayError means the upstream is down.' },
    ]);
    expect(modes).toHaveLength(1);
    expect(modes[0]).toMatchObject({ marker: 'PaymentGatewayError', source: 'Runbook' });
  });

  it('does not register a failure mode from prose alone', () => {
    // "sometimes the gateway is slow" must not silence a novel gateway crash.
    expect(
      extractKnownFailureModes([{ title: 'R', content: 'Sometimes the gateway is slow at peak.' }]),
    ).toHaveLength(0);
  });

  it('deduplicates a mode mentioned in several places', () => {
    const modes = extractKnownFailureModes([
      { title: 'A', content: 'PaymentGatewayError happens.' },
      { title: 'B', content: 'See PaymentGatewayError again.' },
    ]);
    expect(modes).toHaveLength(1);
  });
});

describe('ProductionWatcher', () => {
  it('escalates a novel failure with a located application frame', async () => {
    await start(INC_001);
    const { tracer: t } = tracer();

    const alert = await t.run('ProductionWatcher', {}, (ctx) =>
      watcher().check(ctx, 'checkout-api'),
    );

    expect(alert).not.toBeNull();
    expect(alert!.escalate).toBe(true);
    expect(alert!.primary!.errorType).toBe('TypeError');
    expect(alert!.primary!.topApplicationFrame!.file).toContain('src/checkout/service.ts');
    expect(describeAlert(alert!)).toContain('src/checkout/service.ts:20');
    expect(alert!.rationale).toMatch(/match no documented failure mode/);
  });

  it('does not escalate a failure the runbook already documents', async () => {
    // INC-009's runbook names PaymentGatewayError explicitly.
    await start(INC_009);
    const { tracer: t } = tracer();

    const alert = await t.run('ProductionWatcher', {}, (ctx) =>
      watcher().check(ctx, 'checkout-api'),
    );

    expect(alert!.primary!.errorType).toBe('PaymentGatewayError');
    expect(alert!.escalate).toBe(false);
    expect(alert!.novelty!.matched!.marker).toBe('PaymentGatewayError');
    expect(alert!.rationale).toMatch(/Handle via its runbook/);
  });

  it('escalates that same failure when the runbooks are unavailable', async () => {
    // Losing context must err toward waking someone, not toward silence.
    await start(INC_009);
    const { tracer: t } = tracer();

    const alert = await t.run('ProductionWatcher', {}, (ctx) =>
      watcher(false).check(ctx, 'checkout-api'),
    );

    expect(alert!.escalate).toBe(true);
  });

  it('refuses to escalate an alerting monitor with no errors beneath it', async () => {
    // INC-011: production is healthy, the monitor thresholds on a count.
    await start(INC_011);
    const { tracer: t } = tracer();

    const alert = await t.run('ProductionWatcher', {}, (ctx) =>
      watcher().check(ctx, 'checkout-api'),
    );

    expect(alert).not.toBeNull();
    expect(alert!.clusters).toHaveLength(0);
    expect(alert!.escalate).toBe(false);
    expect(alert!.rationale).toMatch(/more likely a monitor problem than a production one/);
  });

  it('returns nothing when no monitor is alerting', async () => {
    await start(INC_001);
    const { tracer: t } = tracer();
    const alert = await t.run('ProductionWatcher', {}, (ctx) =>
      watcher().check(ctx, 'some-other-service'),
    );
    expect(alert).toBeNull();
  });

  it('records every provider call it made', async () => {
    await start(INC_001);
    const { sink, tracer: t } = tracer();
    await t.run('ProductionWatcher', {}, (ctx) => watcher().check(ctx, 'checkout-api'));

    const names = sink.toolCalls.map((c) => c.toolName);
    expect(names).toContain('datadog.listMonitors');
    expect(names).toContain('datadog.queryLogs');
    expect(sink.failedToolCalls()).toHaveLength(0);
  });
});
