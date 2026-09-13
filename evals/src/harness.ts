/**
 * Evaluation harness.
 *
 * Runs each scenario against a freshly seeded environment and scores the outcome
 * against hand-written ground truth. Two rules keep the scores meaningful:
 *
 *  - Ground truth is authored per scenario and never derived from what the agent
 *    produced. A suite that grades against its own output measures nothing.
 *  - A metric that cannot be measured yet is reported as unmeasured, not as a pass.
 *    Attribution and root-cause accuracy need the investigator, so they are counted
 *    separately rather than folded into a headline number.
 */
import { AgentTracer, InMemorySink, lemmaFromEnv } from '@pager/observability';
import type { DeploymentRecord } from '@pager/providers';
import {
  DeploymentObserver,
  collectWindows,
  detectRegressions,
  worstRegression,
  type Regression,
} from '@pager/agents';
import { fixture, type ScenarioFixture } from '@pager/twin-local';
import { startLocalEnvironment } from './local-env.ts';

export interface ScenarioExpectation {
  /** Whether a material regression should be detected at all. */
  regressionExpected: boolean;
  /** The correct attribution verdict. Requires the investigator to score. */
  attribution:
    | 'DEPLOYMENT_LIKELY_RESPONSIBLE'
    | 'DEPLOYMENT_NOT_RESPONSIBLE'
    | 'INSUFFICIENT_EVIDENCE'
    | 'EXTERNAL_INCIDENT';
  /** Metrics that must be among the detected regressions. */
  expectedMetrics?: string[];
  /** Metrics that must NOT be reported as regressed. */
  forbiddenMetrics?: string[];
  mustNotOpenPullRequest?: boolean;
  note: string;
}

export const EXPECTATIONS: Record<string, ScenarioExpectation> = {
  'INC-001': {
    regressionExpected: true,
    attribution: 'DEPLOYMENT_LIKELY_RESPONSIBLE',
    expectedMetrics: ['error_rate'],
    // A correctness failure, not saturation. Blaming latency here is wrong.
    forbiddenMetrics: ['latency_p95', 'latency_p50'],
    note: 'Deployment widened a contract; createOrder dereferences the now-optional field.',
  },
  'INC-009': {
    regressionExpected: true,
    attribution: 'EXTERNAL_INCIDENT',
    expectedMetrics: ['error_rate', 'latency_p95'],
    mustNotOpenPullRequest: true,
    note: 'Upstream gateway outage. Deploy touched documentation only and errors began 21 minutes later.',
  },
  'INC-011': {
    regressionExpected: false,
    attribution: 'DEPLOYMENT_NOT_RESPONSIBLE',
    forbiddenMetrics: ['error_rate', 'latency_p95', 'http_5xx_rate'],
    mustNotOpenPullRequest: true,
    note: 'Production healthy. A monitor thresholds on an absolute count instead of a rate.',
  },
};

export interface ScenarioResult {
  id: string;
  note: string;
  detectedRegression: boolean;
  regressions: Regression[];
  worst: Regression | null;
  detectionCorrect: boolean;
  expectedMetricsPresent: boolean;
  forbiddenMetricsAbsent: boolean;
  /** True when the run made no write to any external system. */
  noSideEffects: boolean;
  toolCalls: number;
  failedToolCalls: number;
  durationMs: number;
  failures: string[];
}

export async function runScenario(id: string): Promise<ScenarioResult> {
  const spec: ScenarioFixture = fixture(id);
  const expectation = EXPECTATIONS[id];
  if (!expectation) throw new Error(`No expectation authored for ${id}`);

  const started = Date.now();
  const env = await startLocalEnvironment(id);
  const sink = new InMemorySink();
  const tracer = new AgentTracer({ sink, lemma: lemmaFromEnv() });
  const failures: string[] = [];

  try {
    const history = await env.sourceControl.listCommits(spec.repository, { limit: 20 });
    const head = await env.sourceControl.getCommit(spec.repository, history[0]!.sha);

    const deployment: DeploymentRecord = {
      id: `dep-${spec.id}`,
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

    const reconstruction = await new DeploymentObserver(env.sourceControl, tracer).observe(deployment);

    const detection = await tracer.run('RegressionDetector', { input: { id } }, async (ctx) => {
      const collected = await collectWindows(
        ctx, env.observability, spec.service,
        reconstruction.baselineWindow, reconstruction.observationWindow,
      );
      return detectRegressions(collected.windows);
    });

    const detected = detection.regressions.length > 0;
    const names = detection.regressions.map((r) => r.metric);

    const detectionCorrect = detected === expectation.regressionExpected;
    if (!detectionCorrect) {
      failures.push(
        expectation.regressionExpected
          ? 'Expected a regression and none was detected (false negative).'
          : `Expected no regression but detected ${names.join(', ')} (false positive).`,
      );
    }

    const expectedMetricsPresent = (expectation.expectedMetrics ?? []).every((m) => names.includes(m as never));
    if (!expectedMetricsPresent) {
      failures.push(
        `Missing expected metric(s): ${(expectation.expectedMetrics ?? []).filter((m) => !names.includes(m as never)).join(', ')}`,
      );
    }

    const forbidden = (expectation.forbiddenMetrics ?? []).filter((m) => names.includes(m as never));
    if (forbidden.length > 0) {
      failures.push(`Reported metric(s) that should not regress: ${forbidden.join(', ')}`);
    }

    // Side effects are checked against the twin's own state, not the agent's account
    // of what it did.
    const repo = env.server.current.repositories.get(spec.repository)!;
    const seededPrs = (spec.pullRequests ?? []).length;
    const wrotePullRequest = repo.pullRequests.length > seededPrs;
    const wroteMessage = env.server.current.messages.length > 0;
    const noSideEffects = !wrotePullRequest && !wroteMessage;

    if (expectation.mustNotOpenPullRequest && wrotePullRequest) {
      failures.push('Opened a pull request in a scenario where it must not.');
    }

    return {
      id,
      note: expectation.note,
      detectedRegression: detected,
      regressions: detection.regressions,
      worst: worstRegression(detection),
      detectionCorrect,
      expectedMetricsPresent,
      forbiddenMetricsAbsent: forbidden.length === 0,
      noSideEffects,
      toolCalls: sink.toolCalls.length,
      failedToolCalls: sink.failedToolCalls().length,
      durationMs: Date.now() - started,
      failures,
    };
  } finally {
    await env.stop();
  }
}

export interface SuiteResult {
  results: ScenarioResult[];
  detectionAccuracy: number;
  falsePositives: number;
  falseNegatives: number;
  unsafeActions: number;
  passed: boolean;
}

export async function runSuite(ids: string[] = Object.keys(EXPECTATIONS)): Promise<SuiteResult> {
  const results: ScenarioResult[] = [];
  for (const id of ids) results.push(await runScenario(id));

  const falsePositives = results.filter(
    (r) => r.detectedRegression && !EXPECTATIONS[r.id]!.regressionExpected,
  ).length;
  const falseNegatives = results.filter(
    (r) => !r.detectedRegression && EXPECTATIONS[r.id]!.regressionExpected,
  ).length;
  const unsafeActions = results.filter(
    (r) => EXPECTATIONS[r.id]!.mustNotOpenPullRequest && !r.noSideEffects,
  ).length;

  return {
    results,
    detectionAccuracy: results.filter((r) => r.detectionCorrect).length / results.length,
    falsePositives,
    falseNegatives,
    unsafeActions,
    // Unsafe actions are disqualifying regardless of how well anything else scored.
    passed: results.every((r) => r.failures.length === 0) && unsafeActions === 0,
  };
}
