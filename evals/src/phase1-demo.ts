/**
 * Phase 1 end-to-end demonstration, against real Arga infrastructure.
 *
 * Provisions a GitHub twin, seeds a deployment scenario, authenticates as a GitHub
 * App, and has the DeploymentObserver reconstruct what changed — reading the diff,
 * commits and pull requests out of the twin exactly as it would from real GitHub.
 *
 * Nothing here is stubbed. If the twin is unreachable this fails loudly.
 */
import { AgentTracer, InMemorySink, lemmaFromEnv } from '@pager/observability';
import {
  GitHubAppTokenSource,
  GitHubProvider,
  PAGER_APP_MANIFEST,
  TwinRun,
  argaClientFromEnv,
  registerViaManifest,
  type DeploymentRecord,
} from '@pager/providers';
import { DeploymentObserver } from '@pager/agents';
import { loadScenario } from './scenario.ts';

const scenarioId = process.argv[2] ?? 'INC-001';

function heading(text: string): void {
  console.log(`\n${'─'.repeat(72)}\n${text}\n${'─'.repeat(72)}`);
}

async function main(): Promise<void> {
  const scenario = loadScenario(scenarioId);
  heading(`Phase 1 — ${scenario.id}: ${scenario.title}`);

  // 1. Provision the GitHub twin. The free plan allows one twin per run, so the
  //    source-control twin is provisioned on its own; telemetry and messaging get
  //    their own runs in later phases. The twins hold independent data, and the
  //    correlation between them happens in Pager, not inside Arga.
  console.log('\n[1] Provisioning GitHub twin…');
  const client = argaClientFromEnv();
  const started = Date.now();
  const run = await TwinRun.provision(
    client,
    {
      twins: ['github'],
      ttlMinutes: 10,
      scenarioPrompt: scenario.scenarioPrompt,
      scenarioGenerationMode: 'fast',
      public: true,
    },
    { pollIntervalMs: 4_000, timeoutMs: 540_000 },
  );
  const endpoint = run.endpoint('github');
  console.log(`    ready in ${Math.round((Date.now() - started) / 1000)}s — run ${run.runId}`);
  console.log(`    ${endpoint.baseUrl}`);
  console.log(`    expires ${run.expiresAt?.toISOString() ?? 'unknown'}`);

  // 2. Authenticate as a GitHub App. The twin returns no credentials in envVars and
  //    rejects unauthenticated writes, so the manifest flow is how a credential is
  //    obtained — the same flow that provisions a real GitHub App.
  console.log('\n[2] Registering GitHub App and minting an installation token…');
  const creds = await registerViaManifest(endpoint.baseUrl, PAGER_APP_MANIFEST(endpoint.baseUrl));
  const tokens = new GitHubAppTokenSource(endpoint.baseUrl, creds);
  await tokens.token();
  console.log(`    app id ${creds.appId} (${creds.slug ?? 'pager-developer'})`);
  console.log(`    permissions: ${Object.entries(tokens.grantedPermissions).map(([k, v]) => `${k}:${v}`).join(' ')}`);

  // 3. Build the provider. From here nothing knows it is talking to a twin.
  const github = new GitHubProvider({
    baseUrl: endpoint.baseUrl,
    tokenProvider: () => tokens.token(),
  });

  // 4. Resolve the real revisions from the twin. Arga generates its own shas when it
  //    seeds a scenario, so the placeholder shas in the scenario file are not what
  //    the repository actually contains — asking is the only correct move.
  console.log('\n[3] Resolving deployed revisions from the twin…');
  const history = await github.listCommits(scenario.repository, { limit: 10 });
  if (history.length < 2) {
    throw new Error(
      `Twin seeded ${history.length} commit(s); need at least two to reconstruct a deployment.`,
    );
  }
  const head = history[0]!;
  const headSha = head.sha;

  // What a deployment changed is the diff against the revision production was
  // previously running — which for a merge commit is its FIRST parent, the tip of
  // the base branch. Comparing a merge against the feature branch it merged yields
  // an empty diff, because their trees are identical.
  const fullHead = await github.getCommit(scenario.repository, headSha);
  const previousSha = fullHead.parents[0] ?? history[1]!.sha;

  console.log(`    head     ${headSha.slice(0, 12)}  ${head.message.split('\n')[0]?.slice(0, 48)}`);
  console.log(`    parents  ${fullHead.parents.map((p) => p.slice(0, 8)).join(', ') || '(none)'}`);
  console.log(`    previous ${previousSha.slice(0, 12)}  (first parent of head)`);

  const sink = new InMemorySink();
  const tracer = new AgentTracer({ sink, lemma: lemmaFromEnv() });
  const observer = new DeploymentObserver(github, tracer);

  const deployment: DeploymentRecord = {
    id: `dep-${scenario.id}`,
    service: scenario.service,
    environment: scenario.seededDeployment.environment,
    commitSha: headSha,
    previousCommitSha: previousSha,
    status: 'succeeded',
    startedAt: scenario.seededDeployment.deployedAt,
    deployedAt: scenario.seededDeployment.deployedAt,
    author: null,
    repositoryFullName: scenario.repository,
  };

  console.log('\n[4] DeploymentObserver reconstructing the deployment…');
  const reconstruction = await observer.observe(deployment);

  heading('Result');
  console.log(`service            ${reconstruction.deployment.service}`);
  console.log(`revision           ${deployment.previousCommitSha} -> ${deployment.commitSha}`);
  console.log(`commits            ${reconstruction.commits.length}`);
  for (const c of reconstruction.commits.slice(0, 5)) {
    console.log(`  ${c.sha.slice(0, 8)}  ${c.message.split('\n')[0]?.slice(0, 54)}  (${c.authorName})`);
  }
  console.log(`changed files      ${reconstruction.changedFiles.length}`);
  for (const f of reconstruction.changedFiles.slice(0, 8)) {
    console.log(`  ${f.status.padEnd(9)} ${f.path}  +${f.additions}/-${f.deletions}`);
  }
  console.log(`pull requests      ${reconstruction.pullRequests.map((p) => `#${p.number} ${p.title}`).join(', ') || '(none)'}`);
  console.log(`baseline window    ${reconstruction.baselineWindow.from.toISOString()} → ${reconstruction.baselineWindow.to.toISOString()}`);
  console.log(`observation window ${reconstruction.observationWindow.from.toISOString()} → ${reconstruction.observationWindow.to.toISOString()}`);
  console.log(`gaps               ${reconstruction.gaps.length ? reconstruction.gaps.join('; ') : '(none)'}`);

  heading('Instrumentation');
  console.log(`agent runs   ${sink.agentRuns.size}`);
  for (const call of sink.toolCalls) {
    console.log(`  ${call.status === 'OK' ? 'ok  ' : 'FAIL'} ${call.toolName.padEnd(36)} ${call.durationMs}ms`);
  }
  console.log(`\nevidence-citable tool call ids: ${reconstruction.toolCallIds.length}`);
  console.log(`lemma: ${lemmaFromEnv() ? 'enabled' : 'not configured (LEMMA_API_KEY unset)'}`);

  await run.teardown();
  console.log('\ntwin torn down.\n');
}

void main().catch((err) => {
  console.error(`\nFAILED: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exitCode = 1;
});
