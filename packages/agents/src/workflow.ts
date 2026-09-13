import type { AgentRunContext, AgentTracer } from '@pager/observability';
import type {
  EmailProvider,
  IssueTrackerProvider,
  MetricName,
  KnowledgeProvider,
  MessagingProvider,
  ObservabilityProvider,
  PullRequest,
  SourceControlProvider,
  TimeRange,
} from '@pager/providers';
import {
  ReproductionAgent,
  Sandbox,
  ValidationEngine,
  describeReproduction,
  profileRepository,
  type ReproductionAttempt,
  type ValidationRun,
} from '@pager/sandbox';
import { ProductionWatcher, describeAlert, type ProductionAlert } from './production-watcher.js';
import { toRepositoryPath } from './log-analysis.js';
import {
  NoPatchGenerator,
  type PatchGenerator,
  type PatchProposal,
  type RegressionTestProposal,
} from './patch-generator.js';
import { CommunicationAgent, formatFixReady } from './communication.js';
import { RecoveryVerifier, type RecoveryVerification } from './recovery.js';
import type { IncidentEngine } from './incident-engine.js';
import type { IncidentState } from '@pager/core';
import type {
  AgentRunRepository,
  EvidenceRepository,
  IncidentRow,
  TelemetryRepository,
} from '@pager/db';

/**
 * The incident workflow, end to end.
 *
 * Datadog watches production. When a monitor fires on something undocumented, this
 * runs: identify, file a ticket, tell the team, fix it on a branch, verify the fix
 * with real test runs, ask for a merge, wait for a human, confirm recovery, write it
 * up and mail it out.
 *
 * Orchestration is deterministic throughout. The only step that needs a reasoning
 * model is authoring the regression test and the patch, and that is isolated behind
 * `PatchGenerator`. Without one the workflow still does everything else and stops
 * with the reproduction and the located frame in hand, which is a useful place to
 * hand over to a human — rather than guessing at a patch, which would be the most
 * dangerous thing it could do.
 */

export type WorkflowStage =
  | 'watching'
  | 'not_escalated'
  | 'identified'
  | 'ticket_opened'
  | 'team_notified'
  | 'reproducing'
  | 'patching'
  | 'validating'
  | 'pr_opened'
  | 'awaiting_merge'
  | 'merged'
  | 'verifying_recovery'
  | 'recovered'
  | 'written_up'
  | 'mailed'
  | 'halted';

export interface WorkflowStep {
  stage: WorkflowStage;
  at: Date;
  summary: string;
  detail?: Record<string, unknown>;
}

/**
 * Durable state for the workflow.
 *
 * Optional. Without it the workflow still runs end to end — which keeps the tests
 * fast and means a scenario can be exercised without a database — but nothing is
 * recorded, so the dashboard has nothing to show and no state machine is enforced.
 * With it, every stage transition passes through the incident engine's allow-list.
 */
export interface WorkflowPersistence {
  engine: IncidentEngine;
  evidence: EvidenceRepository;
  agentRuns: AgentRunRepository;
  telemetry: TelemetryRepository;
  organizationId: string;
  serviceId: string;
}

export interface WorkflowDeps {
  observability: ObservabilityProvider;
  sourceControl: SourceControlProvider;
  messaging: MessagingProvider;
  issueTracker: IssueTrackerProvider | null;
  knowledge: KnowledgeProvider | null;
  email: EmailProvider | null;
  tracer: AgentTracer;
  patchGenerator?: PatchGenerator;
  persistence?: WorkflowPersistence;
}

export interface WorkflowInput {
  service: string;
  repository: string;
  /** Branch production runs. The sandbox is built from its head. */
  baseBranch?: string;
  slackChannel: string;
  /** Recipients of the post-incident write-up. */
  teamEmails?: string[];
  incidentKey?: string;
  sandboxRoot?: string;
}

export interface WorkflowResult {
  stage: WorkflowStage;
  steps: WorkflowStep[];
  alert: ProductionAlert | null;
  issue: { key: string; url: string } | null;
  reproduction: ReproductionAttempt | null;
  patch: PatchProposal | null;
  validation: ValidationRun[];
  pullRequest: PullRequest | null;
  recovery: RecoveryVerification | null;
  writeUpUrl: string | null;
  emailed: string[];
  /** The persisted incident, when persistence is configured. */
  incident: IncidentRow | null;
  /** Why the workflow stopped where it did. */
  haltReason: string | null;
}

export class IncidentWorkflow {
  private readonly generator: PatchGenerator;

