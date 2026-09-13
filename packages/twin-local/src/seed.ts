import {
  commitSha,
  emptyState,
  type StoredCommit,
  type StoredLog,
  type StoredMetricSeries,
  type StoredMonitor,
  type StoredRepository,
  type TwinState,
} from './store.js';

/**
 * Scenario fixtures.
 *
 * A fixture describes a repository as a sequence of commits, each expressed as file
 * changes. The twin then derives shas, trees and diffs from that — so the fixture
 * cannot claim a change it did not make, and the diff an investigation sees is a
 * real consequence of the seeded code.
 */

export interface CommitFixture {
  message: string;
  author: string;
  at: string;
  /** `null` content deletes the file. */
  changes: { path: string; content: string | null }[];
  branch?: string;
  mergeOf?: string;
}

export interface MetricFixture {
  service: string;
  metric: string;
  unit: string;
  /** Value before onset. */
  baseline: number;
  /** Value after onset. When equal to baseline the metric is flat. */
  after: number;
  /** When the change begins. Defaults to the deployment time. */
  onsetAt?: string;
  /** Fractional jitter applied deterministically, so baselines are not suspiciously flat. */
  jitter?: number;
}

export interface LogFixture {
  service: string;
  level: string;
  message: string;
  stack?: string;
  from: string;
  count: number;
  intervalSeconds?: number;
  attributes?: Record<string, unknown>;
}

export interface ScenarioFixture {
  id: string;
  repository: string;
  defaultBranch?: string;
  description?: string;
  service: string;
  /** Window start for generated telemetry. */
  windowFrom: string;
  windowTo: string;
  deployedAt: string;
  commits: CommitFixture[];
  pullRequests?: {
    number: number;
    title: string;
    body: string;
    headRef: string;
    baseRef: string;
    mergedAtCommit?: string;
  }[];
  metrics: MetricFixture[];
  logs?: LogFixture[];
  monitors?: Omit<StoredMonitor, 'id'>[];
  slackChannels?: string[];
  /** Runbooks and service docs an investigation may consult. */
  pages?: { id?: string; title: string; content: string }[];
}

const SAMPLE_INTERVAL_MS = 60_000;

/**
 * Deterministic pseudo-jitter.
 *
 * Real telemetry is never perfectly flat, and a detector tuned against flat data
 * would be tuned against something that does not occur. This is seeded from the
 * sample index so runs remain byte-identical.
 */
function jitterAt(index: number, amplitude: number): number {
  if (amplitude === 0) return 0;
  const x = Math.sin(index * 12.9898) * 43758.5453;
  return (x - Math.floor(x) - 0.5) * 2 * amplitude;
}

function buildSeries(fixture: MetricFixture, windowFrom: number, windowTo: number, deployedAt: number): StoredMetricSeries {
  const onset = fixture.onsetAt ? Date.parse(fixture.onsetAt) : deployedAt;
  const points = [];
  let i = 0;
  for (let at = windowFrom; at <= windowTo; at += SAMPLE_INTERVAL_MS, i++) {
    const base = at < onset ? fixture.baseline : fixture.after;
    const value = base + base * jitterAt(i, fixture.jitter ?? 0.05);
    points.push({ at, value: Math.max(0, Number(value.toFixed(6))) });
  }
  return { service: fixture.service, metric: fixture.metric, unit: fixture.unit, points };
}

function buildLogs(fixtures: LogFixture[]): StoredLog[] {
  const out: StoredLog[] = [];
  for (const f of fixtures) {
    const start = Date.parse(f.from);
    const interval = (f.intervalSeconds ?? 20) * 1000;
    for (let n = 0; n < f.count; n++) {
      out.push({
        at: start + n * interval,
        service: f.service,
        level: f.level,
        message: f.message,
        stack: f.stack ?? null,
        attributes: f.attributes ?? {},
      });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

/** Materialise a fixture into twin state. */
export function seedFromFixture(fixture: ScenarioFixture): TwinState {
  const state = emptyState();
  const defaultBranch = fixture.defaultBranch ?? 'main';

  const repo: StoredRepository = {
    fullName: fixture.repository,
    defaultBranch,
    description: fixture.description ?? '',
    commits: [],
    branches: new Map(),
    pullRequests: [],
  };

  // Commits are applied in order, each inheriting the previous snapshot for its
  // branch, so a tree is always the real consequence of the changes applied to it.
  const branchHeads = new Map<string, StoredCommit>();
  for (const c of fixture.commits) {
    const branch = c.branch ?? defaultBranch;
    const parent = branchHeads.get(branch) ?? (branch === defaultBranch ? undefined : branchHeads.get(defaultBranch));
    const files = new Map(parent?.files ?? []);
    for (const change of c.changes) {
      if (change.content === null) files.delete(change.path);
      else files.set(change.path, change.content);
    }

    const parents: string[] = [];
    if (parent) parents.push(parent.sha);
    if (c.mergeOf) {
      const merged = branchHeads.get(c.mergeOf);
      if (merged) {
        parents.push(merged.sha);
        // A merge takes the merged branch's content.
        for (const [p, content] of merged.files) files.set(p, content);
      }
    }

    const sha = commitSha(c.message, parents, files);
    const commit: StoredCommit = {
      sha,
      message: c.message,
      authorName: c.author,
      authorEmail: `${c.author.toLowerCase().replace(/\s+/g, '.')}@example.com`,
      committedAt: c.at,
      parents,
      files,
    };
    repo.commits.unshift(commit);
    branchHeads.set(branch, commit);
    repo.branches.set(branch, sha);
  }

  for (const pr of fixture.pullRequests ?? []) {
    const head = branchHeads.get(pr.headRef);
    const mergeCommit = pr.mergedAtCommit
      ? repo.commits.find((c) => c.message === pr.mergedAtCommit)
      : undefined;
    repo.pullRequests.push({
      number: pr.number,
      title: pr.title,
      body: pr.body,
      headRef: pr.headRef,
      baseRef: pr.baseRef,
      state: mergeCommit ? 'closed' : 'open',
      merged: Boolean(mergeCommit),
      mergeCommitSha: mergeCommit?.sha ?? null,
      headSha: head?.sha ?? '',
    });
  }

  state.repositories.set(repo.fullName, repo);

  const windowFrom = Date.parse(fixture.windowFrom);
  const windowTo = Date.parse(fixture.windowTo);
  const deployedAt = Date.parse(fixture.deployedAt);
  state.metrics = fixture.metrics.map((m) => buildSeries(m, windowFrom, windowTo, deployedAt));
  state.logs = buildLogs(fixture.logs ?? []);
  state.monitors = (fixture.monitors ?? []).map((m, i) => ({ ...m, id: i + 1 }));
  for (const c of fixture.slackChannels ?? ['#incidents']) state.channels.add(c);

  state.pages = (fixture.pages ?? []).map((p, i) => ({
    id: p.id ?? `page-${i + 1}`,
    title: p.title,
    content: p.content,
    parentId: null,
  }));

  return state;
}
