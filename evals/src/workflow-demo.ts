/**
 * The full incident workflow, end to end, against local twins.
 *
 *   Datadog alert → identify → Jira → Slack → fix on GitHub → PR
 *   → human merges → re-watch Datadog → Notion write-up → team email
 *
 * The patch and regression test come from a SCRIPTED generator, clearly labelled as
 * such everywhere they appear. That exercises the pipeline around code authorship
 * without pretending an agent reasoned its way to the fix — authorship is the one
 * step that needs a model, and no model is configured.
 *
 * Usage: pnpm demo:workflow
 */
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
import { AgentTracer, InMemorySink, lemmaFromEnv } from '@pager/observability';
import { IncidentWorkflow, ScriptedPatchGenerator } from '@pager/agents';
import { INC_001, LocalTwinServer, seedFromFixture } from '@pager/twin-local';

const rule = (t: string) => console.log(`\n${'━'.repeat(78)}\n  ${t}\n${'━'.repeat(78)}`);

/** The regression test a model would be asked to write. */
const REGRESSION_TEST = `import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CheckoutService } from '../src/checkout/service.ts';

describe('INC regression', () => {
  it('creates an order when no discount code is supplied', () => {
    const order = new CheckoutService().createOrder({
      customerId: 'cus_9',
      items: [{ sku: 'A', quantity: 1, unitPriceCents: 1000 }],
    });
    assert.equal(order.discountCents, 0);
    assert.equal(order.totalCents, 1000);
    assert.equal(order.appliedCode, null);
  });
});
`;

const PATCHED_SERVICE = `import type { OrderRequest } from './types.ts';

export interface Order {
  customerId: string;
  subtotalCents: number;
  discountCents: number;
  totalCents: number;
  appliedCode: string | null;
}

export class CheckoutService {
  createOrder(request: OrderRequest): Order {
    const subtotalCents = request.items.reduce(
      (sum, item) => sum + item.unitPriceCents * item.quantity,
      0,
    );

    const code = request.discountCode ?? null;
    const discountCents = code ? Math.round(subtotalCents * (code.percentOff / 100)) : 0;

    return {
      customerId: request.customerId,
      subtotalCents,
      discountCents,
      totalCents: subtotalCents - discountCents,
      appliedCode: code ? code.value : null,
    };
  }
}
`;