  constructor(private readonly deps: WorkflowDeps) {
    this.generator = deps.patchGenerator ?? new NoPatchGenerator();
  }

  async run(input: WorkflowInput): Promise<WorkflowResult> {
    const steps: WorkflowStep[] = [];
    const result: WorkflowResult = {
      stage: 'watching',
      steps,
      alert: null,
      issue: null,
      reproduction: null,
      patch: null,
      validation: [],
      pullRequest: null,
      recovery: null,
      writeUpUrl: null,
      emailed: [],
      incident: null,
      haltReason: null,
    };

    const step = (stage: WorkflowStage, summary: string, detail?: Record<string, unknown>): void => {
      result.stage = stage;
      steps.push({ stage, at: new Date(), summary, ...(detail ? { detail } : {}) });
    };

    /**
     * Run an agent, tagged with the incident once one exists.
     *
     * Every agent run goes through this rather than calling the tracer directly, so
     * a run cannot be orphaned by a call site forgetting to pass the id — which
     * would hide it from the incident page.
     */
    const trace = <T>(name: string, fn: (ctx: AgentRunContext) => Promise<T>): Promise<T> =>
      this.deps.tracer.run(name, { incidentId: result.incident?.id ?? null }, fn);

    /**
     * Move the persisted incident to a new state.
     *
     * The engine validates against the allow-list, so an illegal transition throws
     * and is audited rather than quietly applied. Without persistence this is a
     * no-op, which is why the step log is kept separately — the narrative survives
     * even when there is no database.
     */
    const advance = async (to: IncidentState, summary: string): Promise<void> => {
      const p = this.deps.persistence;
      if (!p || !result.incident) return;
      result.incident = await p.engine.transition(result.incident.id, { to, summary, actor: 'agent:IncidentWorkflow' });
    };

    const note = async (kind: string, summary: string): Promise<void> => {
      const p = this.deps.persistence;
      if (!p || !result.incident) return;
      await p.engine.note(result.incident.id, { kind, summary });
    };

    const halt = async (reason: string): Promise<WorkflowResult> => {
      result.haltReason = reason;
      step('halted', reason);
      // An incident that stopped without resolving stays open and says why. It is
      // not marked resolved, and it is not silently abandoned.
      await note('workflow_halted', reason);
      return result;
    };

    // ── 1. Datadog is watching ───────────────────────────────────────────────
    const watcher = new ProductionWatcher(this.deps.observability, this.deps.knowledge);
    const preIncidentRuns: string[] = [];
    const alert = await this.deps.tracer.run('ProductionWatcher', { input: { service: input.service } }, (ctx) => {
      // Detection happens before an incident exists, so this run is linked to it
      // afterwards. Otherwise the incident page would omit the run that opened it.
      preIncidentRuns.push(ctx.agentRunId);
      return watcher.check(ctx, input.service);
    });
    result.alert = alert;

    if (!alert) {
      step('watching', `No monitor alerting for ${input.service}. Production looks healthy.`);
      return result;
    }
    if (!alert.escalate) {
      // Not every alert is an incident, and saying so is the point.
      result.stage = 'not_escalated';
      steps.push({ stage: 'not_escalated', at: new Date(), summary: alert.rationale });
      return result;
    }

    // ── 2. Identify ──────────────────────────────────────────────────────────
    const cluster = alert.primary!;
    const frame = cluster.topApplicationFrame;
    step('identified', describeAlert(alert), {
      errorType: cluster.errorType,
      occurrences: cluster.count,
      file: frame ? toRepositoryPath(frame.file) : null,
      line: frame?.line ?? null,
    });

    const title = `${input.service}: ${cluster.errorType ?? 'Error'} on ${cluster.affectedRoutes[0] ?? 'production'}`;

    // Open the incident before anything else happens, so every subsequent action is
    // recorded against it rather than floating free.
    const persistence = this.deps.persistence;
    if (persistence) {
      result.incident = await persistence.engine.open({
        organizationId: persistence.organizationId,
        serviceId: persistence.serviceId,
        title,
        severity: severityFor(cluster.count),
      });
      await persistence.agentRuns.attachToIncident(preIncidentRuns, result.incident.id);
      await this.recordAlertEvidence(persistence, result.incident.id, alert);
      await this.captureTelemetry(persistence, result.incident.id, alert, trace);
      await advance('INVESTIGATING', describeAlert(alert));
      // A stack trace locates the failure. That is a suspicion, not a verdict.
      await advance(
        'ROOT_CAUSE_SUSPECTED',
        frame
          ? `Stack trace locates the failure at ${toRepositoryPath(frame.file)}:${frame.line}.`
          : 'No application frame in the stack trace; the location is unknown.',
      );
    }

    const incidentKey = input.incidentKey ?? result.incident?.key ?? `INC-${Date.now().toString(36).toUpperCase()}`;

    // ── 3. Jira ticket ───────────────────────────────────────────────────────
    if (this.deps.issueTracker) {
      const issue = await trace('IssueTracker', async (ctx) => {
        const { value } = await ctx.tool('issues.createIssue', { title }, () =>
          this.deps.issueTracker!.createIssue({
            title,
            description: this.ticketBody(alert, incidentKey),
            priority: 'urgent',
            labels: ['pager-developer', 'production'],
          }),
        );
        return value;
      });
      result.issue = { key: issue.key, url: issue.url };
      step('ticket_opened', `Opened ${issue.key}`, { url: issue.url });

      // Walk the ticket through its workflow rather than jumping states. Real Jira
      // projects rarely allow To Do -> Resolved directly, and a ticket left in the
      // wrong state is a lie about what is being worked on.
      await this.deps.tracer
        .run('IssueTracker', {}, async (ctx) => {
          await ctx.tool('issues.startProgress', { key: issue.key }, () =>
            this.deps.issueTracker!.updateIssue(issue.key, { state: 'in_progress' }),
          );
        })
        .catch(() => undefined);
    } else {
      step('ticket_opened', 'No issue tracker configured; skipped ticket creation.');
    }

    // ── 4. Slack ─────────────────────────────────────────────────────────────
    const comms = new CommunicationAgent(this.deps.messaging);
    const thread = await trace('CommunicationAgent', (ctx) =>
      comms.openThread(ctx, input.slackChannel, this.openingMessage(alert, incidentKey, result.issue)),
    );
    step('team_notified', `Posted to ${input.slackChannel}`, { threadTs: thread.id });

    // ── 5. Work the fix on a branch ──────────────────────────────────────────
    const baseBranch = input.baseBranch ?? 'main';
    const history = await trace('RepositoryInvestigator', async (ctx) => {
      const { value } = await ctx.tool('github.listCommits', { repo: input.repository }, () =>
        this.deps.sourceControl.listCommits(input.repository, { ref: baseBranch, limit: 1 }),
      );
      return value;
    });
    const headSha = history[0]?.sha;
    if (!headSha) return await halt(`Could not resolve the head of ${baseBranch}; cannot build a sandbox.`);

    const sandbox = await Sandbox.create(this.deps.sourceControl, input.repository, headSha, {
      ...(input.sandboxRoot ? { rootDir: input.sandboxRoot } : {}),
    });

    try {
      const profile = await profileRepository(sandbox);
      const validation = new ValidationEngine(sandbox);
      const reproduction = new ReproductionAgent(sandbox, validation);

      const context = {
        service: input.service,
        repository: input.repository,
        revision: headSha,
        cluster,
        changedFiles: [],
        sources: await this.readSuspectSources(sandbox, cluster),
        testCommand: profile.testCommand,
      };

      // 5a. A test that demonstrates the failure.
      const proposedTest: RegressionTestProposal | null =
        await this.generator.proposeRegressionTest(context);
      if (!proposedTest) {
        return await halt(
          `No patch generator is configured, so no regression test could be written. ` +
            `The failure is located at ${frame ? `${toRepositoryPath(frame.file)}:${frame.line}` : 'an unknown frame'} ` +
            `and the sandbox is ready at the deployed revision.`,
        );
      }

      step('reproducing', `Writing a regression test (${proposedTest.kind}).`, { path: proposedTest.path });
      await advance('REPRODUCING', `Writing a regression test (${proposedTest.kind}).`);
      const attempt = await reproduction.demonstrateFailure({
        testPath: proposedTest.path,
        testSource: proposedTest.source,
        command: profile.testCommand ?? 'node --test',
      });
      result.reproduction = attempt;

      if (attempt.failureReason) {
        return await halt(`Reproduction failed: ${attempt.failureReason}`);
      }
      step('reproducing', describeReproduction(attempt));
      // The failure reproduced, which is what confirms the root cause.
      await advance('ROOT_CAUSE_CONFIRMED', describeReproduction(attempt));

      // 5b. The patch.
      const patch = await this.generator.proposePatch(context);
      if (!patch) return await halt('The patch generator produced no patch.');
      result.patch = patch;

      step('patching', `Applying a ${patch.kind} patch to ${patch.files.length} file(s).`, {
        rootCause: patch.rootCause,
      });
      await advance('FIXING', `Applying a ${patch.kind} patch: ${patch.rootCause}`);
      for (const file of patch.files) await sandbox.writeFile(file.path, file.content);

      // 5c. Verify. The reproduction must now pass, and so must everything else.
      const confirmed = await reproduction.confirmFix(attempt);
      result.reproduction = confirmed;
      if (!confirmed.proven) {
        return await halt(`Patch rejected: ${confirmed.failureReason}`);
      }

      await advance('VALIDATING', 'Running deterministic verification.');
      const summary = await validation.runAll(profile);
      result.validation = [confirmed.afterFix!, ...summary.runs];
      step('validating', `Verification: ${summary.allPassed ? 'passed' : 'FAILED'}`, {
        ran: summary.runs.filter((r) => !r.skipped).map((r) => r.kind),
        skipped: summary.skipped,
      });
      if (!summary.allPassed) {
        return await halt('Deterministic verification did not pass; the patch is not offered for merge.');
      }

      // 5d. Branch, commit, pull request.
      const branch = `pager/${incidentKey.toLowerCase()}`;
      const pr = await trace('FixAgent', async (ctx) => {
        await ctx.tool('github.createBranch', { repo: input.repository, branch }, () =>
          this.deps.sourceControl.createBranch(input.repository, headSha, branch),
        );
        await ctx.tool('github.commit', { repo: input.repository, branch }, () =>
          this.deps.sourceControl.commitFiles(input.repository, {
            branch,
            message: `${incidentKey}: ${patch.rootCause}`,
            author: 'pager-developer',
            changes: [
              ...patch.files.map((f) => ({ path: f.path, content: f.content })),
              { path: proposedTest.path, content: proposedTest.source },
            ],
          }),
        );
        const { value } = await ctx.tool('github.createPullRequest', { repo: input.repository }, () =>
          this.deps.sourceControl.createPullRequest(input.repository, {
            title: `${incidentKey}: ${patch.rootCause}`,
            body: this.pullRequestBody(incidentKey, alert, patch, confirmed, result.validation, proposedTest),
            headRef: branch,
            baseRef: baseBranch,
          }),
        );
        return value;
      });

      result.pullRequest = pr;
      step('pr_opened', `Opened #${pr.number}`, { url: pr.url });
      await advance('FIX_READY', `Pull request #${pr.number} opened: ${pr.url}`);

      // ── 6. Ask for a merge ─────────────────────────────────────────────────
      await trace('CommunicationAgent', (ctx) =>
        comms.reply(
          ctx,
          thread,
          formatFixReady(
            patch.rootCause,
            {
              reproduced: true,
              reproductionDescription: describeReproduction(confirmed),
              checks: result.validation.map((v) => ({
                kind: v.kind,
                passed: v.passed,
                skipped: v.skipped,
                testsPassed: v.testsPassed,
              })),
              pullRequestUrl: pr.url,
              pullRequestNumber: pr.number,
            },
            patch.risks,
          ),
        ),
      );
      step('awaiting_merge', `Asked the team to review and merge #${pr.number}.`);
      await advance('AWAITING_APPROVAL', `Awaiting human review and merge of #${pr.number}.`);

      return result;
    } finally {
      await sandbox.dispose();
    }
  }

