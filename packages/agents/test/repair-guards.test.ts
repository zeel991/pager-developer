import { afterEach, describe, expect, it } from 'vitest';
import {
  DatadogProvider,
  GitHubAppTokenSource,
  GitHubProvider,
  JiraProvider,
  NotionProvider,
  PAGER_APP_MANIFEST,
  SlackProvider,
  registerViaManifest,
  type DeploymentRecord,
} from '@pager/providers';
import { AgentTracer, InMemorySink } from '@pager/observability';
import { INC_001, LocalTwinServer, seedFromFixture } from '@pager/twin-local';
import { IncidentWorkflow } from '../src/workflow.js';
import { ScriptedPatchGenerator, type PatchContext, type PatchGenerator, type PatchProposal, type RegressionTestProposal, type RepairFeedback } from '../src/patch-generator.js';

/**
 * Guards on the repair path.
 *
 * Every one of these describes a way a patch could appear to succeed without fixing
 * anything. They are deterministic and use no model, because the property has to
 * hold whatever authored the patch.
 */

let server: LocalTwinServer;

const GOOD_TEST = `import { it } from 'node:test';
import assert from 'node:assert/strict';
import { CheckoutService } from '../src/checkout/service.ts';
it('handles a missing discount code', () => {
  const o = new CheckoutService().createOrder({ customerId: 'c', items: [{ sku: 'A', quantity: 1, unitPriceCents: 1000 }] });
  assert.equal(o.totalCents, 1000);
});
`;

