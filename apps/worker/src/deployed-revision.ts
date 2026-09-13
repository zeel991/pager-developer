import type { DeploymentRecord, SourceControlProvider } from '@pager/providers';

/**
 * What is production actually running?
 *
 * Asked of the service itself, not inferred. The running process reports the commit
 * it was built from — Render injects `RENDER_GIT_COMMIT`, and most platforms provide
 * an equivalent — so the answer comes from the thing being investigated rather than
 * from a branch that has since moved on.
 *
 * This is the load-bearing input for everything downstream: a patch validated
 * against a tree that is not the failing one proves nothing. So when the service
 * cannot say, the worker is told, and it halts rather than guessing.
 */

export interface DeployedRevisionProbe {
  sha: string | null;
  reportedAt: Date;
  /** Everything the health endpoint said, for the record. */
  raw: unknown;
  problem: string | null;
}

const COMMIT_KEYS = ['commit', 'revision', 'sha', 'version', 'build', 'gitCommit', 'git_commit'];

export async function probeDeployedRevision(
  healthUrl: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<DeployedRevisionProbe> {
  const at = new Date();
  try {
    const res = await fetchImpl(healthUrl, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) {
      return { sha: null, reportedAt: at, raw: null, problem: `health endpoint returned ${res.status}` };
    }
    const body = (await res.json()) as Record<string, unknown>;
    for (const key of COMMIT_KEYS) {
      const value = body[key];
      // A full 40-character sha, or an abbreviation long enough to be unambiguous.
      if (typeof value === 'string' && /^[0-9a-f]{7,40}$/i.test(value)) {
        return { sha: value, reportedAt: at, raw: body, problem: null };
      }
    }
    return {
      sha: null,
      reportedAt: at,
      raw: body,
      problem:
        `the service is healthy but reports no commit. Expose the build revision on the ` +
        `health endpoint (on Render, process.env.RENDER_GIT_COMMIT) so the revision under ` +
        `investigation is observed rather than assumed.`,
    };
  } catch (err) {
    return {
      sha: null,
      reportedAt: at,
      raw: null,
      problem: `health endpoint unreachable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Turn an observed revision into a deployment record.
 *
 * The predecessor is the deployed commit's first parent — the prior state of the
 * branch production tracks. The previous entry in a commit log is whatever a merge
 * brought in, and diffing against that yields nothing, which would silently present
 * as "the deployment changed nothing".
 */
export async function deploymentFromRevision(
  sourceControl: SourceControlProvider,
  opts: { repository: string; service: string; sha: string; observedAt: Date },
): Promise<DeploymentRecord> {
  const head = await sourceControl.getCommit(opts.repository, opts.sha);
  return {
    id: `render-${head.sha.slice(0, 12)}`,
    service: opts.service,
    environment: 'production',
    commitSha: head.sha,
    previousCommitSha: head.parents[0] ?? null,
    status: 'succeeded',
    startedAt: head.committedAt,
    deployedAt: head.committedAt,
    author: head.authorName,
    repositoryFullName: opts.repository,
  };
}