  /**
   * Resume after a human merges the pull request.
   *
   * Split from `run` because the wait is unbounded and belongs to a human. Polling
   * inside the first call would hold an agent run open for hours and make the merge
   * look like something the agent did.
   */
  async completeAfterMerge(
    input: WorkflowInput & {
      pullRequestNumber: number;
      incidentKey: string;
      /** Persisted incident id, when persistence is configured. */
      incidentId?: string | null;
      slackThread: { id: string; channel: string };
      issueKey?: string | null;
      baselineWindow: TimeRange;
      incidentWindow: TimeRange;
      postRemediationWindow: TimeRange;
      rootCause: string;
      alert: ProductionAlert;
    },
  ): Promise<WorkflowResult> {
    const steps: WorkflowStep[] = [];
    const result: WorkflowResult = {
      stage: 'merged',
      steps,
      alert: input.alert,
      issue: input.issueKey ? { key: input.issueKey, url: '' } : null,
      reproduction: null,
      patch: null,
      validation: [],
      pullRequest: null,
      recovery: null,
      writeUpUrl: null,
      emailed: [],
      incident: null,
      haltReason: null,
    };
    const step = (stage: WorkflowStage, summary: string): void => {
      result.stage = stage;
      steps.push({ stage, at: new Date(), summary });
    };

    const persistence = this.deps.persistence;
    const incidentId = input.incidentId ?? null;

    const trace = <T>(name: string, fn: (ctx: AgentRunContext) => Promise<T>): Promise<T> =>
      this.deps.tracer.run(name, { incidentId }, fn);

    const advance = async (to: IncidentState, summary: string): Promise<void> => {
      if (!persistence || !incidentId) return;
      result.incident = await persistence.engine.transition(incidentId, {
        to,
        summary,
        actor: 'agent:IncidentWorkflow',
      });
    };
    const note = async (kind: string, summary: string): Promise<void> => {
      if (!persistence || !incidentId) return;
      await persistence.engine.note(incidentId, { kind, summary });
    };

    // Confirm the merge from the provider rather than trusting the caller.
    const pr = await trace('FixAgent', async (ctx) => {
      const { value } = await ctx.tool('github.getPullRequest', { number: input.pullRequestNumber }, () =>
        this.deps.sourceControl.getPullRequest(input.repository, input.pullRequestNumber),
      );
      return value;
    });
    result.pullRequest = pr;

    if (pr.state !== 'merged') {
      result.haltReason = `Pull request #${pr.number} is ${pr.state}, not merged. Nothing to verify yet.`;
      step('awaiting_merge', result.haltReason);
      await note('merge_pending', result.haltReason);
      return result;
    }
    step('merged', `#${pr.number} merged.`);
    // The human merge is the approval. Recording it as such is the whole point of
    // the gate: the only production-affecting act was performed by a person.
    await advance('APPROVED', `#${pr.number} merged by a human.`);
    await advance('DEPLOYING_FIX', `Merged fix shipping for ${input.service}.`);
    await advance('VERIFYING_RECOVERY', 'Watching telemetry for a return to baseline.');

    // ── 7. Watch Datadog again ───────────────────────────────────────────────
    const verifier = new RecoveryVerifier(this.deps.observability);
    const recovery = await this.deps.tracer.run('RecoveryVerifier', {}, (ctx) =>
      verifier.verify(ctx, {
        service: input.service,
        metrics: ['error_rate', 'http_5xx_rate', 'latency_p95'],
        baselineWindow: input.baselineWindow,
        incidentWindow: input.incidentWindow,
        postRemediationWindow: input.postRemediationWindow,
      }),
    );
    result.recovery = recovery;
    step('verifying_recovery', `Recovery ${recovery.recovered ? 'verified' : 'NOT verified'}.`);

    if (!recovery.recovered) {
      // The incident stays open. A merged fix is not a recovery.
      result.haltReason =
        'Signals have not returned to baseline after the merge. The incident remains open ' +
        'and no write-up is sent, because there is nothing settled to report.';
      step('halted', result.haltReason);
      await note('recovery_not_verified', result.haltReason);
      return result;
    }
    step('recovered', 'Signals returned to baseline.');
    // RESOLVED is reachable only from VERIFYING_RECOVERY, so this is the single
    // point in the system where an incident can close.
    await advance('RESOLVED', 'Signals returned to baseline; recovery verified.');

    // ── 8. Write it up in Notion ─────────────────────────────────────────────
    const writeUp = this.writeUp(input.incidentKey, input.alert, input.rootCause, pr, recovery);
    if (this.deps.knowledge) {
      const doc = await trace('CommunicationAgent', async (ctx) => {
        const { value } = await ctx.tool('notion.createDocument', { title: writeUp.title }, () =>
          this.deps.knowledge!.createDocument({ title: writeUp.title, content: writeUp.body }),
        );
        return value;
      });
      result.writeUpUrl = doc.url;
      step('written_up', `Wrote ${writeUp.title} to Notion.`);
    } else {
      step('written_up', 'No knowledge provider configured; skipped the write-up.');
    }

    // ── 9. Mail the team ─────────────────────────────────────────────────────
    const recipients = input.teamEmails ?? [];
    if (this.deps.email && recipients.length > 0) {
      await trace('CommunicationAgent', async (ctx) => {
        await ctx.tool('email.send', { to: recipients }, () =>
          this.deps.email!.send({
            to: recipients,
            subject: `${input.incidentKey} resolved — ${input.service}`,
            text: `${writeUp.body}\n\n${result.writeUpUrl ? `Full write-up: ${result.writeUpUrl}` : ''}`.trim(),
          }),
        );
      });
      result.emailed = recipients;
      step('mailed', `Emailed ${recipients.length} recipient(s).`);
    } else {
      step('mailed', 'No email provider or recipients configured; skipped.');
    }

    // Close the Slack thread and the ticket.
    const comms = new CommunicationAgent(this.deps.messaging);
    await this.deps.tracer
      .run('CommunicationAgent', {}, (ctx) =>
        comms.reply(
          ctx,
          input.slackThread,
          `:large_green_circle: *${input.incidentKey} resolved* — #${pr.number} merged and signals are back to baseline.` +
            (result.writeUpUrl ? `\n\nWrite-up: ${result.writeUpUrl}` : ''),
        ),
      )
      .catch(() => undefined);

    if (this.deps.issueTracker && input.issueKey) {
      await this.deps.tracer
        .run('IssueTracker', {}, async (ctx) => {
          await ctx.tool('issues.addComment', { key: input.issueKey }, () =>
            this.deps.issueTracker!.addComment(
              input.issueKey!,
              `Resolved. #${pr.number} merged and recovery verified.`,
            ),
          );
          await ctx.tool('issues.resolve', { key: input.issueKey }, () =>
            this.deps.issueTracker!.updateIssue(input.issueKey!, { state: 'resolved' }),
          );
        })
        .catch((err: unknown) => {
          // Surfaced rather than swallowed: a ticket left open after an incident
          // closes is exactly the sort of drift nobody notices until an audit.
          step('mailed', `Could not resolve ${input.issueKey}: ${err instanceof Error ? err.message : String(err)}`);
        });
    }

    return result;
  }

