import { createHash } from 'node:crypto';

/**
 * In-memory state for the local twins.
 *
 * The reason this package exists rather than relying solely on Arga: the hosted
 * GitHub twin stores an object graph but does not compute diffs, so a scenario
 * cannot express "these files changed between these two revisions" — which is the
 * single most important input to a deployment investigation. Here a commit owns a
 * full file snapshot, so a diff is real and derived, never declared.
 *
 * Everything is deterministic. Shas are content-addressed, timestamps come from the
 * scenario, and `reset()` restores the exact seeded state so an evaluation can run
 * the same scenario repeatedly and get the same answer.
 */

export interface FileBlob {
  path: string;
  content: string;
}

export interface StoredCommit {
  sha: string;
  message: string;
  authorName: string;
  authorEmail: string;
  committedAt: string;
  parents: string[];
  /** Full snapshot of the tree at this commit. Diffs are computed from these. */
  files: Map<string, string>;
}

export interface StoredPullRequest {
  number: number;
  title: string;
  body: string;
  headRef: string;
  baseRef: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergeCommitSha: string | null;
  headSha: string;
}

export interface StoredRepository {
  fullName: string;
  defaultBranch: string;
  description: string;
  commits: StoredCommit[];
  branches: Map<string, string>;
  pullRequests: StoredPullRequest[];
}

export interface StoredMetricPoint {
  at: number;
  value: number;
}

export interface StoredMetricSeries {
  service: string;
  metric: string;
  unit: string;
  points: StoredMetricPoint[];
}

export interface StoredLog {
  at: number;
  service: string;
  level: string;
  message: string;
  stack: string | null;
  attributes: Record<string, unknown>;
}

export interface StoredMonitor {
  id: number;
  name: string;
  service: string;
  query: string;
  state: 'OK' | 'Warn' | 'Alert' | 'No Data';
  transitionedAt: string | null;
}

export interface StoredMessage {
  ts: string;
  channel: string;
  threadTs: string | null;
  text: string;
  blocks: unknown;
}

export interface GitHubApp {
  id: number;
  slug: string;
  privateKeyPem: string;
  permissions: Record<string, string>;
}

export interface StoredIssue {
  id: string;
  key: string;
  title: string;
  description: string;
  /** Provider-native status name, so each twin can map it as the real API would. */
  status: string;
  labels: string[];
  priority: string | null;
  createdAt: string;
  updatedAt: string | null;
  comments: { id: string; body: string; createdAt: string }[];
}

export interface StoredPage {
  id: string;
  title: string;
  /** Plain text; the Notion twin renders it into blocks on read. */
  content: string;
  parentId: string | null;
}

export interface TwinState {
  repositories: Map<string, StoredRepository>;
  metrics: StoredMetricSeries[];
  logs: StoredLog[];
  monitors: StoredMonitor[];
  channels: Set<string>;
  messages: StoredMessage[];
  apps: Map<number, GitHubApp>;
  manifestCodes: Map<string, number>;
  installationTokens: Map<string, number>;
  issues: StoredIssue[];
  pages: StoredPage[];
}

/** Content-addressed sha, so the same seed always produces the same history. */
export function commitSha(
  message: string,
  parents: string[],
  files: Map<string, string>,
): string {
  const hash = createHash('sha1');
  hash.update(message);
  hash.update(parents.join(','));
  for (const path of [...files.keys()].sort()) {
    hash.update(path);
    hash.update(files.get(path) ?? '');
  }
  return hash.digest('hex');
}

export function blobSha(content: string): string {
  return createHash('sha1').update(`blob ${content.length}\0${content}`).digest('hex');
}

export interface ChangedFileRecord {
  path: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  patch: string;
}

/**
 * A real diff between two commits, computed from their file snapshots.
 *
 * Line counts come from an actual line-by-line comparison rather than being
 * declared by the scenario, so a scenario cannot assert a change it did not make.
 */
export function diffCommits(base: StoredCommit, head: StoredCommit): ChangedFileRecord[] {
  const out: ChangedFileRecord[] = [];

  for (const [path, content] of head.files) {
    const before = base.files.get(path);
    if (before === undefined) {
      out.push({
        path,
        status: 'added',
        additions: lineCount(content),
        deletions: 0,
        patch: unifiedPatch(path, '', content),
      });
    } else if (before !== content) {
      const { additions, deletions } = lineDelta(before, content);
      out.push({ path, status: 'modified', additions, deletions, patch: unifiedPatch(path, before, content) });
    }
  }

  for (const [path, content] of base.files) {
    if (!head.files.has(path)) {
      out.push({
        path,
        status: 'removed',
        additions: 0,
        deletions: lineCount(content),
        patch: unifiedPatch(path, content, ''),
      });
    }
  }

  return out.sort((a, b) => a.path.localeCompare(b.path));
}

function lineCount(s: string): number {
  return s === '' ? 0 : s.split('\n').length;
}

function lineDelta(before: string, after: string): { additions: number; deletions: number } {
  const a = before.split('\n');
  const b = after.split('\n');
  const setA = new Map<string, number>();
  for (const line of a) setA.set(line, (setA.get(line) ?? 0) + 1);

  let additions = 0;
  for (const line of b) {
    const remaining = setA.get(line) ?? 0;
    if (remaining > 0) setA.set(line, remaining - 1);
    else additions++;
  }
  let deletions = 0;
  for (const remaining of setA.values()) deletions += remaining;
  return { additions, deletions };
}

/** A readable unified-style patch. Enough for an investigation to reason about. */
function unifiedPatch(path: string, before: string, after: string): string {
  const a = before === '' ? [] : before.split('\n');
  const b = after === '' ? [] : after.split('\n');
  const lines = [`--- a/${path}`, `+++ b/${path}`, `@@ -1,${a.length} +1,${b.length} @@`];
  const beforeSet = new Set(a);
  const afterSet = new Set(b);
  for (const line of a) if (!afterSet.has(line)) lines.push(`-${line}`);
  for (const line of b) if (!beforeSet.has(line)) lines.push(`+${line}`);
  return lines.join('\n');
}

export function emptyState(): TwinState {
  return {
    repositories: new Map(),
    metrics: [],
    logs: [],
    monitors: [],
    channels: new Set(),
    messages: [],
    apps: new Map(),
    manifestCodes: new Map(),
    installationTokens: new Map(),
    issues: [],
    pages: [],
  };
}

export function cloneState(state: TwinState): TwinState {
  return {
    repositories: new Map(
      [...state.repositories].map(([k, r]) => [
        k,
        {
          ...r,
          branches: new Map(r.branches),
          pullRequests: r.pullRequests.map((p) => ({ ...p })),
          commits: r.commits.map((c) => ({ ...c, parents: [...c.parents], files: new Map(c.files) })),
        },
      ]),
    ),
    metrics: state.metrics.map((m) => ({ ...m, points: m.points.map((p) => ({ ...p })) })),
    logs: state.logs.map((l) => ({ ...l })),
    monitors: state.monitors.map((m) => ({ ...m })),
    channels: new Set(state.channels),
    messages: state.messages.map((m) => ({ ...m })),
    apps: new Map(state.apps),
    manifestCodes: new Map(state.manifestCodes),
    installationTokens: new Map(state.installationTokens),
    issues: state.issues.map((i) => ({ ...i, labels: [...i.labels], comments: i.comments.map((c) => ({ ...c })) })),
    pages: state.pages.map((p) => ({ ...p })),
  };
}
