/**
 * Populate the API's database by running the real pipeline against local twins.
 *
 * Not fabricated rows: every incident, timeline entry, agent run, tool call and
 * piece of evidence here is produced by the same code path that would run against
 * Arga or a real vendor. A dashboard populated with hand-written fixtures would
 * demonstrate nothing about whether the system works.
 *
 * Usage: pnpm --filter @pager/api seed [SCENARIO_ID...]
 */
import { rm } from 'node:fs/promises';
import { AgentTracer, lemmaFromEnv } from '@pager/observability';
import {
  DatadogProvider,
  GitHubAppTokenSource,
  GitHubProvider,
  PAGER_APP_MANIFEST,
  SlackProvider,
  registerViaManifest,
  type DeploymentRecord,
} from '@pager/providers';
import {
  AgentRunRepository,
  AuditRepository,
  DeploymentRepository,
  DrizzleTelemetrySink,
  EvidenceRepository,
  IncidentRepository,
  TelemetryRepository,
  TimelineRepository,
  organizations,
  repositories as reposTable,
  services,
} from '@pager/db';
import { IncidentEngine, IncidentPipeline } from '@pager/agents';
import { FIXTURES, LocalTwinServer, fixture, seedFromFixture } from '@pager/twin-local';
import { DEFAULT_DATABASE_URL, openDatabase } from './db.ts';

const requested = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const ids = requested.length > 0 ? requested : Object.keys(FIXTURES);

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;

  // Start from a clean store so seeding is repeatable.
  if (url.startsWith('pglite://') && url !== 'pglite://memory') {
    await rm(url.slice('pglite://'.length), { recursive: true, force: true });
  }

  const handle = await openDatabase(url);
  const [org] = await handle.db.insert(organizations).values({ name: 'Acme', slug: 'acme' }).returning();

  const incidents = new IncidentRepository(handle.db);
  const timeline = new TimelineRepository(handle.db);
  const audit = new AuditRepository(handle.db);
  const engine = new IncidentEngine(incidents, timeline, audit);
  const tracer = new AgentTracer({ sink: new DrizzleTelemetrySink(handle.db), lemma: lemmaFromEnv() });

  console.log(`Seeding ${ids.length} scenario(s) into ${url}\n`);

  for (const id of ids) {
    const spec = fixture(id);
    const server = new LocalTwinServer({ now: () => Date.parse(spec.deployedAt) + 14 * 60_000 });
    server.seed(seedFromFixture(spec));
    const endpoints = await server.start();

    try {
      const creds = await registerViaManifest(endpoints.github, PAGER_APP_MANIFEST(endpoints.github));
      const tokens = new GitHubAppTokenSource(endpoints.github, creds);
      const sourceControl = new GitHubProvider({
        baseUrl: endpoints.github,
        tokenProvider: () => tokens.token(),
      });

      const [repo] = await handle.db
        .insert(reposTable)
        .values({
          organizationId: org!.id,
          fullName: `${spec.repository}#${id}`,
          language: 'typescript',
          packageManager: 'npm',
          testCommand: 'node --test',
          profileRefreshedAt: new Date(),
        })
        .returning();
      const [svc] = await handle.db
        .insert(services)
        .values({
          organizationId: org!.id,
          repositoryId: repo!.id,
          name: `${spec.service} (${id})`,
          ownerTeam: 'payments-team',
        })
        .returning();

      const history = await sourceControl.listCommits(spec.repository, { limit: 20 });
      const head = await sourceControl.getCommit(spec.repository, history[0]!.sha);
      const deployment: DeploymentRecord = {
        id: `dep-${id}`,
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

      const outcome = await new IncidentPipeline({
        sourceControl,
        observability: new DatadogProvider({ baseUrl: endpoints.datadog }),
        messaging: new SlackProvider({ baseUrl: endpoints.slack }),
        tracer,
        incidents,
        deployments: new DeploymentRepository(handle.db),
        evidence: new EvidenceRepository(handle.db),
        telemetry: new TelemetryRepository(handle.db),
        agentRuns: new AgentRunRepository(handle.db),
        engine,
      }).run({
        organizationId: org!.id,
        serviceId: svc!.id,
        repositoryId: repo!.id,
        deployment,
        slackChannel: '#incidents',
      });

      console.log(
        outcome.incident
          ? `  ${id}  → ${outcome.incident.key} ${outcome.incident.state} (${outcome.incident.severity}), ` +
            `${outcome.evidenceIds.length} evidence, ${outcome.detection.regressions.length} regressions`
          : `  ${id}  → no incident: ${outcome.noIncidentReason}`,
      );
    } finally {
      await server.stop();
    }
  }

  await handle.close();
  console.log(`\nDone. Start the API with: pnpm --filter @pager/api start\n`);
}

void main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