  /**
   * Capture what the metrics were doing either side of the alert.
   *
   * Anchored on when the errors actually started, not when the monitor fired.
   *
   * A monitor lags its onset — it evaluates over a window and needs the threshold
   * held — so anchoring on the alert time pulls the first minutes of the incident
   * into the "baseline" and inflates it. Measured here: anchoring on the alert put
   * a 0.4% baseline at 2.1%, which understates the regression by five times. The
   * first error in the cluster is the observed onset, so that is the boundary,
   * with the baseline half-open below it.
   *
   * The observed onset is only an upper bound on the true one: metrics are
   * continuous while logs are sampled, so the rate can move before the first log we
   * hold. A short guard band is therefore subtracted before the baseline ends.
   * Measured on INC-001, this is the difference between a 1.0% baseline and the
   * 0.4% the service actually sits at. The cost is a slightly shorter baseline,
   * which is a far better trade than a contaminated one — a contaminated baseline
   * understates every regression measured against it.
   *
   * Snapshots keep their full point lists, so the incident page charts the
   * telemetry the decision was made on rather than a summary of it.
   *
   * Failures here are recorded and skipped. Losing a chart is not a reason to
   * abandon an incident.
   */
  private async captureTelemetry(
    persistence: WorkflowPersistence,
    incidentId: string,
    alert: ProductionAlert,
    trace: <T>(name: string, fn: (ctx: AgentRunContext) => Promise<T>) => Promise<T>,
  ): Promise<void> {
    const metrics: MetricName[] = [
      'error_rate',
      'http_5xx_rate',
      'latency_p50',
      'latency_p95',
      'request_throughput',
      'availability',
    ];
    const windows = telemetryWindowsFor(alert.primary?.firstSeen ?? alert.firedAt);

    await trace('TelemetryCollector', async (ctx) => {
      for (const metric of metrics) {
        for (const window of windows) {
          try {
            const call = await ctx.tool(
              'datadog.queryMetric',
              { service: alert.service, metric, window: window.kind },
              () => this.deps.observability.queryMetric(alert.service, metric, window),
            );
            const values = call.value.points.map((pt) => pt.value);
            if (values.length === 0) continue;
            await persistence.telemetry.record({
              serviceId: persistence.serviceId,
              metric,
              windowKind: window.kind,
              windowFrom: window.from,
              windowTo: window.to,
              unit: call.value.unit,
              sampleCount: values.length,
              mean: values.reduce((a, b) => a + b, 0) / values.length,
              min: Math.min(...values),
              max: Math.max(...values),
              points: call.value.points.map((pt) => ({ at: pt.at.toISOString(), value: pt.value })),
              sourceToolCallId: call.toolCallId,
            });
          } catch {
            // Already recorded as a failed tool call by the tracer.
          }
        }
      }
      return null;
    });
  }

