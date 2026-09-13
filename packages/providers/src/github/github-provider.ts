import type { ChangedFile, Commit } from '@pager/core';
import { Http, ProviderHttpError } from '../http.js';
import type {
  Branch,
  CreatePullRequestInput,
  Diff,
  PullRequest,
  SourceControlProvider,
} from '../types.js';

/**
 * GitHub source control adapter.
 *
 * Written against the real GitHub REST v3 API. An Arga GitHub twin exposes the same
 * endpoints, so this one implementation serves the twin, a self-hosted GitHub
 * Enterprise instance and api.github.com — only the base URL and token differ. There
 * is deliberately no `if (arga)` anywhere in this file.
 */

interface GhCommitResponse {
  sha: string;
  commit: {
    message: string;
    author: { name: string; email?: string; date: string };
  };
  parents?: { sha: string }[];
  files?: GhFile[];
}

interface GhFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  previous_filename?: string;
  patch?: string;
}

interface GhCompareResponse {
  files?: GhFile[];
  commits?: GhCommitResponse[];
}

interface GhTreeEntry {
  path: string;
  type: string;
  sha: string;
  size?: number;
}

interface GhTreeResponse {
  tree?: GhTreeEntry[];
}

interface GhPullRequest {
  number: number;
  title: string;
  body: string | null;
  head: { ref: string; sha: string };
  base: { ref: string };
  html_url: string;
  state: string;
  merged?: boolean;
  merge_commit_sha?: string | null;
}

const FILE_STATUS: Record<string, ChangedFile['status']> = {
  added: 'added',
  modified: 'modified',
  removed: 'removed',
  renamed: 'renamed',
  changed: 'modified',
};

export interface GitHubProviderOptions {
  baseUrl: string;
  token?: string;
  /**
   * Resolves a bearer token per request. Used for GitHub App installation tokens,
   * which expire and must be reminted; takes precedence over a static `token`.
   */
  tokenProvider?: () => Promise<string>;
  fetchImpl?: typeof globalThis.fetch;
}

export class GitHubProvider implements SourceControlProvider {
  readonly kind = 'source-control' as const;
  private readonly http: Http;
  private readonly baseUrl: string;
  private readonly token: string | undefined;
  private readonly tokenProvider: (() => Promise<string>) | undefined;

  constructor(opts: GitHubProviderOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.token = opts.token;
    this.tokenProvider = opts.tokenProvider;
    this.http = new Http({
      baseUrl: this.baseUrl,
      headers: {
        ...(opts.token && !opts.tokenProvider ? { authorization: `Bearer ${opts.token}` } : {}),
        'x-github-api-version': '2022-11-28',
      },
      ...(opts.tokenProvider
        ? { dynamicHeaders: async () => ({ authorization: `Bearer ${await opts.tokenProvider!()}` }) }
        : {}),
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    });
  }

  /** Current credential, for the sandbox clone URL. Never logged. */
  private async currentToken(): Promise<string | undefined> {
    if (this.tokenProvider) return this.tokenProvider();
    return this.token;
  }

  /** Clone URL carrying a freshly resolved credential. */
  async authenticatedCloneUrl(repo: string): Promise<string> {
    const token = await this.currentToken();
    const url = new URL(this.baseUrl);
    const host = url.host.startsWith('api.') ? url.host.slice(4) : url.host;
    const auth = token ? `x-access-token:${encodeURIComponent(token)}@` : '';
    return `${url.protocol}//${auth}${host}/${repo}.git`;
  }

  async getCommit(repo: string, sha: string): Promise<Commit> {
    const res = await this.http.get<GhCommitResponse>(`/repos/${repo}/commits/${sha}`);
    return toCommit(res);
  }

