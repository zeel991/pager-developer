import { afterEach, describe, expect, it } from 'vitest';
import {
  DatadogProvider,
  GitHubAppTokenSource,
  GitHubProvider,
  JiraProvider,
  NotionProvider,
  PAGER_APP_MANIFEST,
  ResendProvider,
  SlackProvider,
  registerViaManifest,
} from '@pager/providers';
import { AgentTracer, InMemorySink } from '@pager/observability';
import { INC_001, INC_009, INC_011, LocalTwinServer, seedFromFixture } from '@pager/twin-local';
import {
  IncidentWorkflow,
  TELEMETRY_WINDOW_MINUTES,
  telemetryWindowsFor,
} from '../src/workflow.js';
import { NoPatchGenerator, ScriptedPatchGenerator } from '../src/patch-generator.js';

let server: LocalTwinServer;

const REGRESSION_TEST = `import { it } from 'node:test';
import assert from 'node:assert/strict';
import { CheckoutService } from '../src/checkout/service.ts';
it('handles a missing discount code', () => {
  const o = new CheckoutService().createOrder({ customerId: 'c', items: [{ sku: 'A', quantity: 1, unitPriceCents: 1000 }] });
  assert.equal(o.totalCents, 1000);
});
`;

const PATCHED = `import type { OrderRequest } from './types.ts';
export interface Order { customerId: string; subtotalCents: number; discountCents: number; totalCents: number; appliedCode: string | null }
export class CheckoutService {
  createOrder(request: OrderRequest): Order {
    const subtotalCents = request.items.reduce((s, i) => s + i.unitPriceCents * i.quantity, 0);
    const code = request.discountCode ?? null;
    const discountCents = code ? Math.round(subtotalCents * (code.percentOff / 100)) : 0;
    return { customerId: request.customerId, subtotalCents, discountCents, totalCents: subtotalCents - discountCents, appliedCode: code ? code.value : null };
  }
}
`;

async function build(fixture: Parameters<typeof seedFromFixture>[0], generator: 'scripted' | 'none' | 'bad-test') {
  server = new LocalTwinServer({ now: () => Date.parse('2026-09-13T14:45:00Z') });
  server.seed(seedFromFixture(fixture));
  const e = await server.start();
  const creds = await registerViaManifest(e.github, PAGER_APP_MANIFEST(e.github));
  const tokens = new GitHubAppTokenSource(e.github, creds);
  const sink = new InMemorySink();

  const patchGenerator =
    generator === 'none'
      ? new NoPatchGenerator()
      : new ScriptedPatchGenerator({
          regressionTest: {
            path: 'test/regression.test.ts',
            source:
              generator === 'bad-test'
                ? `import { it } from 'node:test';\nimport assert from 'node:assert/strict';\nit('trivial', () => assert.ok(true));\n`
                : REGRESSION_TEST,
          },
          patch: {
            rootCause: 'createOrder dereferenced an optional field',
            explanation: 'Guard it',
            files: [{ path: 'src/checkout/service.ts', content: PATCHED }],
            risks: [],
            rollbackPlan: 'Revert the merge commit.',
            confidence: 0.9,
          },
        });

  const workflow = new IncidentWorkflow({
    observability: new DatadogProvider({ baseUrl: e.datadog }),
    sourceControl: new GitHubProvider({ baseUrl: e.github, tokenProvider: () => tokens.token() }),
    messaging: new SlackProvider({ baseUrl: e.slack }),
    issueTracker: new JiraProvider({ baseUrl: e.jira, projectKey: 'INC' }),
    knowledge: new NotionProvider({ baseUrl: e.notion, token: 't', parentPageId: 'runbook-checkout' }),
    email: new ResendProvider({ baseUrl: e.resend, apiKey: 're_t', from: 'p@acme.dev' }),
    tracer: new AgentTracer({ sink, lemma: null }),
    patchGenerator,
  });

  return { workflow, sink, endpoints: e };
}

const input = {
  service: 'checkout-api',
  repository: 'acme/checkout-api',
  slackChannel: '#incidents',
  incidentKey: 'INC-184',
  teamEmails: ['team@acme.dev'],
};

afterEach(async () => {
  await server?.stop();
});