async function main(): Promise<void> {
  const spec = INC_001;
  const server = new LocalTwinServer({ now: () => Date.parse('2026-09-13T14:45:00Z') });
  server.seed(seedFromFixture(spec));
  const endpoints = await server.start();

  const creds = await registerViaManifest(endpoints.github, PAGER_APP_MANIFEST(endpoints.github));
  const tokens = new GitHubAppTokenSource(endpoints.github, creds);

  const sink = new InMemorySink();
  const workflow = new IncidentWorkflow({
    observability: new DatadogProvider({ baseUrl: endpoints.datadog }),
    sourceControl: new GitHubProvider({ baseUrl: endpoints.github, tokenProvider: () => tokens.token() }),
    messaging: new SlackProvider({ baseUrl: endpoints.slack }),
    issueTracker: new JiraProvider({ baseUrl: endpoints.jira, projectKey: 'INC', siteUrl: 'https://acme.atlassian.net' }),
    knowledge: new NotionProvider({ baseUrl: endpoints.notion, token: 't', parentPageId: 'runbook-checkout' }),
    email: new ResendProvider({ baseUrl: endpoints.resend, apiKey: 're_test', from: 'pager@acme.dev' }),
    tracer: new AgentTracer({ sink, lemma: lemmaFromEnv() }),
    patchGenerator: new ScriptedPatchGenerator({
      regressionTest: { path: 'test/regression-inc.test.ts', source: REGRESSION_TEST },
      patch: {
        rootCause:
          'createOrder dereferenced request.discountCode without a null check after PR #377 ' +
          'widened the field to optional.',
        explanation: 'Guard the optional discount code instead of dereferencing it.',
        files: [{ path: 'src/checkout/service.ts', content: PATCHED_SERVICE }],
        risks: ['Touches a contract shared with the storefront.'],
        rollbackPlan: 'Revert the merge commit. checkout-api holds no migration state.',
        confidence: 0.91,
      },
    }),
  });

  rule('Pager Developer — full incident workflow (local twins)');

  const result = await workflow.run({
    service: spec.service,
    repository: spec.repository,
    slackChannel: '#incidents',
    incidentKey: 'INC-184',
    teamEmails: ['payments-team@acme.dev'],
  });

  for (const s of result.steps) {
    console.log(`  ${s.stage.padEnd(20)} ${s.summary}`);
  }

  if (result.haltReason) {
    rule(`Halted: ${result.haltReason}`);
    await server.stop();
    return;
  }

  // ── The human step ───────────────────────────────────────────────────────
  rule('Human merges the pull request');
  const pr = result.pullRequest!;
  const repo = server.current.repositories.get(spec.repository)!;
  const stored = repo.pullRequests.find((p) => p.number === pr.number)!;
  stored.state = 'closed';
  stored.merged = true;
  stored.mergeCommitSha = stored.headSha;
  console.log(`  #${pr.number} merged by a human. Pager did not merge it.`);

  // ── Resume ───────────────────────────────────────────────────────────────
  rule('Pager resumes: re-watch Datadog, write up, mail the team');

  // Production has recovered since the fix shipped.
  const recovered = seedFromFixture({
    ...spec,
    metrics: spec.metrics.map((m) =>
      m.metric === 'error_rate' || m.metric === 'http_5xx_rate'
        ? { ...m, after: m.baseline }
        : m,
    ),
    monitors: (spec.monitors ?? []).map((m) => ({ ...m, state: 'OK' as const })),
  });
  server.current.metrics = recovered.metrics;
  server.current.monitors = recovered.monitors;

  const after = await workflow.completeAfterMerge({
    service: spec.service,
    repository: spec.repository,
    slackChannel: '#incidents',
    teamEmails: ['payments-team@acme.dev'],
    incidentKey: 'INC-184',
    pullRequestNumber: pr.number,
    slackThread: { id: server.current.messages[0]!.ts, channel: '#incidents' },
    issueKey: result.issue?.key ?? null,
    alert: result.alert!,
    rootCause: result.patch!.rootCause,
    baselineWindow: { from: new Date('2026-09-13T14:00:00Z'), to: new Date('2026-09-13T14:30:59Z') },
    incidentWindow: { from: new Date('2026-09-13T14:31:00Z'), to: new Date('2026-09-13T14:50:00Z') },
    postRemediationWindow: { from: new Date('2026-09-13T14:50:00Z'), to: new Date('2026-09-13T15:00:00Z') },
  });

  for (const s of after.steps) console.log(`  ${s.stage.padEnd(20)} ${s.summary}`);

  // ── What actually landed in each system ──────────────────────────────────
  rule('Side effects, read back from the twins');
  const state = server.current;
  console.log(`  Jira      ${state.issues.map((i) => `${i.key} [${i.status}] ${i.title}`).join('\n            ')}`);
  console.log(`  GitHub    PR #${pr.number} ${stored.merged ? 'merged' : stored.state}, branch ${stored.headRef}`);
  console.log(`  Slack     ${state.messages.length} messages in #incidents`);
  console.log(`  Notion    ${state.pages.length} pages (${state.pages.at(-1)!.title})`);
  console.log(`  Email     ${state.emails.length} sent → ${state.emails.map((e) => e.to.join(', ')).join('; ')}`);

  rule('Agent activity');
  const byAgent = new Map<string, number>();
  for (const c of sink.toolCalls) byAgent.set(c.toolName, (byAgent.get(c.toolName) ?? 0) + 1);
  console.log(`  ${sink.agentRuns.size} agent runs, ${sink.toolCalls.length} tool calls, ${sink.failedToolCalls().length} failed`);
  for (const [tool, n] of [...byAgent].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(n).padStart(3)}  ${tool}`);
  }

  console.log(`\n  Patch authored by: ${result.patch!.kind.toUpperCase()} (no model configured)\n`);
  await server.stop();
}

void main().catch((err) => {
  console.error(`\nFAILED: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exitCode = 1;
});
