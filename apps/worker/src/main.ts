/**
 * Pager Developer, running as a service.
 *
 * This is the product rather than a demonstration of it: nobody types a command.
 * The worker watches a real Datadog account on a loop, and when a monitor alerts on
 * something undocumented it investigates, reproduces the failure against the exact
 * revision production is running, writes and verifies a fix, and opens a pull
 * request for a human — then goes back to watching.
 *
 * Two properties matter more than the loop itself:
 *
 *  - It will not act twice on the same deployment. An incident is keyed to the
 *    deployed revision, so a monitor that stays red for an hour produces one pull
 *    request, not sixty.
 *  - It never merges and never deploys. The only production-affecting act in the
 *    whole system is a human merging the pull request it opened.
 */
import { createServer } from 'node:http';
import {
  DatadogProvider,
  GitHubProvider,
  SlackProvider,
} from '@pager/providers';
import { AgentTracer, InMemorySink, lemmaFromEnv } from '@pager/observability';
import {
  AnthropicModel,
  IncidentInvestigator,
  IncidentWorkflow,
  ModelPatchGenerator,
} from '@pager/agents';
import { loadConfig, describeConfig, type WorkerConfig } from './config.ts';
import { deploymentFromRevision, probeDeployedRevision } from './deployed-revision.ts';

const log = (message: string): void => {
  console.log(`${new Date().toISOString()}  ${message}`);
};

/**
 * What the worker has seen and done, exposed over HTTP.
 *
 * A watcher that cannot be asked whether it is actually watching is indistinguishable
 * from one that has quietly died. This also lets the worker run as an ordinary web
 * service on hosts that only offer those, which is why it binds a port at all.
 *
 * Nothing here is a credential and nothing here is a control: the endpoint is
 * strictly read-only, so exposing it cannot cause an incident to be opened,
 * a branch to be created or a message to be sent.
 */
interface WorkerStatus {
  startedAt: string;
  lastTickAt: string | null;
  lastOutcome: string | null;
  ticks: number;
  incidents: { revision: string; at: string; outcome: string; pullRequest: string | null }[];
  /** Revisions already acted on, so a red monitor produces one PR and not sixty. */
  handledRevisions: string[];
}

const status: WorkerStatus = {
  startedAt: new Date().toISOString(),
  lastTickAt: null,
  lastOutcome: null,
  ticks: 0,
  incidents: [],
  handledRevisions: [],
};

function serveStatus(port: number): void {
  createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (path === '/health') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ status: 'ok', service: 'pager-developer-worker' }));
      return;
    }
    if (path === '/' || path === '/status') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(status, null, 2));
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'not_found' }));
  }).listen(port, '0.0.0.0', () => log(`status endpoint listening on ${port}`));
}

