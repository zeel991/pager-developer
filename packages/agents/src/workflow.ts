import { z } from 'zod';
import type { AgentRunContext, AgentTracer } from '@pager/observability';
import type {
  DeploymentRecord,
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
  describeAssertionEvidence,
  describeReproduction,
  profileRepository,
  singleTestCommand,
  type ReproductionAttempt,
  type ValidationRun,
} from '@pager/sandbox';
import { ProductionWatcher, describeAlert, type ProductionAlert } from './production-watcher.js';
import { toRepositoryPath } from './log-analysis.js';
import {
  NoPatchGenerator,
  type PatchContext,
  type PatchGenerator,
  type PatchProposal,
  type RegressionTestProposal,
  type RepairFeedback,
} from './patch-generator.js';
import type { IncidentInvestigator, InvestigationResult } from './investigator/investigator.js';
import { DEFAULT_AUTONOMY_LEVEL, assertToolAllowed, type AutonomyLevel, type ToolDefinition } from '@pager/core';
import { CommunicationAgent, formatFixReady } from './communication.js';
import { RecoveryVerifier, type RecoveryVerification } from './recovery.js';
import type { IncidentEngine } from './incident-engine.js';
import type { IncidentState } from '@pager/core';
import type {
  AgentRunRepository,
  EvidenceRepository,
  FixRepository,
  IncidentRow,
  InvestigationRepository,
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
  /**
   * Optional. Supplying these makes the reasoning and the verification visible on
   * the incident page; omitting them leaves the workflow behaving identically and
   * the dashboard simply has less to show.
   */
  investigations?: InvestigationRepository;
  fixes?: FixRepository;
  /** Required alongside `fixes`: a fix candidate is keyed to a repository row. */
  repositoryId?: string;
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
  /**
   * The reasoning step. Absent, the workflow still detects, files, notifies and
   * halts with a handoff — it simply never claims to have diagnosed anything.
   */
  investigator?: IncidentInvestigator | null;
  persistence?: WorkflowPersistence;
  /** Governs which write boundaries the workflow may cross. Defaults to L3. */
  autonomy?: AutonomyLevel;
}

/**
 * The write boundaries this workflow crosses, declared so the policy engine sees
 * them.
 *
 * These are the four places the agent reaches out and changes something a person
 * will see. Each is checked immediately before it happens rather than once at
 * startup, so a configuration that forbids one of them stops that action rather than
 * being noticed after the fact.
 */
export const WORKFLOW_WRITE_TOOLS: Record<string, ToolDefinition> = {
  createIssue: writeTool('issues.createIssue', 'Open an incident ticket in the issue tracker.'),
  postMessage: writeTool('slack.postMessage', 'Post an incident update to a Slack channel.'),
  createBranch: writeTool('github.createBranch', 'Create a fix branch. Never the default branch.'),
  createPullRequest: writeTool('github.createPullRequest', 'Open a pull request for human review.'),
};

function writeTool(name: string, description: string): ToolDefinition {
  return {
    name,
    description,
    inputSchema: z.unknown(),
    outputSchema: z.unknown(),
    risk: 'WRITE_NON_PRODUCTION',
    // L3 is "may open a pull request". Everything here sits at or below that line;
    // nothing in this workflow touches production.
    minAutonomy: name === 'github.createPullRequest' ? 'L3' : 'L2',
    requiresApproval: false,
    timeoutMs: 30_000,
    maxRetries: 1,
    audit: true,
  };
}

export interface WorkflowInput {
  service: string;
  repository: string;
  /** Branch pull requests target. NOT the source of the sandbox revision. */
  baseBranch?: string;
  /**
   * What production is actually running.
   *
   * Required, in one of two forms. The workflow will not fall back to the head of
   * the base branch: that is a different tree from the one that is failing, and a
   * patch validated against it proves nothing about production. When neither is
   * supplied the workflow halts and says so.
   */
  deployment?: DeploymentRecord | null;
  /** An explicit revision, when there is no deployment record to read it from. */
  deployedRevision?: string;
  /** The revision the deployment replaced, when known independently. */
  previousRevision?: string | null;
  slackChannel: string;
  /** Recipients of the post-incident write-up. */
  teamEmails?: string[];
  incidentKey?: string;
  sandboxRoot?: string;
}

/**
 * Where the sandbox revision came from.
 *
 * Recorded and displayed because "the code we tested against" is the single
 * assumption every downstream claim rests on.
 */
export interface DeployedRevision {
  sha: string;
  previousSha: string | null;
  source: 'deployment_record' | 'explicit';
  description: string;
}

