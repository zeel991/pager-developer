/**
 * The full incident workflow, end to end, against local twins.
 *
 *   Datadog alert → establish the deployed revision → investigate (Datadog logs and
 *   metrics, GitHub code and diff, Notion runbooks) → Jira → Slack → regression test
 *   → patch → verify → PR → human merges → re-watch Datadog → Notion write-up
 *
 * Authorship comes from a real model when ANTHROPIC_API_KEY is set, and from a
 * SCRIPTED generator otherwise. Which one ran is printed, and carried on every
 * artefact as `kind`, because presenting a fixture as though an agent had reasoned
 * its way there would be a lie the product tells about itself.
 *
 * The merge and the recovery at the end are SIMULATED by this script — there is no
 * real person and no real deploy here — and both are labelled as such.
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
import type { DeploymentRecord } from '@pager/providers';
import { AgentTracer, InMemorySink, lemmaFromEnv } from '@pager/observability';
import {
  IncidentInvestigator,
  IncidentWorkflow,
  ModelPatchGenerator,
  ScriptedPatchGenerator,
  describeModelAvailability,
  modelFromEnv,
  type PatchGenerator,
} from '@pager/agents';
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
  const tracer = new AgentTracer({ sink, lemma: lemmaFromEnv() });
  const observability = new DatadogProvider({ baseUrl: endpoints.datadog });
  const sourceControl = new GitHubProvider({ baseUrl: endpoints.github, tokenProvider: () => tokens.token() });
  const knowledge = new NotionProvider({ baseUrl: endpoints.notion, token: 't', parentPageId: 'runbook-checkout' });

  // Authorship: a real model if one is configured, a fixture otherwise. Never both,
  // and never silently.
  const availability = describeModelAvailability();
  const model = modelFromEnv();
  const patchGenerator: PatchGenerator = model
    ? new ModelPatchGenerator({ model, tracer })
    : new ScriptedPatchGenerator({
        regressionTest: {
          path: 'test/regression-inc.test.ts',
          source: REGRESSION_TEST,
          expectedFailureMarkers: ['TypeError', "reading 'percentOff'"],
          expectedFailureDescription: 'Checkout succeeds when no discount code is supplied.',
        },
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
      });

  const workflow = new IncidentWorkflow({
    observability,
    sourceControl,
    messaging: new SlackProvider({ baseUrl: endpoints.slack }),
    issueTracker: new JiraProvider({ baseUrl: endpoints.jira, projectKey: 'INC', siteUrl: 'https://acme.atlassian.net' }),
    knowledge,
    email: new ResendProvider({ baseUrl: endpoints.resend, apiKey: 're_test', from: 'pager@acme.dev' }),
    tracer,
    patchGenerator,
    investigator: model
      ? new IncidentInvestigator({ model, tracer, providers: { observability, sourceControl, knowledge } })
      : null,
  });

  rule('Pager Developer — full incident workflow (local twins)');
  console.log(`  Connections   github/datadog/slack/jira/notion → LOCAL twins on 127.0.0.1`);
  console.log(`  Model         ${availability.available ? `${availability.model} (LIVE)` : `none — ${availability.reason}`}`);
  console.log(`  Authorship    ${model ? 'model-authored regression test and patch' : 'SCRIPTED fixture, no reasoning happened'}`);

  // What production is running, from deployment evidence. The workflow refuses to
  // substitute the head of the base branch, so this is not optional.
  // The previously deployed revision is the deployed commit's FIRST PARENT, not the
  // previous entry in the log — that entry is the feature commit the merge brought
  // in, and diffing against it is empty.
  const tip = await sourceControl.listCommits(spec.repository, { limit: 1 });
  const head = await sourceControl.getCommit(spec.repository, tip[0]!.sha);
  const deployment: DeploymentRecord = {
    id: 'dep-inc-184',
    service: spec.service,
    environment: 'production',
    commitSha: head.sha,
    previousCommitSha: head.parents[0] ?? null,
    status: 'succeeded',
    startedAt: new Date(Date.parse(spec.deployedAt) - 120_000),
    deployedAt: new Date(spec.deployedAt),
    author: head.authorName,
    repositoryFullName: spec.repository,
  };
  console.log(`  Deployed rev  ${deployment.commitSha.slice(0, 12)} (from the deployment record, not the branch head)\n`);

  const result = await workflow.run({
    service: spec.service,
    repository: spec.repository,
    slackChannel: '#incidents',
    incidentKey: 'INC-184',
    teamEmails: ['payments-team@acme.dev'],
    deployment,
  });

  for (const s of result.steps) {
    console.log(`  ${s.stage.padEnd(20)} ${s.summary}`);
  }

  if (result.investigation) {
    rule('Investigation');
    const inv = result.investigation;
    console.log(`  Model         ${inv.model}`);
    console.log(`  Tool calls    ${inv.toolCallCount} (${inv.failedToolCalls} failed) across ${inv.modelCalls.length} model call(s)`);
    console.log(`  Tokens        ${inv.totalInputTokens ?? 'not reported'} in / ${inv.totalOutputTokens ?? 'not reported'} out`);
    console.log(`  Duration      ${(inv.durationMs / 1000).toFixed(1)}s`);
    if (inv.findings) {
      console.log(`\n  MODEL CONCLUSION (an inference, not an observation)`);
      console.log(`    diagnosis    ${inv.findings.diagnosis}`);
      console.log(`    attribution  ${inv.findings.attribution.verdict} — ${inv.findings.attribution.rationale}`);
      console.log(`    unknown      ${inv.findings.uncertainty}`);
      console.log(`    decision     ${inv.findings.decision.action} — ${inv.findings.decision.reason}`);
      console.log(`\n  CITED OBSERVATIONS (each id was minted by the tracer for a call that ran)`);
      for (const ev of inv.findings.evidence) console.log(`    ${ev.toolCallId}  ${ev.shows}`);
    } else {
      console.log(`  No conclusion: ${inv.abandonedReason}`);
    }
  }

  if (result.reproduction) {
    rule('Reproduction — observed, not claimed');
    console.log(`  Command       ${result.reproduction.command}`);
    console.log(`  Before patch  exit ${result.reproduction.beforeFix.exitCode}`);
    console.log(`  After patch   exit ${result.reproduction.afterFix?.exitCode ?? 'n/a'}`);
    console.log(`  Evidence      ${result.reproduction.assertionEvidence.problems.length === 0 ? 'assertion verified' : result.reproduction.assertionEvidence.problems.join('; ')}`);
  }

  if (result.haltReason) {
    rule(`Halted: ${result.haltReason}`);
    await server.stop();
    return;
  }

  // ── The human step ───────────────────────────────────────────────────────
  rule('SIMULATED: a human merges the pull request');
  console.log('  This script performs the merge by writing to the twin. There is no real');
  console.log('  reviewer here. Pager Developer cannot merge and did not merge.');
  const pr = result.pullRequest!;
  const repo = server.current.repositories.get(spec.repository)!;
  const stored = repo.pullRequests.find((p) => p.number === pr.number)!;
  stored.state = 'closed';
  stored.merged = true;
  stored.mergeCommitSha = stored.headSha;
  console.log(`  #${pr.number} merged by a human. Pager did not merge it.`);

  // ── Resume ───────────────────────────────────────────────────────────────
  rule('Pager resumes: re-watch Datadog, write up, mail the team');
  console.log('  SIMULATED: the recovered telemetry below is written into the twin by this');
  console.log('  script. The recovery VERDICT is real — it is computed from those series by');
  console.log('  the same RecoveryVerifier that would read a real Datadog.\n');

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

  console.log(
    `\n  Patch authored by: ${result.patch!.kind.toUpperCase()}` +
      (result.patch!.kind === 'model' ? ` (${result.investigation?.model ?? availability.model})` : ' (no model configured — this is a fixture, not reasoning)') +
      `\n`,
  );
  await server.stop();
}

void main().catch((err) => {
  console.error(`\nFAILED: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exitCode = 1;
});