async function tick(config: WorkerConfig, handled: Set<string>): Promise<void> {
  // 1. Ask the service what it is running. Everything downstream depends on this
  //    being observed rather than assumed, so a failure here ends the tick.
  const probe = await probeDeployedRevision(config.healthUrl);
  if (!probe.sha) {
    log(`skip: ${probe.problem}`);
    return;
  }

  const sink = new InMemorySink();
  const tracer = new AgentTracer({ sink, lemma: lemmaFromEnv() });

  const observability = new DatadogProvider({
    baseUrl: config.datadog.baseUrl,
    apiKey: config.datadog.apiKey,
    appKey: config.datadog.appKey,
  });
  const sourceControl = new GitHubProvider({
    baseUrl: 'https://api.github.com',
    token: config.githubToken,
  });
  const messaging = new SlackProvider({ baseUrl: 'https://slack.com', token: config.slackToken });
  const model = new AnthropicModel({ apiKey: config.anthropicKey, model: config.model });

  const deployment = await deploymentFromRevision(sourceControl, {
    repository: config.repository,
    service: config.service,
    sha: probe.sha,
    observedAt: probe.reportedAt,
  });

  // 2. One incident per deployed revision. A monitor stays red for as long as the
  //    bug is live, and an agent that re-opened a pull request on every poll would
  //    be indistinguishable from a denial of service against its own reviewers.
  if (handled.has(deployment.commitSha)) {
    status.lastOutcome = `already handled ${deployment.commitSha.slice(0, 12)}`;
    log(`watching ${config.service} at ${deployment.commitSha.slice(0, 12)} — already handled`);
    return;
  }

  const workflow = new IncidentWorkflow({
    observability,
    sourceControl,
    messaging,
    issueTracker: null,
    knowledge: null,
    email: null,
    tracer,
    patchGenerator: new ModelPatchGenerator({ model, tracer }),
    investigator: new IncidentInvestigator({
      model,
      tracer,
      providers: { observability, sourceControl, knowledge: null },
    }),
    // L2 prepares a fix in a sandbox but may not open a pull request; L3 may.
    // Nothing here reaches production at either level.
    autonomy: config.readOnly ? 'L2' : 'L3',
  });

  const result = await workflow.run({
    service: config.service,
    repository: config.repository,
    baseBranch: config.baseBranch,
    slackChannel: config.slackChannel,
    deployment,
  });

  if (!result.alert) {
    status.lastOutcome = 'no monitor alerting';
    log(`watching ${config.service} at ${deployment.commitSha.slice(0, 12)} — no monitor alerting`);
    return;
  }
  if (!result.alert.escalate) {
    status.lastOutcome = `not escalated: ${result.alert.rationale}`;
    log(`not escalated: ${result.alert.rationale}`);
    return;
  }

  // From here an incident really happened, so the revision is marked handled
  // whatever the outcome — including a halt. Retrying a halt on a loop would
  // re-run a model against an unchanged world and reach the same place.
  handled.add(deployment.commitSha);
  status.handledRevisions = [...handled];
  status.incidents.push({
    revision: deployment.commitSha,
    at: new Date().toISOString(),
    outcome: result.haltReason ? `halted: ${result.haltReason}` : result.stage,
    pullRequest: result.pullRequest?.url ?? null,
  });
  status.lastOutcome = result.pullRequest ? `opened ${result.pullRequest.url}` : result.stage;

  const usage = result.investigation;
  log(
    `INCIDENT at ${deployment.commitSha.slice(0, 12)}: ${result.stage}` +
      (result.pullRequest ? ` — opened ${result.pullRequest.url}` : '') +
      (result.haltReason ? ` — halted: ${result.haltReason}` : ''),
  );
  if (usage) {
    log(
      `  model ${usage.model}: ${usage.modelCalls.length} call(s), ` +
        `${usage.toolCallCount} tool call(s), ${usage.totalInputTokens ?? '?'} in / ` +
        `${usage.totalOutputTokens ?? '?'} out tokens`,
    );
  }
  log(`  ${sink.toolCalls.length} tool call(s), ${sink.failedToolCalls().length} failed`);
}

async function main(): Promise<void> {
  const config = loadConfig();
  log(`Pager Developer worker starting\n  ${describeConfig(config)}`);

  const handled = new Set<string>();

  if (config.once) {
    await tick(config, handled);
    return;
  }

  // Bound before the first tick, so the host sees a live service immediately rather
  // than waiting out an investigation that can take minutes.
  serveStatus(Number(process.env.PORT ?? 10000));

  // A failing tick must never kill the watcher: an unreachable Datadog for one
  // minute is not a reason to stop watching production for the rest of the day.
  for (;;) {
    try {
      await tick(config, handled);
      status.ticks++;
      status.lastTickAt = new Date().toISOString();
    } catch (err) {
      status.ticks++;
      status.lastTickAt = new Date().toISOString();
      status.lastOutcome = `tick failed: ${err instanceof Error ? err.message : String(err)}`;
      log(`tick failed: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, config.intervalSeconds * 1000));
  }
}

void main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