describe('IncidentWorkflow', () => {
  it('runs alert → ticket → slack → fix → PR', async () => {
    const { workflow } = await build(INC_001, 'scripted');
    const result = await workflow.run(input);

    expect(result.haltReason).toBeNull();
    expect(result.stage).toBe('awaiting_merge');
    expect(result.alert!.escalate).toBe(true);
    expect(result.issue!.key).toBe('INC-1');
    expect(result.reproduction!.proven).toBe(true);
    expect(result.pullRequest!.number).toBe(378);

    // Every side effect is visible in the twin's own state.
    const state = server.current;
    expect(state.issues[0]!.status).toBe('In Progress');
    expect(state.messages).toHaveLength(2);
    expect(state.repositories.get('acme/checkout-api')!.branches.has('pager/inc-184')).toBe(true);
  });

  it('marks the patch as scripted, never as though a model reasoned to it', async () => {
    const { workflow } = await build(INC_001, 'scripted');
    const result = await workflow.run(input);
    expect(result.patch!.kind).toBe('scripted');
  });

  it('stops with the failure located when no patch generator is configured', async () => {
    // The dangerous alternative is guessing a fix, so it does everything else and
    // hands over.
    const { workflow } = await build(INC_001, 'none');
    const result = await workflow.run(input);

    expect(result.stage).toBe('halted');
    expect(result.haltReason).toMatch(/No patch generator is configured/);
    expect(result.haltReason).toMatch(/src\/checkout\/service\.ts:20/);
    // The team was still told and the ticket still filed.
    expect(result.issue).not.toBeNull();
    expect(server.current.messages).toHaveLength(1);
    // But no branch and no pull request.
    expect(result.pullRequest).toBeNull();
    expect(server.current.repositories.get('acme/checkout-api')!.pullRequests).toHaveLength(1);
  });

  it('refuses to open a PR when the regression test does not exercise the bug', async () => {
    const { workflow } = await build(INC_001, 'bad-test');
    const result = await workflow.run(input);

    expect(result.stage).toBe('halted');
    expect(result.haltReason).toMatch(/does not exercise the reported failure/);
    expect(result.pullRequest).toBeNull();
  });

  it('does not escalate a documented failure mode', async () => {
    const { workflow } = await build(INC_009, 'scripted');
    const result = await workflow.run(input);

    expect(result.stage).toBe('not_escalated');
    expect(result.issue).toBeNull();
    expect(server.current.issues).toHaveLength(0);
    expect(server.current.messages).toHaveLength(0);
  });

  it('does not escalate an alerting monitor with healthy telemetry', async () => {
    const { workflow } = await build(INC_011, 'scripted');
    const result = await workflow.run(input);

    expect(result.stage).toBe('not_escalated');
    expect(result.alert!.rationale).toMatch(/more likely a monitor problem/);
    expect(server.current.issues).toHaveLength(0);
  });

  it('will not verify recovery for a pull request that was never merged', async () => {
    const { workflow } = await build(INC_001, 'scripted');
    const first = await workflow.run(input);

    const after = await workflow.completeAfterMerge({
      ...input,
      pullRequestNumber: first.pullRequest!.number,
      slackThread: { id: server.current.messages[0]!.ts, channel: '#incidents' },
      issueKey: first.issue!.key,
      alert: first.alert!,
      rootCause: first.patch!.rootCause,
      baselineWindow: { from: new Date('2026-09-13T14:00:00Z'), to: new Date('2026-09-13T14:30:59Z') },
      incidentWindow: { from: new Date('2026-09-13T14:31:00Z'), to: new Date('2026-09-13T14:50:00Z') },
      postRemediationWindow: { from: new Date('2026-09-13T14:50:00Z'), to: new Date('2026-09-13T15:00:00Z') },
    });

    expect(after.haltReason).toMatch(/is open, not merged/);
    expect(after.recovery).toBeNull();
    expect(server.current.emails).toHaveLength(0);
  });

  it('keeps the incident open and sends nothing when signals have not recovered', async () => {
    const { workflow } = await build(INC_001, 'scripted');
    const first = await workflow.run(input);

    const repo = server.current.repositories.get('acme/checkout-api')!;
    const pr = repo.pullRequests.find((p) => p.number === first.pullRequest!.number)!;
    pr.merged = true;
    pr.state = 'closed';

    // Telemetry is left as-is: still broken.
    const after = await workflow.completeAfterMerge({
      ...input,
      pullRequestNumber: pr.number,
      slackThread: { id: server.current.messages[0]!.ts, channel: '#incidents' },
      issueKey: first.issue!.key,
      alert: first.alert!,
      rootCause: first.patch!.rootCause,
      baselineWindow: { from: new Date('2026-09-13T14:00:00Z'), to: new Date('2026-09-13T14:30:59Z') },
      incidentWindow: { from: new Date('2026-09-13T14:31:00Z'), to: new Date('2026-09-13T14:50:00Z') },
      postRemediationWindow: { from: new Date('2026-09-13T14:50:00Z'), to: new Date('2026-09-13T15:00:00Z') },
    });

    expect(after.recovery!.recovered).toBe(false);
    expect(after.haltReason).toMatch(/remains open/);
    // No write-up and no email: there is nothing settled to report.
    expect(after.writeUpUrl).toBeNull();
    expect(server.current.emails).toHaveLength(0);
  });
});

describe('telemetry windows', () => {
  const onset = new Date('2026-09-13T14:32:00Z');

  it('stops the baseline a guard band before the observed onset', () => {
    // A monitor lags its onset, and logs are sampled while metrics are continuous,
    // so the first observed error is only an upper bound on when things broke.
    const [baseline, observation] = telemetryWindowsFor(onset);
    expect(baseline.to.toISOString()).toBe('2026-09-13T14:28:59.999Z');
    expect(observation.from.toISOString()).toBe('2026-09-13T14:32:00.000Z');
  });

  it('never lets the windows overlap', () => {
    const [baseline, observation] = telemetryWindowsFor(onset);
    expect(baseline.to.getTime()).toBeLessThan(observation.from.getTime());
  });

  it('keeps a full-length baseline despite the guard band', () => {
    const [baseline] = telemetryWindowsFor(onset);
    const minutes = (baseline.to.getTime() - baseline.from.getTime()) / 60_000;
    expect(Math.round(minutes)).toBe(TELEMETRY_WINDOW_MINUTES);
  });
});