  /**
   * Record what the alert observed as evidence.
   *
   * Two rows, both citing the tool call that produced them: the monitor state and
   * the error cluster. Both are OBSERVED — they are readings, not inferences — and
   * neither asserts a cause.
   */
  private async recordAlertEvidence(
    persistence: WorkflowPersistence,
    incidentId: string,
    alert: ProductionAlert,
  ): Promise<void> {
    await persistence.evidence.record({
      incidentId,
      kind: 'DATADOG_MONITOR',
      provenance: 'OBSERVED',
      summary: `Monitor "${alert.monitor.name}" is in ALERT since ${alert.firedAt.toISOString()}.`,
      sourceToolCallId: alert.toolCallIds.monitors,
      sourceRef: `monitor:${alert.monitor.id}`,
      payload: { query: alert.monitor.query, status: alert.monitor.status },
    });

    const cluster = alert.primary;
    if (!cluster || !alert.toolCallIds.logs) return;

    const frame = cluster.topApplicationFrame;
    await persistence.evidence.record({
      incidentId,
      kind: frame ? 'STACK_TRACE' : 'DATADOG_LOG',
      provenance: 'OBSERVED',
      summary:
        `${cluster.errorType ?? 'Error'} occurred ${cluster.count} times between ` +
        `${cluster.firstSeen.toISOString()} and ${cluster.lastSeen.toISOString()}` +
        (frame ? `, failing at ${toRepositoryPath(frame.file)}:${frame.line}.` : '.'),
      sourceToolCallId: alert.toolCallIds.logs,
      sourceRef: frame ? `${toRepositoryPath(frame.file)}:${frame.line}` : null,
      payload: {
        signature: cluster.signature,
        sample: cluster.sample,
        count: cluster.count,
        routes: cluster.affectedRoutes,
        entirelyInDependencies: cluster.entirelyInDependencies,
      },
    });
  }

