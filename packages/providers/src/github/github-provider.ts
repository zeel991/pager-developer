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
  fetchImpl?: typeof globalThis.fetch;
}

export class GitHubProvider implements SourceControlProvider {
  readonly kind = 'source-control' as const;
  private readonly http: Http;
  private readonly baseUrl: string;
  private readonly token: string | undefined;

  constructor(opts: GitHubProviderOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.token = opts.token;
    this.http = new Http({
      baseUrl: this.baseUrl,
      headers: {
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
        'x-github-api-version': '2022-11-28',
      },
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    });
  }

  async getCommit(repo: string, sha: string): Promise<Commit> {
    const res = await this.http.get<GhCommitResponse>(`/repos/${repo}/commits/${sha}`);
    return toCommit(res);
  }

  async getDiff(repo: string, baseSha: string, headSha: string): Promise<Diff> {
    const res = await this.http.get<GhCompareResponse>(
      `/repos/${repo}/compare/${baseSha}...${headSha}`,
    );
    const files = res.files ?? [];
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

  async getPullRequest(repo: string, number: number): Promise<PullRequest> {
    const res = await this.http.get<GhPullRequest>(`/repos/${repo}/pulls/${number}`);
    return toPullRequest(res);
  }

  async listPullRequestsForCommit(repo: string, sha: string): Promise<PullRequest[]> {
    const res = await this.http.get<GhPullRequest[]>(`/repos/${repo}/commits/${sha}/pulls`);
    return (res ?? []).map(toPullRequest);
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