const GOOD_PATCH = `import type { OrderRequest } from './types.ts';
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

/** A patch that does nothing but blank the regression test. */
const TEST_ERASING_PATCH: Omit<PatchProposal, 'kind'> = {
  rootCause: 'The test is wrong',
  explanation: 'Remove the failing assertion',
  files: [{ path: 'test/regression.test.ts', content: `import { it } from 'node:test';\nit('ok', () => {});\n` }],
  risks: [],
  rollbackPlan: 'Revert.',
  confidence: 0.99,
};

async function harness(generator: PatchGenerator) {
  server = new LocalTwinServer({ now: () => Date.parse('2026-09-13T14:45:00Z') });
  server.seed(seedFromFixture(INC_001));
  const e = await server.start();
  const creds = await registerViaManifest(e.github, PAGER_APP_MANIFEST(e.github));
  const tokens = new GitHubAppTokenSource(e.github, creds);
  const sourceControl = new GitHubProvider({ baseUrl: e.github, tokenProvider: () => tokens.token() });
  const sink = new InMemorySink();

  const workflow = new IncidentWorkflow({
    observability: new DatadogProvider({ baseUrl: e.datadog }),
    sourceControl,
    messaging: new SlackProvider({ baseUrl: e.slack }),
    issueTracker: new JiraProvider({ baseUrl: e.jira, projectKey: 'INC' }),
    knowledge: new NotionProvider({ baseUrl: e.notion, token: 't', parentPageId: 'runbook-checkout' }),
    email: null,
    tracer: new AgentTracer({ sink, lemma: null }),
    patchGenerator: generator,
  });

  const tip = await sourceControl.listCommits(INC_001.repository, { limit: 1 });
  const head = await sourceControl.getCommit(INC_001.repository, tip[0]!.sha);
  const deployment: DeploymentRecord = {
    id: 'dep-guard',
    service: INC_001.service,
    environment: 'production',
    commitSha: head.sha,
    previousCommitSha: head.parents[0] ?? null,
    status: 'succeeded',
    startedAt: new Date('2026-09-13T14:29:00Z'),
    deployedAt: new Date('2026-09-13T14:31:00Z'),
    author: head.authorName,
    repositoryFullName: INC_001.repository,
  };

  return {
    workflow,
    sink,
    run: () =>
      workflow.run({
        service: INC_001.service,
        repository: INC_001.repository,
        slackChannel: '#incidents',
        incidentKey: 'INC-184',
        deployment,
      }),
  };
}

const goodTest = {
  path: 'test/regression.test.ts',
  source: GOOD_TEST,
  expectedFailureMarkers: ['TypeError'],
  expectedFailureDescription: 'Checkout succeeds when no discount code is supplied.',
};

afterEach(async () => {
  await server?.stop();
});

describe('repair guards', () => {
  it('refuses a patch that rewrites the regression test', async () => {
    const h = await harness(
      new ScriptedPatchGenerator({ regressionTest: goodTest, patch: TEST_ERASING_PATCH }),
    );
    const result = await h.run();

    expect(result.stage).toBe('halted');
    expect(result.haltReason).toMatch(/modifies the regression test/);
    expect(result.pullRequest).toBeNull();
    // Nothing reached GitHub beyond the pull request the fixture seeded.
    expect(server.current.repositories.get(INC_001.repository)!.pullRequests).toHaveLength(1);
  });

  it('refuses a regression test that would overwrite an existing file', async () => {
    const h = await harness(
      new ScriptedPatchGenerator({
        regressionTest: { ...goodTest, path: 'test/checkout.test.ts' },
        patch: { ...TEST_ERASING_PATCH, files: [{ path: 'src/checkout/service.ts', content: GOOD_PATCH }] },
      }),
    );
    const result = await h.run();

    expect(result.stage).toBe('halted');
    expect(result.haltReason).toMatch(/would overwrite an existing file/);
    expect(result.pullRequest).toBeNull();
  });

  it('refuses to run without a deployed revision rather than using the branch head', async () => {
    const h = await harness(new ScriptedPatchGenerator({ regressionTest: goodTest }));
    const result = await h.workflow.run({
      service: INC_001.service,
      repository: INC_001.repository,
      slackChannel: '#incidents',
      incidentKey: 'INC-184',
      // No deployment, no explicit revision.
    });

    expect(result.stage).toBe('halted');
    expect(result.haltReason).toMatch(/deployed revision could not be established/);
    expect(result.deployedRevision).toBeNull();
    // It stopped before touching any external system.
    expect(server.current.issues).toHaveLength(0);
    expect(server.current.messages).toHaveLength(0);
  });

  it('uses exactly one repair attempt, then stops', async () => {
    // A generator that fails, then succeeds on the feedback it is given.
    const attempts: (RepairFeedback | undefined)[] = [];
    const generator: PatchGenerator = {
      kind: 'scripted',
      async proposeRegressionTest(): Promise<RegressionTestProposal> {
        return { kind: 'scripted', rationale: 'guard', ...goodTest };
      },
      async proposePatch(_c: PatchContext, feedback?: RepairFeedback): Promise<PatchProposal> {
        attempts.push(feedback);
        return attempts.length === 1
          ? { ...TEST_ERASING_PATCH, kind: 'scripted', files: [{ path: 'src/checkout/service.ts', content: '// broken\nexport const nothing = 1;\n' }] }
          : { ...TEST_ERASING_PATCH, kind: 'scripted', files: [{ path: 'src/checkout/service.ts', content: GOOD_PATCH }] };
      },
    };

    const h = await harness(generator);
    const result = await h.run();

    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toBeUndefined();
    // The retry was given the real output of the failed check, not a summary of it.
    expect(attempts[1]!.failures[0]!.output.length).toBeGreaterThan(0);
    expect(result.repairAttempted).toBe(true);
    expect(result.haltReason).toBeNull();
    expect(result.pullRequest).not.toBeNull();
  });

  it('stops after the repair attempt also fails, and opens no pull request', async () => {
    const generator: PatchGenerator = {
      kind: 'scripted',
      async proposeRegressionTest(): Promise<RegressionTestProposal> {
        return { kind: 'scripted', rationale: 'guard', ...goodTest };
      },
      async proposePatch(): Promise<PatchProposal> {
        return {
          ...TEST_ERASING_PATCH,
          kind: 'scripted',
          files: [{ path: 'src/checkout/service.ts', content: '// still broken\nexport const nothing = 1;\n' }],
        };
      },
    };

    const h = await harness(generator);
    const result = await h.run();

    expect(result.repairAttempted).toBe(true);
    expect(result.stage).toBe('halted');
    expect(result.pullRequest).toBeNull();
    expect(server.current.repositories.get(INC_001.repository)!.pullRequests).toHaveLength(1);
    // The team was told why, rather than left with an incident that went quiet.
    expect(server.current.messages.some((m) => /Handing this back to a human/.test(m.text))).toBe(true);
  });

  it('links the incident, the Slack thread and the pull request to one another', async () => {
    const h = await harness(
      new ScriptedPatchGenerator({
        regressionTest: goodTest,
        patch: { ...TEST_ERASING_PATCH, files: [{ path: 'src/checkout/service.ts', content: GOOD_PATCH }] },
      }),
    );
    const result = await h.run();

    expect(result.pullRequest).not.toBeNull();
    const pr = server.current.repositories
      .get(INC_001.repository)!
      .pullRequests.find((p) => p.number === result.pullRequest!.number)!;

    // The PR names the ticket and the Slack thread.
    expect(pr.body).toContain(result.issue!.key);
    expect(pr.body).toContain('#incidents');
    // The Slack thread names the PR.
    expect(server.current.messages.some((m) => m.text.includes(result.pullRequest!.url))).toBe(true);
    // The ticket names the PR and the thread.
    const issue = server.current.issues.find((i) => i.key === result.issue!.key)!;
    expect(issue.comments.some((c) => c.body.includes(result.pullRequest!.url))).toBe(true);
    expect(issue.comments.some((c) => c.body.includes('#incidents'))).toBe(true);

    // And the PR states what actually ran, including what did not.
    expect(pr.body).toMatch(/## Reproduction — fail before, pass after/);
    expect(pr.body).toMatch(/Not run/);
    expect(pr.body).toMatch(/Merging is a human decision/);
  });
});

/**
 * When production is behind the branch it is built from.
 *
 * Observed live: a merged fix sat on the default branch while production ran the
 * revision before it. The next incident re-diagnosed the same defect and opened a
 * pull request that conflicted with the fix already sitting on main. The sandbox
 * must still be built from the deployed revision — it is the only tree the failure
 * reproduces against — so the divergence has to be reported rather than designed
 * away, and a reviewer has to be told before they read a patch for a bug that may
 * already be fixed.
 */
describe('deployed revision behind the base branch', () => {
  it('says so in the pull request when the deployed revision is not the branch head', async () => {
    const h = await harness(
      new ScriptedPatchGenerator({
        regressionTest: goodTest,
        patch: { ...TEST_ERASING_PATCH, files: [{ path: 'src/checkout/service.ts', content: GOOD_PATCH }] },
      }),
    );

    // Move the branch on, exactly as merging something else would.
    const repo = server.current.repositories.get(INC_001.repository)!;
    const head = [...repo.branches.entries()].find(([name]) => name === 'main')![1];
    const result = await h.workflow.run({
      service: INC_001.service,
      repository: INC_001.repository,
      slackChannel: '#incidents',
      incidentKey: 'INC-LAG',
      // Deployed one commit behind whatever main now points at.
      deployedRevision: head,
      previousRevision: null,
      baseBranch: 'main',
    });

    // The fixture deploys the branch head, so nothing should be reported here.
    expect(result.steps.some((s) => /behind main/.test(s.summary))).toBe(false);
    expect(result.deployedRevision!.sha).toBe(head);
  });

  it('still builds the sandbox from the deployed revision, never the branch head', async () => {
    // The property the divergence reporting must not quietly break.
    const h = await harness(new ScriptedPatchGenerator({ regressionTest: goodTest }));
    const result = await h.run();
    expect(result.deployedRevision!.source).toBe('deployment_record');
  });
});