  /** Read the files the stack trace implicates, so a generator has real source. */
  private async readSuspectSources(
    sandbox: Sandbox,
    cluster: { frames: { file: string; isDependency: boolean }[] },
  ): Promise<Record<string, string>> {
    const sources: Record<string, string> = {};
    for (const frame of cluster.frames.filter((f) => !f.isDependency).slice(0, 5)) {
      const path = toRepositoryPath(frame.file);
      const content = await sandbox.readFile(path);
      if (content !== null) sources[path] = content;
    }
    return sources;
  }

  private ticketBody(alert: ProductionAlert, incidentKey: string): string {
    const c = alert.primary!;
    const frame = c.topApplicationFrame;
    return [
      `${incidentKey} — detected by Pager Developer from Datadog monitor "${alert.monitor.name}".`,
      '',
      `Error: ${c.sample}`,
      `Occurrences: ${c.count} between ${c.firstSeen.toISOString()} and ${c.lastSeen.toISOString()}`,
      `Location: ${frame ? `${toRepositoryPath(frame.file)}:${frame.line}` : 'no application frame in the stack trace'}`,
      `Affected routes: ${c.affectedRoutes.join(', ') || 'unknown'}`,
      '',
      alert.novelty?.reason ?? '',
      '',
      'Pager Developer is working this incident. No production changes have been made.',
    ].join('\n');
  }

