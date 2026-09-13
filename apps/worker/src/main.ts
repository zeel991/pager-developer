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
  NotionProvider,
  ResendProvider,
  SlackProvider,
  type SourceControlProvider,
  type TimeRange,
} from '@pager/providers';
import { AgentTracer, InMemorySink, lemmaFromEnv } from '@pager/observability';
import {
  AnthropicModel,
  IncidentInvestigator,
  IncidentWorkflow,
  ModelPatchGenerator,
  mergeButtonBlocks,
  telemetryWindowsFor,
  toRepositoryPath,
  type ProductionAlert,
} from '@pager/agents';
import { loadConfig, describeConfig, type WorkerConfig } from './config.ts';
import { renderDashboard } from './dashboard.ts';
import { handleSlackInteraction, type MergeApproval } from './merge-endpoint.ts';
import { deploymentFromRevision, probeDeployedRevision } from './deployed-revision.ts';

const log = (message: string): void => {
  console.log(`${new Date().toISOString()}  ${message}`);
};

/** Record where the agent is. Visible on the dashboard within 15 seconds. */
const enter = (stage: Stage, detail: string | null = null): void => {
  status.stage = stage;
  status.stageLog.push({ stage, at: new Date().toISOString(), detail });
  log(`  [${stage}] ${detail ?? STAGE_LABELS[stage]}`);
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
/**
 * One incident, recorded in enough detail to be reviewed after the fact.
 *
 * The split that matters runs through this type: `diagnosis`, `attribution` and
 * `confidence` are what a model concluded, while `reproduction` and `checks` are
 * exit codes from processes that really ran. The dashboard renders them differently
 * for that reason, and anything absent is shown as not-measured rather than passing.
 */
interface IncidentRecord {
  revision: string;
  at: string;
  durationMs: number;
  outcome: string;
  pullRequest: string | null;
  errorType: string | null;
  occurrences: number;
  location: string | null;
  /** Model conclusions. Inferences, never observations. */
  diagnosis: string | null;
  attribution: string | null;
  confidence: number | null;
  uncertainty: string | null;
  citedObservations: number;
  /** Observed: the exit codes of processes that really ran. */
  reproduction: { command: string; beforeExit: number | null; afterExit: number | null; proven: boolean } | null;
  checks: { kind: string; passed: boolean; skipped: boolean; exitCode: number | null }[];
  model: string | null;
  modelCalls: number;
  inputTokens: number | null;
  outputTokens: number | null;
  toolCalls: number;
  failedToolCalls: number;
}

/**
 * Where the agent is, right now.
 *
 * A watcher that only reports "busy" tells an observer nothing about whether it is
 * reading logs or running a test suite, and an investigation takes minutes. Each
 * stage is stamped as it is entered so the dashboard shows progress rather than a
 * spinner — and so a run that stalls shows WHERE it stalled.
 */
export type Stage =
  | 'idle'
  | 'reading_deployed_revision'
  | 'checking_monitors'
  | 'investigating'
  | 'reproducing'
  | 'patching'
  | 'validating'
  | 'opening_pull_request'
  | 'writing_up'
  | 'done';

export const STAGE_LABELS: Record<Stage, string> = {
  idle: 'Watching production',
  reading_deployed_revision: 'Asking the service what revision it runs',
  checking_monitors: 'Checking Datadog monitors and logs',
  investigating: 'Investigating — reading logs, code and the deployment diff',
  reproducing: 'Writing a regression test and running it against the deployed code',
  patching: 'Writing the patch',
  validating: 'Running the repository’s own checks',
  opening_pull_request: 'Opening a pull request for review',
  writing_up: 'Verifying recovery and filing the postmortem',
  done: 'Handed off to a human',
};

interface StageEvent {
  stage: Stage;
  at: string;
  detail: string | null;
}

interface WorkerStatus {
  startedAt: string;
  /** Where the current or most recent run got to. */
  stage: Stage;
  /** Every stage this run entered, in order. Cleared when a new run starts. */
  stageLog: StageEvent[];
  lastTickAt: string | null;
  lastOutcome: string | null;
  ticks: number;
  /** True while a tick is running, so the page can say "investigating" honestly. */
  busy: boolean;
  busySince: string | null;
  incidents: IncidentRecord[];
  /** Revisions already acted on, so a red monitor produces one PR and not sixty. */
  handledRevisions: string[];
  /** Incidents whose pull request is open, waiting on a human to merge. */
  awaitingMerge: { pullRequest: number; incidentKey: string; url: string; since: string }[];
  /** Postmortems filed after a merge. */
  writeUps: { incidentKey: string; at: string; recovery: string; notionUrl: string | null; emailed: number }[];
  /** Merges a person authorised from Slack. The agent decided none of them. */
  approvals: MergeApproval[];
  config: {
    service: string;
    repository: string;
    model: string;
    intervalSeconds: number;
    readOnly: boolean;
    mergeButton: boolean;
    autonomy: string;
  } | null;
}

const status: WorkerStatus = {
  startedAt: new Date().toISOString(),
  stage: 'idle',
  stageLog: [],
  lastTickAt: null,
  lastOutcome: null,
  ticks: 0,
  busy: false,
  busySince: null,
  incidents: [],
  handledRevisions: [],
  awaitingMerge: [],
  writeUps: [],
  approvals: [],
  config: null,
};

function serveStatus(port: number, config: WorkerConfig, sourceControl: SourceControlProvider): void {
  createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;

    // The one endpoint that can change production. Everything it needs to refuse a
    // request it does not trust lives inside the handler.
    if (request.method === 'POST' && path === '/slack/interactions') {
      void handleSlackInteraction(request, response, {
        signingSecret: config.slackSigningSecret,
        enabled: config.mergeButton,
        autonomy: config.autonomy,
        repository: config.repository,
        sourceControl,
        approvals: status.approvals,
        log,
      });
      return;
    }
    if (path === '/health') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ status: 'ok', service: 'pager-developer-worker' }));
      return;
    }
    if (path === '/status') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(status, null, 2));
      return;
    }
    if (path === '/') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(renderDashboard(status));
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'not_found' }));
  }).listen(port, '0.0.0.0', () => log(`status endpoint listening on ${port}`));
}

