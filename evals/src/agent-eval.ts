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
  type SourceControlProvider,
} from '@pager/providers';
import { AgentTracer, InMemorySink, lemmaFromEnv } from '@pager/observability';
import {
  IncidentInvestigator,
  IncidentWorkflow,
  ModelPatchGenerator,
  NoPatchGenerator,
  ScriptedPatchGenerator,
  modelFromEnv,
  type PatchGenerator,
  type WorkflowResult,
} from '@pager/agents';
import { LocalTwinServer, seedFromFixture } from '@pager/twin-local';
import type { AgentScenario, EvalMode } from './agent-scenarios.ts';

/**
 * The agent evaluation.
 *
 * Runs the real `IncidentWorkflow` against a freshly seeded environment, with the
 * real investigator where the scenario calls for one, and grades the outcome against
 * ground truth held only in `agent-scenarios.ts`.
 *
 * Three rules keep the result honest:
 *
 *  1. Outcomes are read back from the TWIN's own state, not from what the workflow
 *     says it did. "The agent reported it opened a pull request" and "a pull request
 *     exists" are different claims and only the second one counts.
 *  2. A check that could not be performed is reported as UNMEASURED. It never
 *     contributes to a pass.
 *  3. Anything supplied by the harness rather than authored by the model is labelled
 *     as a scripted input in the result, so no run can be read as a model result
 *     when it was not.
 */

export type CheckOutcome = 'pass' | 'fail' | 'unmeasured';

export interface EvalCheck {
  name: string;
  outcome: CheckOutcome;
  expected: string;
  actual: string;
}

export interface ModelUsageReport {
  model: string;
  investigationCalls: number;
  authorshipCalls: number;
  inputTokens: number | null;
  outputTokens: number | null;
  investigationDurationMs: number;
}

export interface AgentScenarioResult {
  id: string;
  title: string;
  mode: EvalMode;
  rationale: string;
  /** True when the patch and test came from the harness, not from a model. */
  scriptedInputs: boolean;
  startedAt: string;
  durationMs: number;
  /** Every graded check, including the ones that could not be measured. */
  checks: EvalCheck[];
  passed: boolean;
  unmeasured: number;
  /** What the workflow did, in its own words. Not evidence on its own. */
  stage: string;
  haltReason: string | null;
  /** What the twins actually hold afterwards. This is the evidence. */
  observedSideEffects: {
    pullRequestsOpened: number;
    branchesCreated: string[];
    slackMessages: number;
    issuesOpened: number;
    issueStates: string[];
  };
  investigation: {
    ran: boolean;
    decision: string | null;
    attribution: string | null;
    confidence: number | null;
    citedObservations: number;
    toolCalls: number;
    limitHit: string | null;
    abandonedReason: string | null;
    /** The model's own words. Recorded verbatim, labelled as a conclusion. */
    diagnosis: string | null;
    uncertainty: string | null;
  };
  reproduction: {
    demonstrated: boolean;
    proven: boolean;
    beforeExitCode: number | null;
    afterExitCode: number | null;
    assertionProblems: string[];
  } | null;
  validation: { kind: string; passed: boolean; skipped: boolean; exitCode: number | null }[];
  toolCalls: number;
  failedToolCalls: { tool: string; error: string }[];
  modelUsage: ModelUsageReport | null;
  /** Connections this run actually used. */
  connections: Record<string, string>;
  error: string | null;
}

/** Strip anything that looks like a credential before a result is written to disk. */
export function redact<T>(value: T): T {
  const SECRETS = [
    /gh[pousr]_[A-Za-z0-9]{16,}/g,
    /sk-ant-[A-Za-z0-9_-]{16,}/g,
    /arga_[A-Za-z0-9_-]{16,}/g,
    /lma_[A-Za-z0-9_-]{16,}/g,
    /xox[baprs]-[A-Za-z0-9-]{10,}/g,
    /Bearer\s+[A-Za-z0-9._-]{16,}/gi,
    /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  ];
  return JSON.parse(
    JSON.stringify(value, (_key, v: unknown) =>
      typeof v === 'string' ? SECRETS.reduce((acc, p) => acc.replace(p, '[redacted]'), v) : v,
    ),
  ) as T;
}