export function resolveDeployedRevision(input: WorkflowInput): DeployedRevision | null {
  if (input.deployment?.commitSha) {
    return {
      sha: input.deployment.commitSha,
      previousSha: input.previousRevision ?? input.deployment.previousCommitSha ?? null,
      source: 'deployment_record',
      description:
        `Deployment ${input.deployment.id} (${input.deployment.status}) put ` +
        `${input.deployment.commitSha.slice(0, 12)} into ${input.deployment.environment}` +
        (input.deployment.deployedAt ? ` at ${input.deployment.deployedAt.toISOString()}` : '') + '.',
    };
  }
  if (input.deployedRevision) {
    return {
      sha: input.deployedRevision,
      previousSha: input.previousRevision ?? null,
      source: 'explicit',
      description: `Revision ${input.deployedRevision.slice(0, 12)} was supplied explicitly by the caller.`,
    };
  }
  return null;
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
  /** What the reasoning step concluded. Null when no investigator was configured. */
  investigation: InvestigationResult | null;
  /** The revision the sandbox was built from, and where it came from. */
  deployedRevision: DeployedRevision | null;
  /** The regression test, as authored. */
  regressionTest: RegressionTestProposal | null;
  /** Checks run before the regression test existed, to rule out a broken suite. */
  preexistingChecks: ValidationRun | null;
  /** True when a bounded repair retry was used. */
  repairAttempted: boolean;
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
      investigation: null,
      deployedRevision: null,
      regressionTest: null,
      preexistingChecks: null,
      repairAttempted: false,
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
    // Anchored on the observed onset, not the monitor's firing time. The same
    // windows the telemetry snapshots use, so the investigator reasons over exactly
    // the series the incident page charts.
    const telemetryWindows = telemetryWindowsFor(alert.primary?.firstSeen ?? alert.firedAt);

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

    // ── 2b. What is production actually running? ─────────────────────────────
    //
    // Resolved from deployment evidence, never from the head of the base branch.
    // The branch has moved on; the failing tree is the one that was deployed, and a
    // patch validated against anything else proves nothing about the incident.
    const revision = resolveDeployedRevision(input);
    if (!revision) {
      return await halt(
        'The deployed revision could not be established. No deployment record and no explicit ' +
          'revision was supplied, and the head of the base branch is not a substitute — it is a ' +
          'different tree from the one that is failing. Supply the deployment that is live, or the ' +
          'exact revision, and re-run.',
      );
    }
    result.deployedRevision = revision;
    step('identified', `Deployed revision established: ${revision.sha.slice(0, 12)}`, {
      source: revision.source,
      previousSha: revision.previousSha,
      description: revision.description,
    });

    // What the deployment changed, as blame surface for the investigation and the
    // patch. An unavailable diff is carried as unknown, never as "nothing changed".
    let changedFiles: string[] = [];
    let diffGap: string | null = null;
    if (revision.previousSha) {
      try {
        const diff = await trace('DeploymentObserver', async (ctx) => {
          const { value } = await ctx.tool(
            'github.getDiff',
            { repo: input.repository, base: revision.previousSha, head: revision.sha },
            () => this.deps.sourceControl.getDiff(input.repository, revision.previousSha!, revision.sha),
          );
          return value;
        });
        changedFiles = diff.files.map((f) => f.path);
        if (changedFiles.length === 0) {
          diffGap = `The provider returned no changed files for ${revision.previousSha.slice(0, 12)}..${revision.sha.slice(0, 12)}. The diff is unknown, not empty.`;
        }
      } catch (err) {
        diffGap = `The deployment diff could not be read: ${err instanceof Error ? err.message : String(err)}`;
      }
    } else {
      diffGap = 'The previously deployed revision is unknown, so no deployment diff is available.';
    }
    if (diffGap) await note('diff_unavailable', diffGap);

    // ── 2c. Investigate ──────────────────────────────────────────────────────
    let findings = null as InvestigationResult['findings'];
    if (this.deps.investigator) {
      const investigation = await this.deps.investigator.investigate({
        target: {
          service: input.service,
          repository: input.repository,
          deployedRevision: revision.sha,
          previousRevision: revision.previousSha,
          baselineWindow: telemetryWindows[0],
          observationWindow: telemetryWindows[1],
        },
        cluster,
        monitorName: alert.monitor.name,
        firedAt: alert.firedAt,
        incidentId: result.incident?.id ?? null,
      });
      result.investigation = investigation;
      findings = investigation.findings;

      if (!findings) {
        step('identified', `Investigation produced no conclusion: ${investigation.abandonedReason}`, {
          limitHit: investigation.limitHit,
          toolCalls: investigation.toolCallCount,
        });
      } else {
        step(
          'identified',
          `Model diagnosis (${investigation.model}): ${findings.diagnosis}`,
          {
            attribution: findings.attribution.verdict,
            decision: findings.decision.action,
            confidence: findings.confidence,
            citedToolCalls: findings.evidence.length,
          },
        );
        if (persistence && result.incident) {
          await this.recordInvestigationEvidence(persistence, result.incident.id, findings);
          await persistence.investigations
            ?.record({
              incidentId: result.incident.id,
              agentRunId: null,
              suspectedRootCause: findings.diagnosis,
              deploymentAttribution: findings.attribution.verdict,
              attributionRationale: findings.attribution.rationale,
              confidence: findings.confidence,
              nextActions: [`${findings.decision.action}: ${findings.decision.reason}`],
              hypotheses: [
                // The diagnosis is a hypothesis until the reproduction confirms it.
                { description: findings.diagnosis, confidence: findings.confidence, status: 'HYPOTHESIS' },
                { description: `Not established: ${findings.uncertainty}`, confidence: null, status: 'HYPOTHESIS' },
              ],
            })
            .catch(() => undefined);
        }
      }
    } else {
      step('identified', 'No investigator is configured; no diagnosis was attempted.');
    }

    // ── 3. Issue tracker ─────────────────────────────────────────────────────
    if (this.deps.issueTracker) {
      this.assertAllowed(WORKFLOW_WRITE_TOOLS.createIssue!);
      const issue = await trace('IssueTracker', async (ctx) => {
        const { value } = await ctx.tool('issues.createIssue', { title }, () =>
          this.deps.issueTracker!.createIssue({
            title,
            description: this.ticketBody(alert, incidentKey, revision, findings, diffGap),
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
    this.assertAllowed(WORKFLOW_WRITE_TOOLS.postMessage!);
    const comms = new CommunicationAgent(this.deps.messaging);
    const thread = await trace('CommunicationAgent', (ctx) =>
      comms.openThread(
        ctx,
        input.slackChannel,
        this.openingMessage(alert, incidentKey, result.issue, revision, findings),
      ),
    );
    step('team_notified', `Posted to ${input.slackChannel}`, { threadTs: thread.id });

    // ── 4b. Abstention is a complete outcome, not a failure ──────────────────
    if (findings && findings.decision.action === 'ABSTAIN') {
      const handoff = this.abstentionHandoff(incidentKey, findings, revision, result.issue, thread);
      await this.reportHandoff(comms, thread, handoff, result.issue);
      return await halt(
        `Abstained from repair: ${findings.decision.reason} No pull request was opened.`,
      );
    }
    if (this.deps.investigator && !findings) {
      const why = result.investigation?.abandonedReason ?? 'the investigation produced no conclusion';
      await this.reportHandoff(
        comms,
        thread,
        `No diagnosis was reached, so no repair was attempted: ${why}\n\n` +
          `The sandbox revision is \`${revision.sha}\` and the failure is located at ` +
          `${frame ? `\`${toRepositoryPath(frame.file)}:${frame.line}\`` : 'no application frame'}.`,
        result.issue,
      );
      return await halt(`No diagnosis was reached: ${why} No pull request was opened.`);
    }

    // ── 4c. Is production even running what the branch says? ─────────────────
    //
    // The sandbox is built from the DEPLOYED revision, because that is the only
    // tree the failure can be reproduced against. But a fix branches from there
    // too, so when the base branch has moved on the resulting pull request
    // conflicts — and, worse, the failure may already be fixed on that branch and
    // simply not deployed. "Production is behind; the fix may already exist" is a
    // real finding, and an agent that cannot reach it will keep writing patches
    // nobody needs.
    //
    // Observed: a merged fix sat on the default branch for twenty minutes while
    // production ran the revision before it. The next incident re-diagnosed the
    // same defect and opened a conflicting pull request against code that was
    // already correct.
    const baseBranch = input.baseBranch ?? 'main';
    let deploymentLag: string | null = null;
    try {
      const baseHead = await trace('RepositoryInvestigator', async (ctx) => {
        const { value } = await ctx.tool('github.listCommits', { repo: input.repository, ref: baseBranch }, () =>
          this.deps.sourceControl.listCommits(input.repository, { ref: baseBranch, limit: 1 }),
        );
        return value[0] ?? null;
      });
      const baseHeadSha = baseHead?.sha ?? null;
      if (baseHeadSha && baseHeadSha !== revision.sha) {
        deploymentLag =
          `Production is running ${revision.sha.slice(0, 12)} while ${baseBranch} is at ` +
          `${baseHeadSha.slice(0, 12)}. The deployed revision is NOT the head of the branch, so ` +
          `the failure may already be fixed on ${baseBranch} and simply not deployed — and any ` +
          `patch written against the deployed tree may conflict with what is already there. ` +
          `Check ${baseBranch} before treating this as unfixed.`;
        step('identified', `Deployed revision is behind ${baseBranch}.`, {
          deployed: revision.sha,
          baseHead: baseHeadSha,
        });
        await note('deployment_behind_base', deploymentLag);
      }
    } catch (err) {
      deploymentLag = `Could not compare the deployed revision against ${baseBranch}: ${
        err instanceof Error ? err.message : String(err)
      }`;
    }
    const sandbox = await Sandbox.create(this.deps.sourceControl, input.repository, revision.sha, {
      ...(input.sandboxRoot ? { rootDir: input.sandboxRoot } : {}),
    });

    try {
      const profile = await profileRepository(sandbox);
      const validation = new ValidationEngine(sandbox);
      const reproduction = new ReproductionAgent(sandbox, validation);

      // The repository's own checks, BEFORE anything is added. A suite that was
      // already red cannot be used to prove a new assertion fails.
      const preexisting = await validation.runCheck('test', profile.testCommand);
      result.preexistingChecks = preexisting;
      step('reproducing', `Existing checks at the deployed revision: ${describeCheck(preexisting)}`);

      const context: PatchContext = {
        service: input.service,
        repository: input.repository,
        revision: revision.sha,
        previousRevision: revision.previousSha,
        cluster,
        changedFiles,
        sources: await this.readSuspectSources(sandbox, cluster, findings),
        testCommand: profile.testCommand,
        existingTestExample: await this.readTestExample(sandbox),
        investigation: findings,
      };

      // 5a. A test that demonstrates the failure.
      const proposedTest: RegressionTestProposal | null =
        await this.generator.proposeRegressionTest(context);
      if (!proposedTest) {
        return await halt(
          `No regression test could be authored (generator: ${this.generator.kind}). ` +
            `The failure is located at ${frame ? `${toRepositoryPath(frame.file)}:${frame.line}` : 'an unknown frame'} ` +
            `and the sandbox is ready at deployed revision ${revision.sha}.`,
        );
      }
      result.regressionTest = proposedTest;

      // Refuse a "new" test that silently replaces an existing one.
      if ((await sandbox.readFile(proposedTest.path)) !== null) {
        return await halt(
          `The proposed regression test at ${proposedTest.path} would overwrite an existing file. ` +
            `Refused: a regression test must be new, or it cannot prove anything about the failure.`,
        );
      }

      // Isolate the new test where the runner allows it, so an unrelated failure in
      // the suite cannot be mistaken for the reproduction.
      const isolated = singleTestCommand(profile, proposedTest.path);
      if (!isolated) {
        await note(
          'reproduction_not_isolated',
          `The runner could not be targeted at a single file, so the reproduction runs the whole ` +
            `suite (${profile.testCommand ?? 'no test command'}).`,
        );
      }

      step('reproducing', `Writing a regression test (${proposedTest.kind}).`, {
        path: proposedTest.path,
        expects: proposedTest.expectedFailureMarkers,
      });
      await advance('REPRODUCING', `Writing a regression test (${proposedTest.kind}).`);
      const attempt = await reproduction.demonstrateFailure({
        testPath: proposedTest.path,
        testSource: proposedTest.source,
        command: isolated ?? profile.testCommand ?? 'node --test',
        expectedFailureMarkers: proposedTest.expectedFailureMarkers,
        baseline: preexisting,
      });
      result.reproduction = attempt;

      if (attempt.failureReason) {
        await this.reportHandoff(
          comms,
          thread,
          `The failure could not be reproduced, so no patch was attempted.\n\n${attempt.failureReason}`,
          result.issue,
        );
        return await halt(`Reproduction failed: ${attempt.failureReason}`);
      }
      step('reproducing', describeReproduction(attempt));
      // The failure reproduced, which is what confirms the root cause.
      await advance('ROOT_CAUSE_CONFIRMED', describeReproduction(attempt));

      // 5b/5c. Patch, verify, and at most one bounded repair attempt.
      const outcome = await this.patchAndValidate({
        context,
        sandbox,
        validation,
        reproduction,
        attempt,
        profile,
        test: proposedTest,
        step,
        advance,
      });
      result.patch = outcome.patch;
      result.reproduction = outcome.reproduction ?? result.reproduction;
      result.validation = outcome.validation;
      result.repairAttempted = outcome.repairAttempted;

      if (!outcome.ok) {
        await this.reportHandoff(comms, thread, outcome.reason!, result.issue);
        return await halt(outcome.reason!);
      }

      const patch = outcome.patch!;
      const confirmed = outcome.reproduction!;

      // 5d. Branch, commit, pull request.
      this.assertAllowed(WORKFLOW_WRITE_TOOLS.createBranch!);
      this.assertAllowed(WORKFLOW_WRITE_TOOLS.createPullRequest!);
      const branch = `pager/${incidentKey.toLowerCase()}`;
      const pr = await trace('FixAgent', async (ctx) => {
        await ctx.tool('github.createBranch', { repo: input.repository, branch }, () =>
          this.deps.sourceControl.createBranch(input.repository, revision.sha, branch),
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
            body: this.pullRequestBody({
              incidentKey,
              alert,
              patch,
              reproduction: confirmed,
              validation: result.validation,
              test: proposedTest,
              revision,
              findings,
              deploymentLag,
              issue: result.issue,
              slackChannel: input.slackChannel,
              slackThreadTs: thread.id,
              preexisting,
              repairAttempted: outcome.repairAttempted,
              diffGap,
              modelUsage: result.investigation,
            }),
            headRef: branch,
            baseRef: baseBranch,
          }),
        );
        return value;
      });

      result.pullRequest = pr;
      step('pr_opened', `Opened #${pr.number}`, { url: pr.url });
      await advance('FIX_READY', `Pull request #${pr.number} opened: ${pr.url}`);

      // Persist what was proposed and what really ran, so the incident page shows
      // exit codes rather than a claim that the checks passed.
      if (persistence?.fixes && persistence.repositoryId && result.incident) {
        await persistence.fixes
          .record({
            incidentId: result.incident.id,
            repositoryId: persistence.repositoryId,
            branch,
            commitSha: null,
            rootCause: patch.rootCause,
            explanation: `${patch.explanation}\n\nAuthored by: ${patch.kind}.`,
            risks: patch.risks,
            rollbackPlan: patch.rollbackPlan,
            confidence: patch.confidence,
            pullRequestNumber: pr.number,
            pullRequestUrl: pr.url,
            files: [...patch.files.map((f) => ({ path: f.path })), { path: proposedTest.path }],
            reproduction: {
              command: confirmed.command,
              environmentDescription: `Sandbox at deployed revision ${revision.sha}. ${describeAssertionEvidence(confirmed.assertionEvidence)}`,
              beforeFixExitCode: confirmed.beforeFix.exitCode,
              beforeFixPassed: confirmed.beforeFix.passed,
              afterFixExitCode: confirmed.afterFix?.exitCode ?? null,
              afterFixPassed: confirmed.afterFix?.passed ?? null,
              beforeFixOutput: confirmed.beforeFix.output.slice(0, 20_000),
              afterFixOutput: confirmed.afterFix?.output.slice(0, 20_000) ?? null,
            },
            // Only checks that actually ran. A skipped check is absent here and
            // reported as unmeasured elsewhere, never as a passing run.
            validation: result.validation
              .filter((v) => !v.skipped && v.exitCode !== null)
              .map((v) => ({
                kind: v.kind,
                command: v.command,
                exitCode: v.exitCode!,
                passed: v.passed,
                testsPassed: v.testsPassed,
                testsFailed: v.testsFailed,
                durationMs: v.durationMs,
                output: v.output.slice(0, 20_000),
              })),
          })
          .catch(() => undefined);
      }

      // ── 6. Ask for a merge, and link everything together ───────────────────
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
          ) +
            `\n\n*Patch authored by* ${patch.kind === 'model' ? `model \`${result.investigation?.model ?? 'model'}\`` : patch.kind}` +
            (result.issue ? `\n*Incident* ${result.issue.key} — ${result.issue.url}` : ''),
        ),
      );

      // The ticket learns about the pull request and the Slack thread, so all three
      // surfaces point at each other rather than each holding half the story.
      if (this.deps.issueTracker && result.issue) {
        await this.deps.tracer
          .run('IssueTracker', {}, async (ctx) => {
            await ctx.tool('issues.addComment', { key: result.issue!.key }, () =>
              this.deps.issueTracker!.addComment(
                result.issue!.key,
                [
                  `Fix ready for review: ${pr.url} (#${pr.number})`,
                  `Slack thread: ${input.slackChannel} (ts ${thread.id})`,
                  ``,
                  `Reproduction: ${describeReproduction(confirmed)}`,
                  `Checks run: ${result.validation.filter((v) => !v.skipped).map((v) => `${v.kind}=${v.passed ? 'pass' : 'FAIL'}`).join(', ') || 'none'}`,
                  `Not run: ${result.validation.filter((v) => v.skipped).map((v) => v.kind).join(', ') || 'none'}`,
                  `Patch authored by: ${patch.kind}`,
                  ``,
                  `Merging is a human decision. Pager Developer has made no production change.`,
                ].join('\n'),
              ),
            );
          })
          .catch(() => undefined);
      }

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
      investigation: null,
      deployedRevision: null,
      regressionTest: null,
      preexistingChecks: null,
      repairAttempted: false,
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

  /**
   * Read the files a generator needs to write real code.
   *
   * The stack trace's application frames, plus whatever the investigation named as
   * the root cause — those can differ, and the interesting incidents are exactly the
   * ones where they do. Files that the frames reference by relative import are also
   * pulled in, because a patch written without the type it depends on is a guess.
   */
  private async readSuspectSources(
    sandbox: Sandbox,
    cluster: { frames: { file: string; isDependency: boolean }[] },
    findings: InvestigationResult['findings'],
  ): Promise<Record<string, string>> {
    const sources: Record<string, string> = {};
    const wanted: string[] = [
      ...(findings?.rootCauseFile ? [findings.rootCauseFile] : []),
      ...cluster.frames.filter((f) => !f.isDependency).slice(0, 5).map((f) => toRepositoryPath(f.file)),
    ];

    for (const path of wanted) {
      if (sources[path] !== undefined) continue;
      const content = await sandbox.readFile(path);
      if (content !== null) sources[path] = content;
    }

    // One hop of relative imports, so the shape a patch must satisfy is present.
    for (const [path, content] of Object.entries({ ...sources })) {
      const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
      for (const match of content.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
        const resolved = normaliseRelative(dir, match[1]!);
        if (!resolved || sources[resolved] !== undefined) continue;
        const imported = await sandbox.readFile(resolved);
        if (imported !== null) sources[resolved] = imported;
      }
    }
    return sources;
  }

  /** One existing test, so a new one matches the repository's conventions. */
  private async readTestExample(sandbox: Sandbox): Promise<{ path: string; source: string } | null> {
    for (const path of ['test', 'tests', '__tests__', 'src']) {
      for (const name of ['checkout.test.ts', 'index.test.ts', 'main.test.ts']) {
        const candidate = `${path}/${name}`;
        const source = await sandbox.readFile(candidate);
        if (source !== null) return { path: candidate, source };
      }
    }
    return null;
  }

  /**
   * Check a write against the policy engine immediately before performing it.
   *
   * Throwing rather than returning false: a workflow that was configured below the
   * autonomy its actions require is a misconfiguration, and quietly skipping the
   * pull request would leave an incident that looks handled and is not.
   */
  private assertAllowed(tool: ToolDefinition): void {
    assertToolAllowed(tool, { autonomy: this.deps.autonomy ?? DEFAULT_AUTONOMY_LEVEL });
  }

  /**
   * Record the model's conclusion as evidence, citing the tool calls it cited.
   *
   * Provenance is DERIVED throughout: a diagnosis is an inference over observations,
   * never an observation itself, and the incident page renders the two differently.
   */
  private async recordInvestigationEvidence(
    persistence: WorkflowPersistence,
    incidentId: string,
    findings: NonNullable<InvestigationResult['findings']>,
  ): Promise<void> {
    for (const citation of findings.evidence) {
      await persistence.evidence
        .record({
          incidentId,
          kind: 'REPOSITORY_FILE',
          provenance: 'DERIVED',
          summary: citation.shows,
          sourceToolCallId: citation.toolCallId,
          sourceRef: findings.rootCauseFile ?? null,
          payload: {
            diagnosis: findings.diagnosis,
            attribution: findings.attribution,
            uncertainty: findings.uncertainty,
            confidence: findings.confidence,
            authoredBy: 'model',
          },
        })
        // A citation that the database refuses is a citation to a call that did not
        // happen. The investigation already validated against the issued set, so
        // this is a second line rather than the first.
        .catch(() => undefined);
    }
  }

  /** Post a handoff into the Slack thread and onto the ticket. */
  private async reportHandoff(
    comms: CommunicationAgent,
    thread: { id: string; channel: string },
    body: string,
    issue: { key: string; url: string } | null,
  ): Promise<void> {
    await this.deps.tracer
      .run('CommunicationAgent', {}, (ctx) =>
        comms.reply(ctx, thread, `:warning: *Handing this back to a human.*\n\n${body}`),
      )
      .catch(() => undefined);

    if (this.deps.issueTracker && issue) {
      await this.deps.tracer
        .run('IssueTracker', {}, async (ctx) => {
          await ctx.tool('issues.addComment', { key: issue.key }, () =>
            this.deps.issueTracker!.addComment(issue.key, body),
          );
        })
        .catch(() => undefined);
    }
  }

  private abstentionHandoff(
    incidentKey: string,
    findings: NonNullable<InvestigationResult['findings']>,
    revision: DeployedRevision,
    issue: { key: string; url: string } | null,
    thread: { id: string; channel: string },
  ): string {
    return [
      `${incidentKey}: no repair was attempted, deliberately.`,
      ``,
      `*What the evidence shows*  ${findings.diagnosis}`,
      `*Attribution*  ${findings.attribution.verdict} — ${findings.attribution.rationale}`,
      `*Why no patch*  ${findings.decision.reason}`,
      `*Still unknown*  ${findings.uncertainty}`,
      ``,
      `Deployed revision investigated: \`${revision.sha}\` (${revision.source.replace('_', ' ')}).`,
      `Cited observations: ${findings.evidence.length}.`,
      issue ? `Ticket: ${issue.key} — ${issue.url}` : '',
      `Thread: ${thread.channel}`,
      ``,
      `No branch, no pull request, no production change.`,
    ]
      .filter(Boolean)
      .join('\n');
  }

  /**
   * Apply a patch, verify it, and allow exactly one repair attempt.
   *
   * The retry exists because deterministic validation produces genuinely useful
   * feedback — a type error or a failing check names the problem precisely — and a
   * single bounded pass at it is worth far more than it costs. Two would start to
   * look like search, and a model searching for something that makes the tests go
   * green is the behaviour this system is built to prevent.
   */
  private async patchAndValidate(args: {
    context: PatchContext;
    sandbox: Sandbox;
    validation: ValidationEngine;
    reproduction: ReproductionAgent;
    attempt: ReproductionAttempt;
    profile: Awaited<ReturnType<typeof profileRepository>>;
    test: RegressionTestProposal;
    step: (stage: WorkflowStage, summary: string, detail?: Record<string, unknown>) => void;
    advance: (to: IncidentState, summary: string) => Promise<void>;
  }): Promise<{
    ok: boolean;
    reason: string | null;
    patch: PatchProposal | null;
    reproduction: ReproductionAttempt | null;
    validation: ValidationRun[];
    repairAttempted: boolean;
  }> {
    const { context, sandbox, validation, reproduction, attempt, profile, test, step, advance } = args;
    const pristine = new Map<string, string | null>();
    let feedback: RepairFeedback | undefined;
    let lastPatch: PatchProposal | null = null;
    let repairAttempted = false;

    for (let pass = 0; pass < 2; pass++) {
      if (pass === 1) {
        if (!feedback) break;
        repairAttempted = true;
        step('patching', 'Deterministic verification failed. Attempting one bounded repair.');
      }

      const patch = await this.generator.proposePatch(context, feedback);
      if (!patch) {
        return {
          ok: false,
          reason:
            pass === 0
              ? 'The patch generator produced no patch.'
              : 'The repair attempt produced no patch.',
          patch: lastPatch,
          reproduction: null,
          validation: [],
          repairAttempted,
        };
      }
      lastPatch = patch;

      // Second enforcement of the rule the generator already applies: a patch may
      // not touch the test that proves the failure. Checked here too because this is
      // the layer that actually writes to disk, and a generator is replaceable.
      const collides = patch.files.find((f) => normalisePath(f.path) === normalisePath(test.path));
      if (collides) {
        return {
          ok: false,
          reason:
            `Patch rejected: it modifies the regression test at ${collides.path}. A patch may not ` +
            `alter the evidence that demonstrates the failure it claims to fix.`,
          patch,
          reproduction: null,
          validation: [],
          repairAttempted,
        };
      }

      // Restore anything a prior pass wrote, so the retry starts from the deployed
      // tree rather than from the rejected patch.
      for (const [path, content] of pristine) {
        if (content === null) await sandbox.deleteFile(path);
        else await sandbox.writeFile(path, content);
      }

      step('patching', `Applying a ${patch.kind} patch to ${patch.files.length} file(s).`, {
        rootCause: patch.rootCause,
        pass: pass + 1,
      });
      await advance('FIXING', `Applying a ${patch.kind} patch: ${patch.rootCause}`);

      for (const file of patch.files) {
        if (!pristine.has(file.path)) pristine.set(file.path, await sandbox.readFile(file.path));
        await sandbox.writeFile(file.path, file.content);
      }

      const confirmed = await reproduction.confirmFix(attempt);
      if (!confirmed.proven) {
        const reason = `Patch rejected: ${confirmed.failureReason}`;
        if (pass === 1) {
          return { ok: false, reason, patch, reproduction: confirmed, validation: [], repairAttempted };
        }
        feedback = {
          previousPatch: patch,
          summary: reason,
          failures: [
            {
              kind: 'reproduction',
              exitCode: confirmed.afterFix?.exitCode ?? null,
              output: confirmed.afterFix?.output ?? '',
            },
          ],
        };
        continue;
      }

      await advance('VALIDATING', 'Running deterministic verification.');
      const summary = await validation.runAll(profile);
      const runs = [confirmed.afterFix!, ...summary.runs];
      step('validating', `Verification: ${summary.allPassed ? 'passed' : 'FAILED'}`, {
        ran: summary.runs.filter((r) => !r.skipped).map((r) => r.kind),
        skipped: summary.skipped,
      });

      if (summary.allPassed) {
        return { ok: true, reason: null, patch, reproduction: confirmed, validation: runs, repairAttempted };
      }

      const failed = summary.runs.filter((r) => !r.skipped && !r.passed);
      const reason =
        `Deterministic verification did not pass (` +
        `${failed.map((r) => `${r.kind} exit ${r.exitCode}`).join(', ')}); the patch is not offered for merge.`;

      if (pass === 1) {
        return { ok: false, reason, patch, reproduction: confirmed, validation: runs, repairAttempted };
      }
      feedback = {
        previousPatch: patch,
        summary: reason,
        failures: failed.map((r) => ({ kind: r.kind, exitCode: r.exitCode, output: r.output })),
      };
    }

    return {
      ok: false,
      reason: 'The patch could not be validated after one repair attempt.',
      patch: lastPatch,
      reproduction: null,
      validation: [],
      repairAttempted,
    };
  }

  private ticketBody(
    alert: ProductionAlert,
    incidentKey: string,
    revision: DeployedRevision,
    findings: InvestigationResult['findings'],
    diffGap: string | null,
  ): string {
    const c = alert.primary!;
    const frame = c.topApplicationFrame;
    return [
      `${incidentKey} — detected by Pager Developer from Datadog monitor "${alert.monitor.name}".`,
      '',
      '## Observed',
      `Error: ${c.sample}`,
      `Occurrences: ${c.count} between ${c.firstSeen.toISOString()} and ${c.lastSeen.toISOString()}`,
      `Location: ${frame ? `${toRepositoryPath(frame.file)}:${frame.line}` : 'no application frame in the stack trace'}`,
      `Affected routes: ${c.affectedRoutes.join(', ') || 'unknown'}`,
      `Deployed revision: ${revision.sha} (${revision.description})`,
      diffGap ? `Gap: ${diffGap}` : '',
      '',
      alert.novelty?.reason ?? '',
      '',
      findings
        ? [
            '## Model diagnosis (an inference, not an observation)',
            findings.diagnosis,
            '',
            `Attribution: ${findings.attribution.verdict} — ${findings.attribution.rationale}`,
            `Still unknown: ${findings.uncertainty}`,
            `Decision: ${findings.decision.action} — ${findings.decision.reason}`,
            `Supported by ${findings.evidence.length} cited observation(s):`,
            ...findings.evidence.map((e) => `- ${e.shows}`),
          ].join('\n')
        : '## Diagnosis\nNo model diagnosis is available for this incident.',
      '',
      'Pager Developer is working this incident. No production changes have been made.',
    ]
      .filter(Boolean)
      .join('\n');
  }

  private openingMessage(
    alert: ProductionAlert,
    incidentKey: string,
    issue: { key: string; url: string } | null,
    revision: DeployedRevision,
    findings: InvestigationResult['findings'],
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
      `*Deployed revision*  \`${revision.sha.slice(0, 12)}\` (${revision.source.replace('_', ' ')})`,
      issue ? `*Ticket*  ${issue.key} — ${issue.url}` : '',
      '',
      findings
        ? [
            `*Diagnosis*  ${findings.diagnosis}`,
            `*Attribution*  ${findings.attribution.verdict}`,
            `*Confidence*  ${findings.confidence.toFixed(2)} — _a model's conclusion from ${findings.evidence.length} cited observation(s), not a verified fact_`,
            `*Unknown*  ${findings.uncertainty}`,
          ].join('\n')
        : 'This does not match a documented failure mode.',
      '',
      'Pager Developer is working it. No production changes have been made.',
    ]
      .filter(Boolean)
      .join('\n');
  }

  private pullRequestBody(args: {
    incidentKey: string;
    alert: ProductionAlert;
    patch: PatchProposal;
    reproduction: ReproductionAttempt;
    validation: ValidationRun[];
    test: RegressionTestProposal;
    revision: DeployedRevision;
    findings: InvestigationResult['findings'];
    /** Set when the deployed revision is not the head of the base branch. */
    deploymentLag: string | null;
    issue: { key: string; url: string } | null;
    slackChannel: string;
    slackThreadTs: string;
    preexisting: ValidationRun;
    repairAttempted: boolean;
    diffGap: string | null;
    modelUsage: InvestigationResult | null;
  }): string {
    const c = args.alert.primary!;
    const ran = args.validation.filter((v) => !v.skipped);
    const skipped = args.validation.filter((v) => v.skipped);
    const frame = c.topApplicationFrame;

    const authorship = args.patch.kind === 'model'
      ? `**${args.modelUsage?.model ?? 'a reasoning model'}**, via Pager Developer`
      : `**${args.patch.kind}** (not a model)`;

    return [
      `## Incident\n${args.incidentKey} — ${args.alert.service}` +
        (args.issue ? `\nTicket: ${args.issue.key} — ${args.issue.url}` : '') +
        `\nSlack: \`${args.slackChannel}\` (thread ${args.slackThreadTs})`,

      `## Impact\n${c.errorType ?? 'Error'} ×${c.count} on ${c.affectedRoutes.join(', ') || 'production'}, ` +
        `first seen ${c.firstSeen.toISOString()}.`,

      `## What production was running\n\`${args.revision.sha}\`\n${args.revision.description}\n` +
        `Every check below ran against **that** revision, not against the head of the base branch.` +
        (args.diffGap ? `\n\n> Gap: ${args.diffGap}` : '') +
        (args.deploymentLag ? `\n\n> ⚠️ **${args.deploymentLag}**` : ''),

      `## Root cause\n${args.patch.rootCause}`,

      args.findings
        ? `## Diagnosis — model conclusion\n${args.findings.diagnosis}\n\n` +
          `**Attribution** ${args.findings.attribution.verdict} — ${args.findings.attribution.rationale}\n\n` +
          `**Known unknowns** ${args.findings.uncertainty}\n\n` +
          `**Cited observations** (each is a tool call the tracer recorded)\n` +
          args.findings.evidence.map((e) => `- \`${e.toolCallId}\` — ${e.shows}`).join('\n')
        : `## Diagnosis\nNo model investigation was available for this incident.`,

      `## Evidence — observed\n- Datadog monitor "${args.alert.monitor.name}" alerting\n` +
        `- ${c.count} matching error logs\n` +
        `- Stack trace locates the failure at ${frame ? `\`${toRepositoryPath(frame.file)}:${frame.line}\`` : 'no application frame'}`,

      `## Changes\n${args.patch.files.map((f) => `- \`${f.path}\``).join('\n')}\n- \`${args.test.path}\` (new regression test)`,

      `## Reproduction — fail before, pass after\n` +
        `Checks at the deployed revision **before** the regression test existed: ${describeCheck(args.preexisting)}\n\n` +
        `${describeReproduction(args.reproduction)}\n\n` +
        `The test proves: ${args.test.expectedFailureDescription}\n\n` +
        `Command: \`${args.reproduction.command}\`  \n` +
        `Before the patch: exit ${args.reproduction.beforeFix.exitCode}. ` +
        `After the patch: exit ${args.reproduction.afterFix?.exitCode ?? 'n/a'}.`,

      `## Verification\n${ran.map((v) => `- ${v.kind}: ${v.passed ? 'passed' : 'FAILED'}${v.testsPassed !== null ? ` (${v.testsPassed} tests)` : ''}`).join('\n')}` +
        (skipped.length > 0
          ? `\n\n**Not run** — reported as unmeasured, not as passing: ${skipped.map((v) => `${v.kind} (${v.skipReason})`).join('; ')}`
          : ''),

      `## Risk\n${args.patch.risks.length > 0 ? args.patch.risks.map((r) => `- ${r}`).join('\n') : '- None identified by the author.'}`,

      `## Rollback plan\n${args.patch.rollbackPlan}`,

      `---\n` +
        `Regression test and patch authored by ${authorship}. ` +
        `Stated confidence ${args.patch.confidence.toFixed(2)}.` +
        (args.repairAttempted ? ` One bounded repair attempt was used after the first patch failed verification.` : '') +
        `\n\nOpened by Pager Developer. **Merging is a human decision** — this agent has made no ` +
        `production change and cannot merge.`,
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

/** A check's outcome, stating plainly when it did not run. */
export function describeCheck(run: ValidationRun): string {
  if (run.skipped) return `not run (${run.skipReason})`;
  if (run.timedOut) return 'timed out';
  return `${run.passed ? 'passed' : 'FAILED'} (exit ${run.exitCode}${run.testsPassed !== null ? `, ${run.testsPassed} tests passed` : ''})`;
}

function normalisePath(path: string): string {
  return path.replace(/^\.?\//, '');
}

/** Resolve a relative import against a directory, without touching the filesystem. */
function normaliseRelative(dir: string, specifier: string): string | null {
  const segments = [...dir.split('/').filter(Boolean), ...specifier.split('/')];
  const out: string[] = [];
  for (const segment of segments) {
    if (segment === '.' || segment === '') continue;
    if (segment === '..') {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return out.length > 0 ? out.join('/') : null;
}