  /**
   * The diff between two revisions.
   *
   * `/compare` is the direct route and is what real GitHub answers. Some
   * GitHub-compatible implementations — including the Arga twin — return the correct
   * compare schema with an empty `files` array, because they store the object graph
   * but do not compute diffs. Rather than reporting "nothing changed" (which an
   * investigation would read as a real absence and could use to exonerate a
   * deployment), an empty compare falls back to diffing the two git trees directly.
   *
   * Tree comparison is not an approximation: comparing blob shas path-by-path is
   * what a diff is. It costs the line counts, which are reported as zero and
   * flagged via `patch: null` rather than invented.
   */
  async getDiff(repo: string, baseSha: string, headSha: string): Promise<Diff> {
    const res = await this.http.get<GhCompareResponse>(
      `/repos/${repo}/compare/${baseSha}...${headSha}`,
    );
    const files = res.files ?? [];

    if (files.length === 0) {
      const fromTrees = await this.diffTrees(repo, baseSha, headSha);
      if (fromTrees.length > 0) {
        return { baseSha, headSha, files: fromTrees, patch: null };
      }
    }

    return {
      baseSha,
      headSha,
      files: files.map(toChangedFile),
      // Reassembled from per-file patches; null rather than an empty string when the
      // provider gave us nothing, so "no patch available" is distinguishable from
      // "an empty patch".
      patch: files.some((f) => f.patch)
        ? files
            .filter((f) => f.patch)
            .map((f) => `--- ${f.filename}\n${f.patch}`)
            .join('\n')
        : null,
    };
  }

  async listCommitsBetween(repo: string, baseSha: string, headSha: string): Promise<Commit[]> {
    const res = await this.http.get<GhCompareResponse>(
      `/repos/${repo}/compare/${baseSha}...${headSha}`,
    );
    return (res.commits ?? []).map(toCommit);
  }

  /** Recursive tree for a revision, as a path -> blob sha map. */
  private async treeMap(repo: string, sha: string): Promise<Map<string, string>> {
    const res = await this.http.getOptional<GhTreeResponse>(
      `/repos/${repo}/git/trees/${sha}`,
      { recursive: 1 },
    );
    const map = new Map<string, string>();
    for (const entry of res?.tree ?? []) {
      if (entry.type === 'blob') map.set(entry.path, entry.sha);
    }
    return map;
  }

  /** Changed files derived by comparing two revisions' trees. */
  private async diffTrees(repo: string, baseSha: string, headSha: string): Promise<ChangedFile[]> {
    const [base, head] = await Promise.all([
      this.treeMap(repo, baseSha),
      this.treeMap(repo, headSha),
    ]);
    if (base.size === 0 && head.size === 0) return [];

    const changed: ChangedFile[] = [];
    for (const [path, sha] of head) {
      const before = base.get(path);
      if (before === undefined) {
        changed.push({ path, status: 'added', additions: 0, deletions: 0 });
      } else if (before !== sha) {
        changed.push({ path, status: 'modified', additions: 0, deletions: 0 });
      }
    }
    for (const path of base.keys()) {
      if (!head.has(path)) {
        changed.push({ path, status: 'removed', additions: 0, deletions: 0 });
      }
    }
    return changed.sort((a, b) => a.path.localeCompare(b.path));
  }

  async listCommits(repo: string, opts: { ref?: string; limit?: number } = {}): Promise<Commit[]> {
    const res = await this.http.get<GhCommitResponse[]>(`/repos/${repo}/commits`, {
      ...(opts.ref ? { sha: opts.ref } : {}),
      per_page: opts.limit ?? 30,
    });
    return (res ?? []).map(toCommit);
  }

  async getPullRequest(repo: string, number: number): Promise<PullRequest> {
    const res = await this.http.get<GhPullRequest>(`/repos/${repo}/pulls/${number}`);
    return toPullRequest(res);
  }