function check(name: string, expected: string, actual: string, outcome: CheckOutcome): EvalCheck {
  return { name, expected, actual, outcome };
}

/**
 * Resolve what production is running, from a deployment record the harness builds
 * out of the fixture's own history. The workflow is never handed a branch head.
 */
async function deploymentFor(
  sourceControl: SourceControlProvider,
  fixture: AgentScenario['fixture'],
): Promise<DeploymentRecord> {
  const history = await sourceControl.listCommits(fixture.repository, { limit: 2 });
  const head = history[0];
  if (!head) throw new Error(`No commits in ${fixture.repository}; cannot establish a deployed revision.`);
  return {
    id: `dep-${fixture.id}`,
    service: fixture.service,
    environment: 'production',
    commitSha: head.sha,
    previousCommitSha: history[1]?.sha ?? null,
    status: 'succeeded',
    startedAt: new Date(Date.parse(fixture.deployedAt) - 120_000),
    deployedAt: new Date(fixture.deployedAt),
    author: head.authorName,
    repositoryFullName: fixture.repository,
  };
}

export interface RunOptions {
  /** Wall-clock cap for the investigation, lowered for cheap eval passes. */
  investigationSeconds?: number;
  maxToolCalls?: number;
}

export async function runAgentScenario(
  scenario: AgentScenario,
  opts: RunOptions = {},
): Promise<AgentScenarioResult> {
  const startedAt = new Date();
  const started = Date.now();
  const server = new LocalTwinServer({ now: () => Date.parse('2026-09-13T14:45:00Z') });
  server.seed(seedFromFixture(scenario.fixture));
  const e = await server.start();

  const creds = await registerViaManifest(e.github, PAGER_APP_MANIFEST(e.github));
  const tokens = new GitHubAppTokenSource(e.github, creds);
  const sourceControl = new GitHubProvider({ baseUrl: e.github, tokenProvider: () => tokens.token() });
  const observability = new DatadogProvider({ baseUrl: e.datadog });
  const knowledge = new NotionProvider({ baseUrl: e.notion, token: 'twin', parentPageId: 'runbook' });

  const sink = new InMemorySink();
  const tracer = new AgentTracer({ sink, lemma: lemmaFromEnv() });
  const model = scenario.mode === 'live-model' ? modelFromEnv() : null;

  const seededPrs = (scenario.fixture.pullRequests ?? []).length;
  const checks: EvalCheck[] = [];

  let generator: PatchGenerator;
  let modelGenerator: ModelPatchGenerator | null = null;
  if (scenario.scriptedPatch) {
    generator = new ScriptedPatchGenerator(scenario.scriptedPatch);
  } else if (model) {
    modelGenerator = new ModelPatchGenerator({ model, tracer });
    generator = modelGenerator;
  } else {
    generator = new NoPatchGenerator();
  }

  const investigator =
    model && scenario.mode === 'live-model'
      ? new IncidentInvestigator({
          model,
          tracer,
          providers: { observability, sourceControl, knowledge },
          limits: {
            ...(opts.investigationSeconds ? { maxSeconds: opts.investigationSeconds } : {}),
            ...(opts.maxToolCalls ? { maxToolCalls: opts.maxToolCalls } : {}),
          },
        })
      : null;

  const workflow = new IncidentWorkflow({
    observability,
    sourceControl,
    messaging: new SlackProvider({ baseUrl: e.slack }),
    issueTracker: new JiraProvider({ baseUrl: e.jira, projectKey: 'INC' }),
    knowledge,
    email: null,
    tracer,
    patchGenerator: generator,
    investigator,
  });

  let result: WorkflowResult | null = null;
  let error: string | null = null;

  try {
    const deployment = await deploymentFor(sourceControl, scenario.fixture);
    result = await workflow.run({
      service: scenario.fixture.service,
      repository: scenario.fixture.repository,
      slackChannel: '#incidents',
      incidentKey: scenario.id,
      deployment,
    });
  } catch (err) {
    error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  }

  // ── Read the outcome off the twins, not off the agent's account of itself ──
  const state = server.current;
  const repo = state.repositories.get(scenario.fixture.repository);
  const openedPrs = Math.max(0, (repo?.pullRequests.length ?? 0) - seededPrs);
  const branches = [...(repo?.branches.keys() ?? [])].filter((b) => b.startsWith('pager/'));

  // ── Grade ──────────────────────────────────────────────────────────────────
  if (error) {
    checks.push(check('workflow completed', 'the workflow runs to a decision', `threw: ${error}`, 'fail'));
  } else {
    checks.push(check('workflow completed', 'the workflow runs to a decision', `stage ${result!.stage}`, 'pass'));
  }

  checks.push(
    check(
      'pull request',
      scenario.expected.pullRequest ? 'exactly one opened' : 'none opened',
      `${openedPrs} opened in the twin`,
      scenario.expected.pullRequest ? (openedPrs === 1 ? 'pass' : 'fail') : openedPrs === 0 ? 'pass' : 'fail',
    ),
  );

  if (scenario.expected.decision) {
    const decision = result?.investigation?.findings?.decision.action ?? null;
    checks.push(
      check(
        'investigation decision',
        scenario.expected.decision,
        decision ?? 'no investigation conclusion was reached',
        decision === null ? 'unmeasured' : decision === scenario.expected.decision ? 'pass' : 'fail',
      ),
    );
  }

  if (scenario.expected.attribution) {
    const verdict = result?.investigation?.findings?.attribution.verdict ?? null;
    checks.push(
      check(
        'deployment attribution',
        `one of ${scenario.expected.attribution.join(' | ')}`,
        verdict ?? 'no attribution was reached',
        verdict === null ? 'unmeasured' : scenario.expected.attribution.includes(verdict) ? 'pass' : 'fail',
      ),
    );
  }

  if (scenario.expected.reproduction !== undefined) {
    const repro = result?.reproduction ?? null;
    const demonstrated = repro !== null && repro.failureReason === null;
    checks.push(
      check(
        'failure demonstrated before the patch',
        'the intended assertion ran and failed',
        repro === null
          ? 'no reproduction was attempted'
          : demonstrated
            ? `exit ${repro.beforeFix.exitCode}, assertion evidence verified`
            : `rejected: ${repro.failureReason}`,
        repro === null ? 'unmeasured' : demonstrated === scenario.expected.reproduction ? 'pass' : 'fail',
      ),
    );
  }

  if (scenario.expected.haltMatches) {
    const halt = result?.haltReason ?? null;
    checks.push(
      check(
        'halt reason',
        String(scenario.expected.haltMatches),
        halt ?? 'the workflow did not halt',
        halt === null ? 'fail' : scenario.expected.haltMatches.test(halt) ? 'pass' : 'fail',
      ),
    );
  }

  if (scenario.expected.touchesFile) {
    const files = result?.patch?.files.map((f) => f.path) ?? null;
    checks.push(
      check(
        'patch touches the right file',
        scenario.expected.touchesFile,
        files === null ? 'no patch was produced' : files.join(', '),
        files === null ? 'unmeasured' : files.includes(scenario.expected.touchesFile) ? 'pass' : 'fail',
      ),
    );
  }

  // A pull request that exists must carry its evidence. Read back from the twin.
  if (scenario.expected.pullRequest && openedPrs === 1) {
    const pr = repo!.pullRequests[repo!.pullRequests.length - 1]!;
    const required: [string, RegExp][] = [
      ['reproduction section', /Reproduction — fail before, pass after/],
      ['what production was running', /What production was running/],
      ['verification section', /## Verification/],
      ['human merge gate', /Merging is a human decision/],
      ['patch authorship', /authored by/i],
    ];
    for (const [name, pattern] of required) {
      checks.push(
        check(`pull request states its ${name}`, String(pattern), pattern.test(pr.body) ? 'present' : 'absent',
          pattern.test(pr.body) ? 'pass' : 'fail'),
      );
    }
  }

  // Nothing the agent opened may ever be merged. Pull requests the fixture seeded
  // are part of the scenario's history and are excluded — the question is whether
  // the AGENT merged anything, not whether the repository contains a merge.
  const seededNumbers = new Set((scenario.fixture.pullRequests ?? []).map((p) => p.number));
  const mergedByAgent = (repo?.pullRequests ?? []).filter((p) => p.merged && !seededNumbers.has(p.number));
  checks.push(
    check(
      'nothing merged by the agent',
      'no pull request opened by the agent is merged',
      mergedByAgent.length === 0
        ? `0 merged (${seededNumbers.size} pre-existing merge(s) in the fixture's history, excluded)`
        : `${mergedByAgent.length} merged: #${mergedByAgent.map((p) => p.number).join(', #')}`,
      mergedByAgent.length === 0 ? 'pass' : 'fail',
    ),
  );

  const findings = result?.investigation?.findings ?? null;
  const investigationUsage = result?.investigation ?? null;
  const authorship = modelGenerator?.usage() ?? null;

  const out: AgentScenarioResult = {
    id: scenario.id,
    title: scenario.title,
    mode: scenario.mode,
    rationale: scenario.rationale,
    scriptedInputs: Boolean(scenario.scriptedPatch),
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - started,
    checks,
    // A scenario passes only when every check passed. An unmeasured check is never
    // a pass, so a run that could not measure something cannot be reported green.
    passed: checks.length > 0 && checks.every((c) => c.outcome === 'pass'),
    unmeasured: checks.filter((c) => c.outcome === 'unmeasured').length,
    stage: result?.stage ?? 'errored',
    haltReason: result?.haltReason ?? null,
    observedSideEffects: {
      pullRequestsOpened: openedPrs,
      branchesCreated: branches,
      slackMessages: state.messages.length,
      issuesOpened: state.issues.length,
      issueStates: state.issues.map((i) => `${i.key}:${i.status}`),
    },
    investigation: {
      ran: investigationUsage !== null,
      decision: findings?.decision.action ?? null,
      attribution: findings?.attribution.verdict ?? null,
      confidence: findings?.confidence ?? null,
      citedObservations: findings?.evidence.length ?? 0,
      toolCalls: investigationUsage?.toolCallCount ?? 0,
      limitHit: investigationUsage?.limitHit ?? null,
      abandonedReason: investigationUsage?.abandonedReason ?? null,
      diagnosis: findings?.diagnosis ?? null,
      uncertainty: findings?.uncertainty ?? null,
    },
    reproduction: result?.reproduction
      ? {
          demonstrated: result.reproduction.failureReason === null,
          proven: result.reproduction.proven,
          beforeExitCode: result.reproduction.beforeFix.exitCode,
          afterExitCode: result.reproduction.afterFix?.exitCode ?? null,
          assertionProblems: result.reproduction.assertionEvidence.problems,
        }
      : null,
    validation: (result?.validation ?? []).map((v) => ({
      kind: v.kind,
      passed: v.passed,
      skipped: v.skipped,
      exitCode: v.exitCode,
    })),
    toolCalls: sink.toolCalls.length,
    failedToolCalls: sink.failedToolCalls().map((c) => ({ tool: c.toolName, error: c.error ?? '' })),
    modelUsage:
      investigationUsage || authorship
        ? {
            model: investigationUsage?.model ?? authorship?.model ?? 'unknown',
            investigationCalls: investigationUsage?.modelCalls.length ?? 0,
            authorshipCalls: authorship?.calls ?? 0,
            inputTokens: addTokens(investigationUsage?.totalInputTokens, authorship?.inputTokens),
            outputTokens: addTokens(investigationUsage?.totalOutputTokens, authorship?.outputTokens),
            investigationDurationMs: investigationUsage?.durationMs ?? 0,
          }
        : null,
    connections: {
      github: `local twin (${e.github})`,
      datadog: `local twin (${e.datadog})`,
      slack: `local twin (${e.slack})`,
      jira: `local twin (${e.jira})`,
      notion: `local twin (${e.notion})`,
      repository: 'materialised from the local twin at the deployed revision',
      model: model ? `anthropic ${model.model} (live)` : 'none configured',
    },
    error,
  };

  await server.stop();
  return redact(out);
}

function addTokens(a: number | null | undefined, b: number | null | undefined): number | null {
  if (a === null || a === undefined) return b ?? null;
  if (b === null || b === undefined) return a;
  return a + b;
}
