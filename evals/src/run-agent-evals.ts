/**
 * Agent evaluation CLI.
 *
 * Usage:
 *   pnpm eval:agent                 every scenario the environment can actually run
 *   pnpm eval:agent -- --repeat 3   repeat the live repair scenario, to see variance
 *   pnpm eval:agent -- INC-014      one scenario
 *
 * Live-model scenarios are SKIPPED, not failed, when no model key is configured, and
 * the report says so. A suite that reports green because it quietly ran nothing is
 * the exact failure this project exists to avoid.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describeModelAvailability } from '@pager/agents';
import { AGENT_SCENARIOS, type AgentScenario } from './agent-scenarios.ts';
import { runAgentScenario, redact, type AgentScenarioResult } from './agent-eval.ts';

const rule = (t: string): void => console.log(`\n${'━'.repeat(78)}\n  ${t}\n${'━'.repeat(78)}`);

interface Report {
  generatedAt: string;
  model: { available: boolean; provider: string; model: string; reason: string };
  scenarios: AgentScenarioResult[];
  skipped: { id: string; reason: string }[];
  summary: {
    ran: number;
    passed: number;
    failed: number;
    skipped: number;
    unmeasuredChecks: number;
    totalToolCalls: number;
    failedToolCalls: number;
    totalInputTokens: number | null;
    totalOutputTokens: number | null;
    durationMs: number;
  };
  caveats: string[];
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const repeatFlag = args.indexOf('--repeat');
  const repeat = repeatFlag >= 0 ? Math.max(1, Number(args[repeatFlag + 1] ?? 1)) : 1;
  const selected = args.filter((a) => !a.startsWith('--') && !/^\d+$/.test(a));

  const availability = describeModelAvailability();
  const started = Date.now();

  rule('Pager Developer — agent evaluation');
  console.log(`  Model: ${availability.model} — ${availability.reason}`);
  console.log(`  Environment: local twins (github, datadog, slack, jira, notion)\n`);

  const scenarios = selected.length > 0
    ? AGENT_SCENARIOS.filter((s) => selected.includes(s.id))
    : AGENT_SCENARIOS;

  const results: AgentScenarioResult[] = [];
  const skipped: { id: string; reason: string }[] = [];

  for (const scenario of scenarios) {
    if (scenario.mode === 'live-model' && !availability.available) {
      skipped.push({
        id: scenario.id,
        reason:
          `Requires a live model and ${availability.reason} This scenario was NOT run and is ` +
          `reported as skipped, never as passing.`,
      });
      console.log(`  SKIP  ${scenario.id.padEnd(18)} ${scenario.title}`);
      console.log(`        ${availability.reason}\n`);
      continue;
    }

    // Repetition applies only to the live repair case: repeating a deterministic
    // scenario measures nothing, and quota is finite.
    const runs = scenario.mode === 'live-model' && scenario.expected.pullRequest ? repeat : 1;
    for (let i = 0; i < runs; i++) {
      const result = await runOne(scenario, runs > 1 ? i + 1 : null);
      results.push(result);
    }
  }

  const report = buildReport(availability, results, skipped, Date.now() - started);
  const path = await persist(report);

  rule('Summary');
  console.log(`  ${report.summary.passed}/${report.summary.ran} scenario run(s) passed` +
    (report.summary.skipped > 0 ? `, ${report.summary.skipped} skipped` : '') +
    (report.summary.unmeasuredChecks > 0 ? `, ${report.summary.unmeasuredChecks} check(s) UNMEASURED` : ''));
  console.log(`  ${report.summary.totalToolCalls} tool calls, ${report.summary.failedToolCalls} failed`);
  console.log(
    `  Model usage: ${report.summary.totalInputTokens ?? 'not reported'} in / ` +
      `${report.summary.totalOutputTokens ?? 'not reported'} out`,
  );
  console.log(`\n  Report written to ${path}\n`);
  for (const caveat of report.caveats) console.log(`  · ${caveat}`);
  console.log('');

  process.exitCode = report.summary.failed > 0 ? 1 : 0;
}

async function runOne(scenario: AgentScenario, attempt: number | null): Promise<AgentScenarioResult> {
  const label = attempt ? `${scenario.id} (run ${attempt})` : scenario.id;
  rule(`${label} — ${scenario.title}`);
  console.log(`  ${scenario.rationale}\n`);

  const result = await runAgentScenario(scenario);

  console.log(`  mode            ${result.mode}${result.scriptedInputs ? '  (patch and test are SCRIPTED INPUTS, not model output)' : ''}`);
  console.log(`  stage           ${result.stage}`);
  if (result.haltReason) console.log(`  halted          ${result.haltReason}`);
  if (result.investigation.ran) {
    console.log(`  decision        ${result.investigation.decision ?? '(none reached)'}` +
      (result.investigation.attribution ? `  /  ${result.investigation.attribution}` : ''));
    if (result.investigation.diagnosis) {
      console.log(`  diagnosis       ${result.investigation.diagnosis}   [model conclusion]`);
    }
    if (result.investigation.uncertainty) {
      console.log(`  unknown         ${result.investigation.uncertainty}   [model conclusion]`);
    }
    console.log(`  evidence        ${result.investigation.citedObservations} cited observation(s) over ${result.investigation.toolCalls} tool call(s)`);
  }
  if (result.reproduction) {
    console.log(`  reproduction    before exit ${result.reproduction.beforeExitCode}, after exit ${result.reproduction.afterExitCode ?? 'n/a'}` +
      (result.reproduction.assertionProblems.length ? `  REJECTED: ${result.reproduction.assertionProblems.join('; ')}` : ''));
  }
  if (result.validation.length > 0) {
    console.log(`  checks          ${result.validation.map((v) => `${v.kind}=${v.skipped ? 'not run' : v.passed ? 'pass' : 'FAIL'}`).join(', ')}`);
  }
  console.log(`  observed        ${result.observedSideEffects.pullRequestsOpened} PR(s), ` +
    `${result.observedSideEffects.issuesOpened} issue(s), ${result.observedSideEffects.slackMessages} Slack message(s)   [read from twin state]`);
  if (result.failedToolCalls.length > 0) {
    console.log(`  tool failures   ${result.failedToolCalls.map((f) => `${f.tool}: ${f.error}`).join(' | ')}`);
  }
  if (result.modelUsage) {
    console.log(`  model           ${result.modelUsage.model} — ${result.modelUsage.investigationCalls} investigation call(s), ` +
      `${result.modelUsage.authorshipCalls} authorship call(s), ` +
      `${result.modelUsage.inputTokens ?? '?'} in / ${result.modelUsage.outputTokens ?? '?'} out tokens`);
  }
  console.log(`  duration        ${(result.durationMs / 1000).toFixed(1)}s\n`);

  for (const c of result.checks) {
    const mark = c.outcome === 'pass' ? ' ok ' : c.outcome === 'fail' ? 'FAIL' : ' ?? ';
    console.log(`   [${mark}] ${c.name}`);
    if (c.outcome !== 'pass') console.log(`          expected ${c.expected}\n          actual   ${c.actual}`);
  }
  console.log(`\n  => ${result.passed ? 'PASSED' : 'FAILED'}`);
  return result;
}

function buildReport(
  model: Report['model'],
  scenarios: AgentScenarioResult[],
  skipped: Report['skipped'],
  durationMs: number,
): Report {
  const sumTokens = (pick: (r: AgentScenarioResult) => number | null | undefined): number | null => {
    const values = scenarios.map(pick).filter((v): v is number => typeof v === 'number');
    return values.length > 0 ? values.reduce((a, b) => a + b, 0) : null;
  };

  const caveats = [
    'Outcomes marked [read from twin state] were verified against the twin, not taken from the agent’s own report.',
    'A check that could not be measured is reported as UNMEASURED and never counts as a pass.',
    'Scenarios marked scriptedInputs carry a patch and test written by this harness, not by a model.',
    'Every connection in this run is a LOCAL twin. No real vendor API was contacted.',
  ];
  const liveRuns = scenarios.filter((s) => s.mode === 'live-model').length;
  if (liveRuns > 0 && liveRuns < 5) {
    caveats.push(
      `Only ${liveRuns} live-model run(s) were executed. That is far too few to claim reliability; ` +
        `it demonstrates the behaviour, it does not measure its rate.`,
    );
  }
  if (skipped.length > 0) {
    caveats.push(`${skipped.length} live-model scenario(s) were SKIPPED and are unverified.`);
  }

  return {
    generatedAt: new Date().toISOString(),
    model,
    scenarios,
    skipped,
    summary: {
      ran: scenarios.length,
      passed: scenarios.filter((s) => s.passed).length,
      failed: scenarios.filter((s) => !s.passed).length,
      skipped: skipped.length,
      unmeasuredChecks: scenarios.reduce((n, s) => n + s.unmeasured, 0),
      totalToolCalls: scenarios.reduce((n, s) => n + s.toolCalls, 0),
      failedToolCalls: scenarios.reduce((n, s) => n + s.failedToolCalls.length, 0),
      totalInputTokens: sumTokens((s) => s.modelUsage?.inputTokens),
      totalOutputTokens: sumTokens((s) => s.modelUsage?.outputTokens),
      durationMs,
    },
    caveats,
  };
}

async function persist(report: Report): Promise<string> {
  const dir = join(import.meta.dirname, '..', 'reports');
  await mkdir(dir, { recursive: true });
  const path = join(dir, `agent-eval-${report.generatedAt.replace(/[:.]/g, '-')}.json`);
  await writeFile(path, JSON.stringify(redact(report), null, 2), 'utf8');
  await writeFile(join(dir, 'agent-eval-latest.json'), JSON.stringify(redact(report), null, 2), 'utf8');
  return path;
}

void main().catch((err) => {
  console.error(`\nFAILED: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exitCode = 1;
});
