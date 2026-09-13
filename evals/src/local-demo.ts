/**
 * Phases 1–2 end to end against the local twin.
 *
 * Observe what changed, collect telemetry, decide whether production materially
 * regressed — and stop there, without attributing blame, which is Phase 3's job.
 */
import { AgentTracer, InMemorySink, lemmaFromEnv } from '@pager/observability';
import type { DeploymentRecord } from '@pager/providers';
import {
  DeploymentObserver,
  collectWindows,
  detectRegressions,
  worstRegression,
} from '@pager/agents';
import { fixture } from '@pager/twin-local';
import { startLocalEnvironment } from './local-env.ts';

const scenarioId = process.argv[2] ?? 'INC-001';

const rule = (t: string) => console.log(`\n${'─'.repeat(74)}\n${t}\n${'─'.repeat(74)}`);
const pct = (n: number) => `${(n * 100).toFixed(2)}%`;

async function main(): Promise<void> {
  const spec = fixture(scenarioId);
  rule(`${spec.id} — local twin`);

  const env = await startLocalEnvironment(scenarioId);
  const sink = new InMemorySink();
  const tracer = new AgentTracer({ sink, lemma: lemmaFromEnv() });

  try {
    // ── Phase 1 ────────────────────────────────────────────────────────────
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

    const observer = new DeploymentObserver(env.sourceControl, tracer);
    const reconstruction = await observer.observe(deployment);

    rule('Phase 1 — what changed');
    console.log(`service          ${deployment.service}`);
    console.log(`deployed         ${deployment.deployedAt?.toISOString()}  by ${deployment.author}`);
    console.log(`revision         ${deployment.previousCommitSha?.slice(0, 10)} → ${deployment.commitSha.slice(0, 10)}`);
    console.log(`pull requests    ${reconstruction.pullRequests.map((p) => `#${p.number} ${p.title}`).join(', ') || '(none)'}`);
    console.log(`changed files    ${reconstruction.changedFiles.length}`);
    for (const f of reconstruction.changedFiles) {
      console.log(`   ${f.status.padEnd(9)} ${f.path}  +${f.additions}/-${f.deletions}`);
    }
    console.log(`gaps             ${reconstruction.gaps.length ? reconstruction.gaps.join('; ') : '(none)'}`);

    // ── Phase 2 ────────────────────────────────────────────────────────────
    const detection = await tracer.run(
      'RegressionDetector',
      { input: { deploymentId: deployment.id } },
      async (ctx) => {
        const collected = await collectWindows(
          ctx,
          env.observability,
          spec.service,
          reconstruction.baselineWindow,
          reconstruction.observationWindow,
        );
        return { collected, result: detectRegressions(collected.windows) };
      },
    );

    rule('Phase 2 — did production materially change');
    console.log(
      `windows          baseline ${reconstruction.baselineWindow.from.toISOString().slice(11, 16)}` +
        `–${reconstruction.baselineWindow.to.toISOString().slice(11, 16)}  ` +
        `observation ${reconstruction.observationWindow.from.toISOString().slice(11, 16)}` +
        `–${reconstruction.observationWindow.to.toISOString().slice(11, 16)}`,
    );
    console.log(`metrics examined ${detection.collected.windows.length}`);
    if (detection.collected.failures.length) {
      for (const f of detection.collected.failures) console.log(`   uncollected ${f.metric}: ${f.reason}`);
    }

    console.log(`\nregressions      ${detection.result.regressions.length}`);
    for (const r of detection.result.regressions) {
      const change = r.percentageChange === null ? 'baseline was zero' : `${r.percentageChange.toFixed(1)}%`;
      const unit = r.metric.startsWith('latency') ? 'ms' : '';
      const fmt = (n: number) => (unit ? `${n.toFixed(1)}${unit}` : pct(n));
      console.log(`   ${r.severity}  ${r.metric.padEnd(20)} ${fmt(r.baseline)} → ${fmt(r.observed)}  (${change})  confidence ${r.confidence}`);
    }
    console.log(`\ndismissed as noise ${detection.result.dismissed.length}`);
    for (const d of detection.result.dismissed) console.log(`   ${d.metric.padEnd(20)} ${d.reason}`);
    if (detection.result.inconclusive.length) {
      console.log(`\ninconclusive     ${detection.result.inconclusive.length}`);
      for (const d of detection.result.inconclusive) console.log(`   ${d.metric}: ${d.reason}`);
    }

    const worst = worstRegression(detection.result);
    rule('Verdict');
    if (worst) {
      console.log(`Production materially changed after this deployment.`);
      console.log(`  worst signal        ${worst.metric} ${pct(worst.baseline)} → ${pct(worst.observed)} (${worst.severity})`);
      console.log(`  detection confidence ${worst.confidence}`);
      console.log(`\n  Deployment attribution: NOT YET DETERMINED.`);
      console.log(`  Timing alone is correlation. Attribution requires evidence and is Phase 3's job.`);
    } else {
      console.log('No material change detected. No incident opened.');
    }

    rule('Instrumentation');
    console.log(`agent runs   ${sink.agentRuns.size}`);
    for (const [, run] of sink.agentRuns) console.log(`   ${run.status.padEnd(5)} ${run.agentName}`);
    console.log(`tool calls   ${sink.toolCalls.length}  (${sink.failedToolCalls().length} failed)`);
    const byTool = new Map<string, number>();
    for (const c of sink.toolCalls) byTool.set(c.toolName, (byTool.get(c.toolName) ?? 0) + 1);
    for (const [name, n] of byTool) console.log(`   ${String(n).padStart(3)}  ${name}`);
    console.log(`\nlemma        ${lemmaFromEnv() ? 'enabled' : 'on hold (not configured)'}`);
    console.log();
  } finally {
    await env.stop();
  }
}

void main().catch((err) => {
  console.error(`\nFAILED: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exitCode = 1;
});