  /**
   * Pull requests associated with a commit.
   *
   * `/commits/{sha}/pulls` is the direct route, but not every GitHub-compatible
   * implementation provides it. Rather than reporting "no pull requests" — which
   * downstream would read as a real absence — an empty or missing result falls back
   * to matching the commit against merged pull requests' merge commits.
   */
  async listPullRequestsForCommit(repo: string, sha: string): Promise<PullRequest[]> {
    const direct = await this.http.getOptional<GhPullRequest[]>(
      `/repos/${repo}/commits/${sha}/pulls`,
    );
    if (direct && direct.length > 0) return direct.map(toPullRequest);

    const all = await this.http.getOptional<GhPullRequest[]>(`/repos/${repo}/pulls`, {
      state: 'all',
      per_page: 100,
    });
    return (all ?? [])
      .filter((pr) => pr.merge_commit_sha === sha || pr.head?.sha === sha)
      .map(toPullRequest);
  }

  async getFile(repo: string, ref: string, path: string): Promise<string | null> {
    const res = await this.http.getOptional<{ content?: string; encoding?: string }>(
      `/repos/${repo}/contents/${path}`,
      { ref },
    );
    if (!res?.content) return null;
    return res.encoding === 'base64'
      ? Buffer.from(res.content, 'base64').toString('utf8')
      : res.content;
  }

  async listFiles(repo: string, ref: string): Promise<string[]> {
    const res = await this.http.getOptional<GhTreeResponse>(`/repos/${repo}/git/trees/${ref}`, {
      recursive: 1,
    });
    return (res?.tree ?? []).filter((e) => e.type === 'blob').map((e) => e.path).sort();
  }

  async createBranch(repo: string, fromSha: string, name: string): Promise<Branch> {
    const res = await this.http.post<{ ref: string; object: { sha: string } }>(
      `/repos/${repo}/git/refs`,
      { ref: `refs/heads/${name}`, sha: fromSha },
    );
    return { name: res.ref.replace(/^refs\/heads\//, ''), sha: res.object.sha };
  }

  async createPullRequest(repo: string, input: CreatePullRequestInput): Promise<PullRequest> {
    const res = await this.http.post<GhPullRequest>(`/repos/${repo}/pulls`, {
      title: input.title,
      body: input.body,
      head: input.headRef,
      base: input.baseRef,
      draft: input.draft ?? false,
    });
    return toPullRequest(res);
  }

  /**
   * Clone URL for the reproduction sandbox.
   *
   * Derived from the API base URL so a twin clones from the twin. The token is
   * embedded because the sandbox clones over HTTPS; it is credential material and
   * must never be logged — callers log `repo`, not this.
   */
  cloneUrl(repo: string): string {
    const url = new URL(this.baseUrl);
    // api.github.com/repos/... is served from github.com for git operations.
    const host = url.host.startsWith('api.') ? url.host.slice(4) : url.host;
    const auth = this.token ? `${encodeURIComponent(this.token)}@` : '';
    return `${url.protocol}//${auth}${host}/${repo}.git`;
  }
}

function toCommit(res: GhCommitResponse): Commit {
  return {
    sha: res.sha,
    message: res.commit.message,
    authorName: res.commit.author.name,
    ...(res.commit.author.email ? { authorEmail: res.commit.author.email } : {}),
    committedAt: new Date(res.commit.author.date),
    parents: (res.parents ?? []).map((p) => p.sha),
  };
}

function toChangedFile(f: GhFile): ChangedFile {
  return {
    path: f.filename,
    status: FILE_STATUS[f.status] ?? 'modified',
    additions: f.additions ?? 0,
    deletions: f.deletions ?? 0,
    ...(f.previous_filename ? { previousPath: f.previous_filename } : {}),
  };
}

function toPullRequest(pr: GhPullRequest): PullRequest {
  return {
    number: pr.number,
    title: pr.title,
    body: pr.body ?? '',
    headRef: pr.head.ref,
    baseRef: pr.base.ref,
    url: pr.html_url,
    state: pr.merged ? 'merged' : pr.state === 'closed' ? 'closed' : 'open',
    mergeCommitSha: pr.merge_commit_sha ?? null,
  };
}

export { ProviderHttpError };
