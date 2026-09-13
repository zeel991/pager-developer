import { deriveWindows, type ChangedFile, type Commit } from '@pager/core';
import type { AgentTracer } from '@pager/observability';
import type { DeploymentRecord, PullRequest, SourceControlProvider } from '@pager/providers';

/**
 * DeploymentObserver — Phase 1.
 *
 * Answers one question: *what actually changed in production?*
 *
 * It makes no judgement about whether the deployment caused anything. That
 * separation is deliberate and load-bearing: the moment deployment reconstruction
 * and blame live in the same component, "the deploy happened just before the errors"
 * starts looking like causation. Attribution is Phase 3's job, on evidence.
 *
 * Every provider call is instrumented, so the reconstruction is not merely a result
 * but an auditable set of observations.
 */

export interface ReconstructedDeployment {
  deployment: DeploymentRecord;
  commits: Commit[];
  changedFiles: ChangedFile[];
  pullRequests: PullRequest[];
  baselineWindow: { from: Date; to: Date };
  observationWindow: { from: Date; to: Date };
  /** Evidence-bearing tool call ids for every observation made here. */
  toolCallIds: string[];
  /**
   * Non-fatal gaps encountered while reconstructing. Recorded rather than hidden:
   * an investigation that proceeds on a partial diff must know the diff was partial.
   */
  gaps: string[];
}

export interface ObserveOptions {
  baselineMinutes?: number;
  observationMinutes?: number;
}

export class DeploymentObserver {
  constructor(
    private readonly sourceControl: SourceControlProvider,
    private readonly tracer: AgentTracer,
  ) {}

  async observe(
    deployment: DeploymentRecord,
    opts: ObserveOptions = {},
    /** Called with the agent run id, for callers that must link the run later. */
    onRunStarted?: (agentRunId: string) => void,
  ): Promise<ReconstructedDeployment> {
    return this.tracer.run(
      'DeploymentObserver',
      { input: { deploymentId: deployment.id, service: deployment.service } },
      async (ctx) => {
        onRunStarted?.(ctx.agentRunId);
        const gaps: string[] = [];
        const repo = deployment.repositoryFullName;

        // A deployment without a predecessor is the first one we have seen for this
        // service. That is not an error, but it does mean there is no diff to reason
        // about, and downstream must not mistake "no changed files" for "nothing
        // changed".
        if (!deployment.previousCommitSha) {
          gaps.push(
            'No previous commit recorded for this service, so no diff could be computed. ' +
              'Changed files and commit list are empty because they are unknown, not because they are empty.',
          );
        }

        let commits: Commit[] = [];
        let changedFiles: ChangedFile[] = [];

        if (deployment.previousCommitSha) {
          const base = deployment.previousCommitSha;
          const head = deployment.commitSha;

          const diffResult = await ctx.tool('github.getDiff', { repo, base, head }, () =>
            this.sourceControl.getDiff(repo, base, head),
          );
          changedFiles = diffResult.value.files;

          const commitsResult = await ctx.tool('github.listCommitsBetween', { repo, base, head }, () =>
            this.sourceControl.listCommitsBetween(repo, base, head),
          );
          commits = commitsResult.value;

          if (changedFiles.length === 0) {
            gaps.push(`Diff ${base}..${head} reported no changed files.`);
          }
        }

        // Pull request association is best-effort: a commit may have reached the
        // branch without one. A failure here degrades context but must not fail the
        // reconstruction, so it is caught — and the tracer records it regardless.
        let pullRequests: PullRequest[] = [];
        try {
          const prs = await ctx.tool(
            'github.listPullRequestsForCommit',
            { repo, sha: deployment.commitSha },
            () => this.sourceControl.listPullRequestsForCommit(repo, deployment.commitSha),
          );
          pullRequests = prs.value;
        } catch (err) {
          gaps.push(
            `Could not associate pull requests with ${deployment.commitSha}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }

        // Windows anchor on deployedAt when the deployment finished, and on startedAt
        // otherwise, so an in-flight deployment still gets a usable baseline.
        const anchor = deployment.deployedAt ?? deployment.startedAt;
        const windows = deriveWindows(anchor, opts);

        return {
          deployment,
          commits,
          changedFiles,
          pullRequests,
          baselineWindow: windows.before,
          observationWindow: windows.after,
          toolCallIds: [...ctx.toolCallIds()],
          gaps,
        };
      },
    );
  }
}

/** Files touched by the deployment — the surface an investigation may blame. */
export function blameSurface(r: ReconstructedDeployment): Set<string> {
  return new Set(r.changedFiles.map((f) => f.path));
}

/**
 * Whether a stack trace path falls inside the deployment's blame surface.
 *
 * This is a *correlation* helper, and callers must treat it as one. A file being in
 * the diff is evidence that the deployment could be responsible; it is not evidence
 * that it is.
 */
export function touchesPath(r: ReconstructedDeployment, path: string): boolean {
  const surface = blameSurface(r);
  if (surface.has(path)) return true;
  const normalized = path.replace(/^\.?\//, '');
  for (const p of surface) {
    if (p.endsWith(normalized) || normalized.endsWith(p)) return true;
  }
  return false;
}