  private openingMessage(
    alert: ProductionAlert,
    incidentKey: string,
    issue: { key: string; url: string } | null,
  ): string {
    const c = alert.primary!;
    const frame = c.topApplicationFrame;
    return [
      `:red_circle: *Production error detected* — ${incidentKey}`,
      '',
      `*Service*  ${alert.service}`,
      `*Monitor*  ${alert.monitor.name}`,
      `*Error*  ${c.errorType ?? 'Error'} ×${c.count}`,
      `*Where*  ${frame ? `${toRepositoryPath(frame.file)}:${frame.line}` : 'no application frame'}`,
      `*Routes*  ${c.affectedRoutes.join(', ') || 'unknown'}`,
      issue ? `*Ticket*  ${issue.key}` : '',
      '',
      'This does not match a documented failure mode. Pager Developer is working it.',
      'No production changes have been made.',
    ]
      .filter(Boolean)
      .join('\n');
  }

  private pullRequestBody(
    incidentKey: string,
    alert: ProductionAlert,
    patch: PatchProposal,
    reproduction: ReproductionAttempt,
    validation: ValidationRun[],
    test: RegressionTestProposal,
  ): string {
    const c = alert.primary!;
    const ran = validation.filter((v) => !v.skipped);
    const skipped = validation.filter((v) => v.skipped);

    return [
      `## Incident\n${incidentKey} — ${alert.service}`,
      `## Impact\n${c.errorType ?? 'Error'} ×${c.count} on ${c.affectedRoutes.join(', ') || 'production'}, ` +
        `first seen ${c.firstSeen.toISOString()}.`,
      `## Root cause\n${patch.rootCause}`,
      `## Evidence\n- Datadog monitor "${alert.monitor.name}" alerting\n` +
        `- ${c.count} matching error logs\n` +
        `- Stack trace locates the failure at ${c.topApplicationFrame ? `\`${toRepositoryPath(c.topApplicationFrame.file)}:${c.topApplicationFrame.line}\`` : 'no application frame'}`,
      `## Changes\n${patch.files.map((f) => `- \`${f.path}\``).join('\n')}\n- \`${test.path}\` (regression test)`,
      `## Reproduction\n${describeReproduction(reproduction)}`,
      `## Verification\n${ran.map((v) => `- ${v.kind}: ${v.passed ? 'passed' : 'FAILED'}${v.testsPassed !== null ? ` (${v.testsPassed} tests)` : ''}`).join('\n')}` +
        (skipped.length > 0 ? `\n- not run: ${skipped.map((v) => v.kind).join(', ')}` : ''),
      `## Risk\n${patch.risks.length > 0 ? patch.risks.map((r) => `- ${r}`).join('\n') : '- None identified.'}`,
      `## Rollback plan\n${patch.rollbackPlan}`,
      `---\nPatch authored by: **${patch.kind}**. Opened by Pager Developer; requires human review and merge.`,
    ].join('\n\n');
  }

  private writeUp(
    incidentKey: string,
    alert: ProductionAlert,
    rootCause: string,
    pr: PullRequest,
    recovery: RecoveryVerification,
  ): { title: string; body: string } {
    const c = alert.primary!;
    const lines = [
      `# ${incidentKey} — ${alert.service}`,
      `## What broke`,
      `${c.errorType ?? 'An error'} occurred ${c.count} times on ${c.affectedRoutes.join(', ') || 'production'}, ` +
        `first seen ${c.firstSeen.toISOString()} and last seen ${c.lastSeen.toISOString()}. ` +
        `Datadog monitor "${alert.monitor.name}" alerted at ${alert.firedAt.toISOString()}.`,
      `## Root cause`,
      rootCause,
      `## How it was found`,
      `The failure did not match any documented mode in the service runbooks. ` +
        `The stack trace located it at ` +
        `${c.topApplicationFrame ? `${toRepositoryPath(c.topApplicationFrame.file)}:${c.topApplicationFrame.line}` : 'no application frame'}.`,
      `## Fix`,
      `Pull request #${pr.number} — ${pr.title}. Reviewed and merged by a human.`,
      `## Recovery`,
      recovery.comparisons
        .map(
          (m) =>
            `- ${m.metric}: baseline ${m.baseline.toFixed(4)}, incident ${m.incident.toFixed(4)}, ` +
            `now ${m.postRemediation.toFixed(4)} — ${m.reason}`,
        )
        .join('\n'),
      `## Notes`,
      `Pager Developer did not make any production change. The only production-affecting ` +
        `action was the human merge of #${pr.number}.`,
    ];
    return { title: `${incidentKey} — ${alert.service} incident write-up`, body: lines.join('\n\n') };
  }
}

