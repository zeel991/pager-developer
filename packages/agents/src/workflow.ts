import type { AgentTracer } from '@pager/observability';
import type {
  EmailProvider,
  IssueTrackerProvider,
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

export interface WorkflowDeps {
  observability: ObservabilityProvider;
  sourceControl: SourceControlProvider;
  messaging: MessagingProvider;
  issueTracker: IssueTrackerProvider | null;
  knowledge: KnowledgeProvider | null;
  email: EmailProvider | null;
  tracer: AgentTracer;
  patchGenerator?: PatchGenerator;
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
      haltReason: null,
    };

    const step = (stage: WorkflowStage, summary: string, detail?: Record<string, unknown>): void => {
      result.stage = stage;
      steps.push({ stage, at: new Date(), summary, ...(detail ? { detail } : {}) });
    };

    const halt = (reason: string): WorkflowResult => {
      result.haltReason = reason;
      step('halted', reason);
      return result;
    };

    // ── 1. Datadog is watching ───────────────────────────────────────────────
    const watcher = new ProductionWatcher(this.deps.observability, this.deps.knowledge);
    const alert = await this.deps.tracer.run('ProductionWatcher', { input: { service: input.service } }, (ctx) =>
      watcher.check(ctx, input.service),
    );
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

    const incidentKey = input.incidentKey ?? `INC-${Date.now().toString(36).toUpperCase()}`;
    const title = `${input.service}: ${cluster.errorType ?? 'Error'} on ${cluster.affectedRoutes[0] ?? 'production'}`;

    // ── 3. Jira ticket ───────────────────────────────────────────────────────
    if (this.deps.issueTracker) {
      const issue = await this.deps.tracer.run('IssueTracker', {}, async (ctx) => {
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
    const thread = await this.deps.tracer.run('CommunicationAgent', {}, (ctx) =>
      comms.openThread(ctx, input.slackChannel, this.openingMessage(alert, incidentKey, result.issue)),
    );
    step('team_notified', `Posted to ${input.slackChannel}`, { threadTs: thread.id });

    // ── 5. Work the fix on a branch ──────────────────────────────────────────
    const baseBranch = input.baseBranch ?? 'main';
    const history = await this.deps.tracer.run('RepositoryInvestigator', {}, async (ctx) => {
      const { value } = await ctx.tool('github.listCommits', { repo: input.repository }, () =>
        this.deps.sourceControl.listCommits(input.repository, { ref: baseBranch, limit: 1 }),
      );
      return value;
    });
    const headSha = history[0]?.sha;
    if (!headSha) return halt(`Could not resolve the head of ${baseBranch}; cannot build a sandbox.`);

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
        return halt(
          `No patch generator is configured, so no regression test could be written. ` +
            `The failure is located at ${frame ? `${toRepositoryPath(frame.file)}:${frame.line}` : 'an unknown frame'} ` +
            `and the sandbox is ready at the deployed revision.`,
        );
      }

      step('reproducing', `Writing a regression test (${proposedTest.kind}).`, { path: proposedTest.path });
      const attempt = await reproduction.demonstrateFailure({
        testPath: proposedTest.path,
        testSource: proposedTest.source,
        command: profile.testCommand ?? 'node --test',
      });
      result.reproduction = attempt;

      if (attempt.failureReason) {
        return halt(`Reproduction failed: ${attempt.failureReason}`);
      }
      step('reproducing', describeReproduction(attempt));

      // 5b. The patch.
      const patch = await this.generator.proposePatch(context);
      if (!patch) return halt('The patch generator produced no patch.');
      result.patch = patch;

      step('patching', `Applying a ${patch.kind} patch to ${patch.files.length} file(s).`, {
        rootCause: patch.rootCause,
      });
      for (const file of patch.files) await sandbox.writeFile(file.path, file.content);

      // 5c. Verify. The reproduction must now pass, and so must everything else.
      const confirmed = await reproduction.confirmFix(attempt);
      result.reproduction = confirmed;
      if (!confirmed.proven) {
        return halt(`Patch rejected: ${confirmed.failureReason}`);
      }

      const summary = await validation.runAll(profile);
      result.validation = [confirmed.afterFix!, ...summary.runs];
      step('validating', `Verification: ${summary.allPassed ? 'passed' : 'FAILED'}`, {
        ran: summary.runs.filter((r) => !r.skipped).map((r) => r.kind),
        skipped: summary.skipped,
      });
      if (!summary.allPassed) {
        return halt('Deterministic verification did not pass; the patch is not offered for merge.');
      }

      // 5d. Branch, commit, pull request.
      const branch = `pager/${incidentKey.toLowerCase()}`;
      const pr = await this.deps.tracer.run('FixAgent', {}, async (ctx) => {
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

      // ── 6. Ask for a merge ─────────────────────────────────────────────────
      await this.deps.tracer.run('CommunicationAgent', {}, (ctx) =>
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
      haltReason: null,
    };
    const step = (stage: WorkflowStage, summary: string): void => {
      result.stage = stage;
      steps.push({ stage, at: new Date(), summary });
    };

    // Confirm the merge from the provider rather than trusting the caller.
    const pr = await this.deps.tracer.run('FixAgent', {}, async (ctx) => {
      const { value } = await ctx.tool('github.getPullRequest', { number: input.pullRequestNumber }, () =>
        this.deps.sourceControl.getPullRequest(input.repository, input.pullRequestNumber),
      );
      return value;
    });
    result.pullRequest = pr;

    if (pr.state !== 'merged') {
      result.haltReason = `Pull request #${pr.number} is ${pr.state}, not merged. Nothing to verify yet.`;
      step('awaiting_merge', result.haltReason);
      return result;
    }
    step('merged', `#${pr.number} merged.`);

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
      return result;
    }
    step('recovered', 'Signals returned to baseline.');

    // ── 8. Write it up in Notion ─────────────────────────────────────────────
    const writeUp = this.writeUp(input.incidentKey, input.alert, input.rootCause, pr, recovery);
    if (this.deps.knowledge) {
      const doc = await this.deps.tracer.run('CommunicationAgent', {}, async (ctx) => {
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
      await this.deps.tracer.run('CommunicationAgent', {}, async (ctx) => {
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
