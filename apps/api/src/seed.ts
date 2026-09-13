/**
 * Populate the API's database by running the real incident workflow.
 *
 * Every incident, timeline entry, state transition, agent run, tool call and piece
 * of evidence in the dashboard is produced by the same code path that would run
 * against Arga or the real vendors. A dashboard filled with hand-written rows would
 * demonstrate nothing about whether the system works.
 *
 * The patch and regression test come from a scripted generator, and are labelled
 * `scripted` wherever they appear — authorship is the one step that needs a model.
 *
 * Usage: pnpm api:seed [SCENARIO_ID...]
 */
import { rm } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { AgentTracer, lemmaFromEnv } from '@pager/observability';
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
import {
  AgentRunRepository,
  AuditRepository,
  DrizzleTelemetrySink,
  EvidenceRepository,
  FixRepository,
  IncidentRepository,
  InvestigationRepository,
  TelemetryRepository,
  TimelineRepository,
  organizations,
  repositories as reposTable,
  services,
} from '@pager/db';
import type { DeploymentRecord } from '@pager/providers';
import {
  IncidentEngine,
  IncidentInvestigator,
  IncidentWorkflow,
  ModelPatchGenerator,
  ScriptedPatchGenerator,
  describeModelAvailability,
  modelFromEnv,
  type PatchGenerator,
} from '@pager/agents';
import { FIXTURES, LocalTwinServer, fixture, seedFromFixture } from '@pager/twin-local';
import { DEFAULT_DATABASE_URL, openDatabase } from './db.ts';
import { SCRIPTS } from './seed-scripts.ts';

const requested = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const ids = requested.length > 0 ? requested : Object.keys(FIXTURES);

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;

  // Start from a clean store so seeding is repeatable. The path must be resolved
  // the same way the client resolves it, or this deletes nothing and the next run
  // collides with the previous one's rows.
  if (url.startsWith('pglite://') && url !== 'pglite://memory') {
    const target = url.slice('pglite://'.length);
    const dir = isAbsolute(target)
      ? target
      : resolve(process.env.PAGER_DATA_ROOT ?? process.cwd(), target);
    await rm(dir, { recursive: true, force: true });
  }

  const handle = await openDatabase(url);
  const [org] = await handle.db.insert(organizations).values({ name: 'Acme', slug: 'acme' }).returning();

  const incidents = new IncidentRepository(handle.db);
  const timeline = new TimelineRepository(handle.db);
  const audit = new AuditRepository(handle.db);
  const agentRuns = new AgentRunRepository(handle.db);
  const evidence = new EvidenceRepository(handle.db);
  const investigationRepo = new InvestigationRepository(handle.db);
  const fixes = new FixRepository(handle.db);
  const engine = new IncidentEngine(incidents, timeline, audit);
  const availability = describeModelAvailability();
  const model = modelFromEnv();
  console.log(
    `Model: ${availability.available ? `${availability.model} (LIVE — the dashboard will show model-authored work)` : `none. ${availability.reason} Patches will be SCRIPTED fixtures.`}`,
  );
  const tracer = new AgentTracer({ sink: new DrizzleTelemetrySink(handle.db), lemma: lemmaFromEnv() });

  console.log(`Seeding ${ids.length} scenario(s) into ${url}\n`);

  for (const id of ids) {
    const spec = fixture(id);
    const server = new LocalTwinServer({ now: () => Date.parse(spec.deployedAt) + 14 * 60_000 });
    server.seed(seedFromFixture(spec));
    const endpoints = await server.start();

    try {
      const [repo] = await handle.db
        .insert(reposTable)
        .values({
          organizationId: org!.id,
          fullName: `${spec.repository}#${id}`,
          language: 'typescript',
          packageManager: 'npm',
          testCommand: 'npm run test',
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

      const creds = await registerViaManifest(endpoints.github, PAGER_APP_MANIFEST(endpoints.github));
      const tokens = new GitHubAppTokenSource(endpoints.github, creds);

      const observability = new DatadogProvider({ baseUrl: endpoints.datadog });
      const sourceControl = new GitHubProvider({ baseUrl: endpoints.github, tokenProvider: () => tokens.token() });
      const knowledge = new NotionProvider({ baseUrl: endpoints.notion, token: 't', parentPageId: 'runbook-checkout' });

      // A real model when one is configured; the scenario's fixture otherwise. The
      // dashboard shows which, because `kind` travels with every artefact.
      const patchGenerator: PatchGenerator | null = model
        ? new ModelPatchGenerator({ model, tracer })
        : SCRIPTS[id]
          ? new ScriptedPatchGenerator(SCRIPTS[id]!)
          : null;

      const workflow = new IncidentWorkflow({
        observability,
        sourceControl,
        messaging: new SlackProvider({ baseUrl: endpoints.slack }),
        issueTracker: new JiraProvider({ baseUrl: endpoints.jira, projectKey: 'INC' }),
        knowledge,
        email: new ResendProvider({ baseUrl: endpoints.resend, apiKey: 're_seed', from: 'pager@acme.dev' }),
        tracer,
        ...(patchGenerator ? { patchGenerator } : {}),
        investigator: model
          ? new IncidentInvestigator({ model, tracer, providers: { observability, sourceControl, knowledge } })
          : null,
        persistence: {
          engine,
          evidence,
          agentRuns,
          telemetry: new TelemetryRepository(handle.db),
          organizationId: org!.id,
          serviceId: svc!.id,
          investigations: investigationRepo,
          fixes,
          repositoryId: repo!.id,
        },
      });

      // What production is running, established from deployment evidence. The
      // workflow refuses to substitute the branch head, so this is required.
      const history = await sourceControl.listCommits(spec.repository, { limit: 2 });
      const deployment: DeploymentRecord | null = history[0]
        ? {
            id: `dep-${id}`,
            service: spec.service,
            environment: 'production',
            commitSha: history[0].sha,
            previousCommitSha: history[1]?.sha ?? null,
            status: 'succeeded',
            startedAt: new Date(Date.parse(spec.deployedAt) - 120_000),
            deployedAt: new Date(spec.deployedAt),
            author: history[0].authorName,
            repositoryFullName: spec.repository,
          }
        : null;

      const result = await workflow.run({
        service: spec.service,
        repository: spec.repository,
        slackChannel: '#incidents',
        teamEmails: ['payments-team@acme.dev'],
        deployment,
      });

      if (!result.incident) {
        console.log(`  ${id}  → no incident: ${result.alert?.rationale ?? 'no monitor alerting'}`);
        continue;
      }

      console.log(
        `  ${id}  → ${result.incident.key} ${result.incident.state} (${result.incident.severity})` +
          (result.pullRequest ? `, PR #${result.pullRequest.number}` : '') +
          (result.haltReason ? `, halted: ${result.haltReason.slice(0, 60)}…` : ''),
      );
    } finally {
      await server.stop();
    }
  }

  await handle.close();
  console.log(`\nDone. Start the API with: pnpm api\n`);
}

void main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