/**
 * What an incident needs after its pull request is merged.
 *
 * Held in memory between ticks because the aftermath belongs to the same incident
 * as the diagnosis, and the workflow cannot reconstruct the alert, the thread or
 * the windows from a pull request number alone. A restart forgets these, so a
 * merge that lands while the worker is down produces no write-up — stated on the
 * dashboard rather than hidden.
 */
interface PendingMerge {
  pullRequest: number;
  incidentKey: string;
  revision: string;
  slackThread: { id: string; channel: string };
  alert: ProductionAlert;
  rootCause: string;
  baselineWindow: TimeRange;
  incidentWindow: TimeRange;
  postRemediationWindow: TimeRange;
  url: string;
  since: Date;
}

const pending = new Map<number, PendingMerge>();

/**
 * Has a human merged anything we are waiting on?
 *
 * Checked before the monitor, every tick, because the write-up is owed whether or
 * not production is currently alerting — and because an incident that was fixed
 * and closed should stop being carried around.
 */
async function settleMerged(
  config: WorkerConfig,
  workflow: IncidentWorkflow,
  sourceControl: SourceControlProvider,
): Promise<void> {
  for (const [number, ctxItem] of [...pending]) {
    let state: string;
    try {
      state = (await sourceControl.getPullRequest(config.repository, number)).state;
    } catch (err) {
      log(`could not read #${number}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    if (state === 'open') continue;
    if (state !== 'merged') {
      // Closed without merging is a human deciding against the fix. Respect it.
      log(`#${number} was closed without merging; dropping it`);
      pending.delete(number);
      status.awaitingMerge = [...pending.values()].map(toAwaiting);
      continue;
    }

    enter('writing_up', `#${number} was merged — verifying recovery and filing the write-up`);
    const after = await workflow.completeAfterMerge({
      service: config.service,
      repository: config.repository,
      baseBranch: config.baseBranch,
      slackChannel: config.slackChannel,
      deployedRevision: ctxItem.revision,
      pullRequestNumber: number,
      incidentKey: ctxItem.incidentKey,
      slackThread: ctxItem.slackThread,
      alert: ctxItem.alert,
      rootCause: ctxItem.rootCause,
      baselineWindow: ctxItem.baselineWindow,
      incidentWindow: ctxItem.incidentWindow,
      postRemediationWindow: ctxItem.postRemediationWindow,
      ...(config.email ? { teamEmails: config.email.to } : {}),
    });

    status.writeUps.unshift({
      incidentKey: ctxItem.incidentKey,
      at: new Date().toISOString(),
      recovery: after.recoveryVerdict ?? 'unknown',
      notionUrl: after.writeUpUrl,
      emailed: after.emailed.length,
    });
    log(
      `  #${number}: recovery ${after.recoveryVerdict ?? 'unknown'}` +
        (after.writeUpUrl ? `, written up at ${after.writeUpUrl}` : ', no write-up filed') +
        (after.emailed.length ? `, mailed ${after.emailed.length}` : ''),
    );

    pending.delete(number);
    status.awaitingMerge = [...pending.values()].map(toAwaiting);
  }
}

function toAwaiting(p: PendingMerge): WorkerStatus['awaitingMerge'][number] {
  return { pullRequest: p.pullRequest, incidentKey: p.incidentKey, url: p.url, since: p.since.toISOString() };
}

async function tick(config: WorkerConfig, handled: Set<string>): Promise<void> {
  const startedTick = Date.now();
  status.stageLog = [];
  enter('reading_deployed_revision');

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

  // Both optional. A missing integration degrades the handoff; it never blocks the
  // repair, and the workflow already treats absence as absence rather than failure.
  const knowledge = config.notion
    ? new NotionProvider({
        baseUrl: 'https://api.notion.com',
        token: config.notion.token,
        parentPageId: config.notion.parentPageId,
      })
    : null;
  const email = config.email
    ? new ResendProvider({
        baseUrl: 'https://api.resend.com',
        apiKey: config.email.apiKey,
        from: config.email.from,
      })
    : null;

  const workflow = new IncidentWorkflow({
    observability,
    sourceControl,
    messaging,
    issueTracker: null,
    knowledge,
    email,
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

  // Settle anything a human merged since the last tick. This runs before the health
  // probe and before the incident logic, and not inside them, because every path
  // below returns early: no alert, a revision already handled, a fix branch that
  // already exists — and that last one is precisely the state an incident awaiting
  // merge is in. The write-up is owed whether or not production is alerting now.
  await settleMerged(config, workflow, sourceControl);

  // 1. Ask the service what it is running. Everything downstream depends on this
  //    being observed rather than assumed, so a failure here ends the tick.
  const probe = await probeDeployedRevision(config.healthUrl);
  if (!probe.sha) {
    enter('idle', `Skipped: ${probe.problem}`);
    return;
  }
  enter('checking_monitors', `Production is running ${probe.sha.slice(0, 12)}`);

  const deployment = await deploymentFromRevision(sourceControl, {
    repository: config.repository,
    service: config.service,
    sha: probe.sha,
    observedAt: probe.reportedAt,
  });

  // 2. One incident per deployed revision. A monitor stays red for as long as the
  //    bug is live, and an agent that re-opened a pull request on every poll would
  //    be indistinguishable from a denial of service against its own reviewers.
  //
  //    The in-memory set is only a fast path. The durable record is the fix branch
  //    itself: its name is derived from the revision, so asking whether it exists
  //    asks the repository — which survives the restarts this process does not.
  //    Without that, every redeploy re-opens a pull request for a bug that already
  //    has one, and we observed exactly that: three pull requests for one defect.
  const incidentKey = `INC-${deployment.commitSha.slice(0, 12).toUpperCase()}`;
  const fixBranch = `pager/${incidentKey.toLowerCase()}`;

  if (handled.has(deployment.commitSha)) {
    status.lastOutcome = `already handled ${deployment.commitSha.slice(0, 12)}`;
    log(`watching ${config.service} at ${deployment.commitSha.slice(0, 12)} — already handled`);
    return;
  }

  const existing = await sourceControl.getBranch(config.repository, fixBranch).catch(() => null);
  if (existing) {
    // A human may have closed that pull request without merging. Treating the branch
    // as done is deliberate: re-opening something a person has already seen and
    // decided about is worse than staying quiet. A new deployment changes the
    // revision, which changes the branch, and the incident can open again.
    handled.add(deployment.commitSha);
    status.handledRevisions = [...handled];
    status.lastOutcome =
      `${fixBranch} already exists — a fix for ${deployment.commitSha.slice(0, 12)} was ` +
      `already prepared, by this process or an earlier one`;
    log(`watching ${config.service} at ${deployment.commitSha.slice(0, 12)} — ${fixBranch} already exists`);
    return;
  }


  const result = await workflow.run({
    onStage: (name: string, summary: string) => {
      const map: Record<string, Stage> = {
        identified: 'investigating',
        ticket_opened: 'investigating',
        team_notified: 'investigating',
        reproducing: 'reproducing',
        patching: 'patching',
        validating: 'validating',
        pr_opened: 'opening_pull_request',
        awaiting_merge: 'done',
        halted: 'done',
      };
      const stage = map[name];
      if (stage) enter(stage, summary.slice(0, 160));
    },
    service: config.service,
    repository: config.repository,
    baseBranch: config.baseBranch,
    slackChannel: config.slackChannel,
    deployment,
    // Derived from the revision, so the branch this produces is the durable record
    // that stops a restart re-opening the same pull request.
    incidentKey,
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

  const findings = result.investigation?.findings ?? null;
  const cluster = result.alert.primary;
  const frame = cluster?.topApplicationFrame ?? null;

  status.incidents.unshift({
    revision: deployment.commitSha,
    at: new Date().toISOString(),
    durationMs: Date.now() - startedTick,
    outcome: result.haltReason ? `halted: ${result.haltReason}` : result.stage,
    pullRequest: result.pullRequest?.url ?? null,
    errorType: cluster?.errorType ?? null,
    occurrences: cluster?.count ?? 0,
    location: frame ? `${toRepositoryPath(frame.file)}:${frame.line}` : null,
    diagnosis: findings?.diagnosis ?? null,
    attribution: findings?.attribution.verdict ?? null,
    confidence: findings?.confidence ?? null,
    uncertainty: findings?.uncertainty ?? null,
    citedObservations: findings?.evidence.length ?? 0,
    reproduction: result.reproduction
      ? {
          command: result.reproduction.command,
          beforeExit: result.reproduction.beforeFix.exitCode,
          afterExit: result.reproduction.afterFix?.exitCode ?? null,
          proven: result.reproduction.proven,
        }
      : null,
    checks: result.validation.map((v) => ({
      kind: v.kind,
      passed: v.passed,
      skipped: v.skipped,
      exitCode: v.exitCode,
    })),
    model: result.investigation?.model ?? null,
    modelCalls: result.investigation?.modelCalls.length ?? 0,
    inputTokens: result.investigation?.totalInputTokens ?? null,
    outputTokens: result.investigation?.totalOutputTokens ?? null,
    toolCalls: sink.toolCalls.length,
    failedToolCalls: sink.failedToolCalls().length,
  });
  status.lastOutcome = result.pullRequest ? `opened ${result.pullRequest.url}` : result.stage;
  enter('done', result.pullRequest ? `Opened ${result.pullRequest.url}` : (result.haltReason ?? result.stage).slice(0, 160));

  // Offer the merge to a person, in the channel where they are already reading about
  // the incident. The button carries one pull request in one repository; it is not a
  // standing grant, and the agent still decides nothing by posting it.
  // Only track it when there is a thread to narrate the conclusion back into; a
  // write-up with nowhere to land is worse than a missing one, because it reads as
  // an unrelated message in the channel.
  if (result.pullRequest && result.alert && result.slackThreadTs) {
    // Everything the aftermath needs that a pull request number cannot carry.
    const windows = telemetryWindowsFor(result.alert.primary?.firstSeen ?? result.alert.firedAt);
    pending.set(result.pullRequest.number, {
      pullRequest: result.pullRequest.number,
      incidentKey,
      revision: deployment.commitSha,
      slackThread: { id: result.slackThreadTs, channel: config.slackChannel },
      alert: result.alert,
      rootCause: result.patch?.rootCause ?? 'see the pull request',
      baselineWindow: windows[0],
      incidentWindow: { from: windows[1].from, to: new Date() },
      postRemediationWindow: { from: new Date(), to: new Date(Date.now() + 15 * 60_000) },
      url: result.pullRequest.url,
      since: new Date(),
    });
    status.awaitingMerge = [...pending.values()].map(toAwaiting);
  }

  if (config.mergeButton && result.pullRequest) {
    const pr = result.pullRequest;
    await messaging
      .openThread(
        config.slackChannel,
        `${incidentKey}: #${pr.number} is ready for review.`,
        mergeButtonBlocks({
          headline: `${incidentKey} — fix ready for review`,
          summary: [
            `*Root cause* ${result.patch?.rootCause ?? 'see the pull request'}`,
            `*Reproduced* \`${result.reproduction?.command ?? ''}\` exited ` +
              `${result.reproduction?.beforeFix.exitCode} before the patch and ` +
              `${result.reproduction?.afterFix?.exitCode ?? 'n/a'} after it`,
            `*Checks* ${result.validation.filter((v) => !v.skipped).map((v) => `${v.kind}=${v.passed ? 'pass' : 'FAIL'}`).join(', ') || 'none ran'}` +
              (result.validation.some((v) => v.skipped)
                ? ` · not run: ${result.validation.filter((v) => v.skipped).map((v) => v.kind).join(', ')}`
                : ''),
            `*Patch authored by* ${result.patch?.kind === 'model' ? `model \`${result.investigation?.model ?? config.model}\`` : (result.patch?.kind ?? 'unknown')}`,
          ].join('\n'),
          pullRequestUrl: pr.url,
          action: { repository: config.repository, pullRequest: pr.number, incidentKey },
        }),
      )
      .catch((err: unknown) => {
        log(`could not post the merge button: ${err instanceof Error ? err.message : String(err)}`);
      });
  }

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
  status.config = {
    service: config.service,
    repository: config.repository,
    model: config.model,
    intervalSeconds: config.intervalSeconds,
    readOnly: config.readOnly,
    mergeButton: config.mergeButton,
    autonomy: config.autonomy,
  };

  const handled = new Set<string>();

  if (config.once) {
    await tick(config, handled);
    return;
  }

  // Bound before the first tick, so the host sees a live service immediately rather
  // than waiting out an investigation that can take minutes.
  serveStatus(
    Number(process.env.PORT ?? 10000),
    config,
    new GitHubProvider({ baseUrl: 'https://api.github.com', token: config.githubToken }),
  );

  // A failing tick must never kill the watcher: an unreachable Datadog for one
  // minute is not a reason to stop watching production for the rest of the day.
  for (;;) {
    status.busy = true;
    status.busySince = new Date().toISOString();
    try {
      await tick(config, handled);
      status.ticks++;
      status.lastTickAt = new Date().toISOString();
    } catch (err) {
      status.ticks++;
      status.lastTickAt = new Date().toISOString();
      status.lastOutcome = `tick failed: ${err instanceof Error ? err.message : String(err)}`;
      log(`tick failed: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`);
    } finally {
      status.busy = false;
      status.busySince = null;
      if (status.stage !== 'done') enter('idle');
    }
    await new Promise((resolve) => setTimeout(resolve, config.intervalSeconds * 1000));
  }
}

void main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
