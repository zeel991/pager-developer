/**
 * Provision an Arga Twin Run for a scenario and print the resolved endpoints.
 *
 * Usage: pnpm --filter @pager/evals provision INC-001 [ttlMinutes]
 */
import { TwinRun, argaClientFromEnv } from '@pager/providers';
import { loadScenario } from './scenario.ts';

const id = process.argv[2] ?? 'INC-001';
const ttlMinutes = Number(process.argv[3] ?? 60);

async function main(): Promise<void> {
  const scenario = loadScenario(id);
  const client = argaClientFromEnv();

  console.log(`\nProvisioning ${scenario.id} — ${scenario.title}`);
  console.log(`  twins: ${scenario.twins.join(', ')}`);
  console.log(`  ttl:   ${ttlMinutes} min\n`);

  const started = Date.now();
  const run = await TwinRun.provision(
    client,
    {
      twins: scenario.twins,
      ttlMinutes,
      scenarioPrompt: scenario.scenarioPrompt,
      scenarioGenerationMode: 'thorough',
      public: true,
    },
    { pollIntervalMs: 5_000, timeoutMs: 900_000 },
  );

  console.log(`Ready in ${Math.round((Date.now() - started) / 1000)}s — run ${run.runId}`);
  console.log(`  expires: ${run.expiresAt?.toISOString() ?? 'unknown'}\n`);

  for (const name of run.twinNames) {
    const ep = run.endpoint(name);
    console.log(`  ${name.padEnd(10)} ${ep.baseUrl}`);
    console.log(`  ${''.padEnd(10)} env: ${Object.keys(ep.envVars).join(', ') || '(none)'}`);
  }

  console.log(`\nRun id written to .arga-run so other commands can attach:\n  ${run.runId}\n`);
  const { writeFileSync } = await import('node:fs');
  writeFileSync(
    new URL('../../.arga-run', import.meta.url),
    JSON.stringify({ runId: run.runId, scenarioId: scenario.id, expiresAt: run.expiresAt }, null, 2),
  );
}

void main().catch((err) => {
  console.error(`\nProvisioning failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
