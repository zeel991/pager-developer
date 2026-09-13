/**
 * End-to-end incident pipeline against the local twin, persisted to Postgres.
 *
 * Usage: pnpm demo:pipeline [SCENARIO_ID] [--db <url>]
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { AgentTracer, lemmaFromEnv } from '@pager/observability';
import type { DeploymentRecord } from '@pager/providers';
import {
  AgentRunRepository,
  AuditRepository,
  DeploymentRepository,
  DrizzleTelemetrySink,
  EvidenceRepository,
  IncidentRepository,
  TelemetryRepository,
  TimelineRepository,
  createDatabase,
  organizations,
  repositories as reposTable,
  services,
} from '@pager/db';
import { IncidentEngine, IncidentPipeline } from '@pager/agents';
import { fixture } from '@pager/twin-local';
import { startLocalEnvironment } from './local-env.ts';

const scenarioId = process.argv[2] ?? 'INC-001';
const dbFlag = process.argv.indexOf('--db');
const dbUrl = dbFlag > -1 ? process.argv[dbFlag + 1]! : (process.env.PAGER_DEMO_DB ?? 'pglite://memory');

const MIGRATIONS = join(import.meta.dirname, '..', '..', 'packages', 'db', 'migrations');

/**
 * Apply the schema. Tolerates a database that already has it, so the demo can be
 * pointed at a persistent Postgres and re-run.
 */
async function applyMigrations(handle: Awaited<ReturnType<typeof createDatabase>>): Promise<void> {
  const file = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()[0]!;
  const statements = readFileSync(join(MIGRATIONS, file), 'utf8').split('--> statement-breakpoint');

  for (const statement of statements) {
    const sql = statement.trim();
    if (!sql) continue;
    try {
      if (handle.pglite) await handle.pglite.exec(sql);
      else await handle.db.execute(sql as never);
    } catch (err) {
      // Re-running against an existing database is fine; anything else is not.
      if (!/already exists/i.test(String(err))) throw err;
    }
  }
}
const rule = (t: string) => console.log(`\n${'─'.repeat(78)}\n${t}\n${'─'.repeat(78)}`);

async function main(): Promise<void> {
  const spec = fixture(scenarioId);
  rule(`Incident pipeline — ${spec.id}`);
  console.log(`database  ${dbUrl}`);

  const handle = await createDatabase(dbUrl);
  await applyMigrations(handle);

  const [org] = await handle.db.insert(organizations).values({ name: 'Acme', slug: `acme-${Date.now()}` }).returning();
  const [repo] = await handle.db
    .insert(reposTable)
    .values({ organizationId: org!.id, fullName: spec.repository })
    .returning();
  const [svc] = await handle.db
    .insert(services)
    .values({ organizationId: org!.id, repositoryId: repo!.id, name: spec.service })
    .returning();

  const env = await startLocalEnvironment(scenarioId);
  const incidents = new IncidentRepository(handle.db);
  const timeline = new TimelineRepository(handle.db);
  const audit = new AuditRepository(handle.db);
  const engine = new IncidentEngine(incidents, timeline, audit);
  const agentRuns = new AgentRunRepository(handle.db);

  const tracer = new AgentTracer({
    sink: new DrizzleTelemetrySink(handle.db),
    lemma: lemmaFromEnv(),
  });

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

  const pipeline = new IncidentPipeline({
    sourceControl: env.sourceControl,
    observability: env.observability,
    messaging: env.messaging,
    tracer,
    incidents,
    deployments: new DeploymentRepository(handle.db),
    evidence: new EvidenceRepository(handle.db),
    telemetry: new TelemetryRepository(handle.db),
    agentRuns,
    engine,
  });

  const outcome = await pipeline.run({
    organizationId: org!.id,
    serviceId: svc!.id,
    repositoryId: repo!.id,
    deployment,
    slackChannel: '#incidents',
  });

  rule('Outcome');
  if (!outcome.incident) {
    console.log(`No incident opened.`);
    console.log(`  reason  ${outcome.noIncidentReason}`);
  } else {
    const i = outcome.incident;
    console.log(`incident        ${i.key}  ${i.state}  ${i.severity}`);
    console.log(`title           ${i.title}`);
    console.log(`attribution     ${i.deploymentAttribution ?? 'NOT DETERMINED'}`);
    console.log(`slack thread    ${outcome.slackThreadTs ?? '(not posted)'}`);
    console.log(`evidence rows   ${outcome.evidenceIds.length}`);
  }
  console.log(`changed files   ${outcome.reconstruction.changedFiles.length}`);
  console.log(`regressions     ${outcome.detection.regressions.map((r) => r.metric).join(', ') || '(none)'}`);

  if (outcome.incident) {
    rule('Incident timeline');
    for (const e of await timeline.forIncident(outcome.incident.id)) {
      const when = e.at.toISOString().slice(11, 19);
      const arrow = e.fromState && e.toState ? `  ${e.fromState} → ${e.toState}` : '';
      console.log(`${when}  ${e.kind.padEnd(22)} ${e.summary}${arrow}`);
    }

    rule('Agent runs (persisted)');
    for (const run of await agentRuns.forIncident(outcome.incident.id)) {
      const calls = await agentRuns.toolCallsForRun(run.id);
      console.log(`${run.status.padEnd(6)} ${run.agentName.padEnd(22)} ${calls.length} tool calls`);
    }

    rule('Slack thread (read back from the twin)');
    for (const m of env.server.current.messages) {
      console.log(m.text.split('\n').map((l) => `  ${l}`).join('\n'));
    }
  }

  await env.stop();
  await handle.close();
  console.log();
}

void main().catch((err) => {
  console.error(`\nFAILED: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exitCode = 1;
});