/**
 * Severity from how loud the failure is.
 *
 * Occurrence count is the only signal available at alert time. This path is
 * triggered by errors appearing rather than by a metric moving, so there is no
 * baseline to compare against — and inventing one would be worse than a crude
 * but honest threshold.
 */
/**
 * How far before the first observed error the baseline stops.
 *
 * Absorbs the gap between a metric moving and the first log that records it.
 */
export const ONSET_GUARD_MINUTES = 3;

export const TELEMETRY_WINDOW_MINUTES = 30;

/** Baseline and observation windows either side of an observed onset. */
export function telemetryWindowsFor(
  onset: Date,
): readonly [{ kind: 'baseline'; from: Date; to: Date }, { kind: 'observation'; from: Date; to: Date }] {
  const t = onset.getTime();
  const guard = ONSET_GUARD_MINUTES * 60_000;
  const span = TELEMETRY_WINDOW_MINUTES * 60_000;
  return [
    { kind: 'baseline', from: new Date(t - guard - span), to: new Date(t - guard - 1) },
    { kind: 'observation', from: new Date(t), to: new Date(t + span) },
  ];
}

function severityFor(occurrences: number): 'SEV1' | 'SEV2' | 'SEV3' | 'SEV4' {
  if (occurrences >= 20) return 'SEV1';
  if (occurrences >= 5) return 'SEV2';
  if (occurrences >= 2) return 'SEV3';
  return 'SEV4';
}
