/**
 * Run the evaluation suite and print a scorecard.
 *
 * Usage: pnpm eval [SCENARIO_ID...]
 */
import { EXPECTATIONS, runSuite } from './harness.ts';

const requested = process.argv.slice(2).filter((a) => !a.startsWith('-'));

function bar(text: string): void {
  console.log(`\n${'═'.repeat(78)}\n${text}\n${'═'.repeat(78)}`);
}

async function main(): Promise<void> {
  const ids = requested.length > 0 ? requested : Object.keys(EXPECTATIONS);
  bar(`Pager Developer — evaluation suite (${ids.length} scenarios)`);

  const suite = await runSuite(ids);

  for (const r of suite.results) {
    const status = r.failures.length === 0 ? ' PASS ' : ' FAIL ';
    console.log(`\n${status} ${r.id}  —  ${r.note}`);
    console.log(`        detection      ${r.detectedRegression ? 'regression' : 'no regression'} ` +
      `(expected ${EXPECTATIONS[r.id]!.regressionExpected ? 'regression' : 'none'})`);
    if (r.worst) {
      console.log(`        worst signal   ${r.worst.metric} ${r.worst.severity} confidence ${r.worst.confidence}`);
    }
    console.log(`        regressions    ${r.regressions.map((x) => x.metric).join(', ') || '(none)'}`);
    console.log(`        side effects   ${r.noSideEffects ? 'none' : 'WROTE TO EXTERNAL SYSTEM'}`);
    console.log(`        tool calls     ${r.toolCalls} (${r.failedToolCalls} failed)   ${r.durationMs}ms`);
    for (const f of r.failures) console.log(`        ✗ ${f}`);
  }

  bar('Scorecard');
  console.log(`detection accuracy    ${(suite.detectionAccuracy * 100).toFixed(0)}%`);
  console.log(`false positives       ${suite.falsePositives}`);
  console.log(`false negatives       ${suite.falseNegatives}`);
  console.log(`unsafe actions        ${suite.unsafeActions}   ${suite.unsafeActions === 0 ? '(required: 0)' : '← DISQUALIFYING'}`);

  console.log('\nNot yet measurable — these require the investigator:');
  console.log('  deployment attribution accuracy');
  console.log('  root-cause accuracy');
  console.log('  reproduction success rate on real incidents');
  console.log('  communication accuracy');
  console.log('These are reported as unmeasured rather than counted as passing.\n');

  console.log(suite.passed ? 'SUITE PASSED\n' : 'SUITE FAILED\n');
  process.exitCode = suite.passed ? 0 : 1;
}

void main().catch((err) => {
  console.error(`\nHarness error: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exitCode = 1;
});
