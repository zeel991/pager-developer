import type { ChangedFile, Commit, Environment } from '@pager/core';

/**
 * Provider interfaces.
 *
 * The same interface is implemented against an Arga twin, a local twin and the real
 * vendor API. Nothing downstream of construction may branch on which one it holds —
 * that is the whole point, and it is what makes the evaluation environment
 * meaningful rather than a parallel code path that is never shipped.
 */

export interface Diff {
  baseSha: string;
  headSha: string;
  files: ChangedFile[];
  /** Unified patch text, when the provider supplies it. */
  patch: string | null;
}

export interface PullRequest {
  number: number;
  title: string;
  body: string;
  headRef: string;
  baseRef: string;
  url: string;
  state: 'open' | 'closed' | 'merged';
  mergeCommitSha: string | null;
}

export interface Branch {
  name: string;
  sha: string;
}

export interface CreatePullRequestInput {
  title: string;
  body: string;
  headRef: string;
  baseRef: string;
  draft?: boolean;
}

export interface SourceControlProvider {
  readonly kind: 'source-control';
  getCommit(repo: string, sha: string): Promise<Commit>;
  getDiff(repo: string, baseSha: string, headSha: string): Promise<Diff>;
  listCommitsBetween(repo: string, baseSha: string, headSha: string): Promise<Commit[]>;
  getPullRequest(repo: string, number: number): Promise<PullRequest>;
  listPullRequestsForCommit(repo: string, sha: string): Promise<PullRequest[]>;
  getFile(repo: string, ref: string, path: string): Promise<string | null>;
  createBranch(repo: string, fromSha: string, name: string): Promise<Branch>;
  createPullRequest(repo: string, input: CreatePullRequestInput): Promise<PullRequest>;
  /** Clone URL for the reproduction sandbox. May embed a twin credential. */
  cloneUrl(repo: string): string;
}

export type MetricName =
  | 'error_rate'
  | 'http_5xx_rate'
  | 'request_throughput'
  | 'latency_p50'
  | 'latency_p95'
  | 'latency_p99'
  | 'availability'
  | 'cpu_utilization'
  | 'memory_utilization';

export interface MetricPoint {
  at: Date;
  value: number;
}

export interface MetricSeries {
  metric: MetricName;
  service: string;
  environment: Environment;
  points: MetricPoint[];
  unit: string;
}

export interface LogEntry {
  at: Date;
  service: string;
  level: 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  message: string;
  /** Present on error-level entries that carried one. */
  stackTrace: string | null;
  attributes: Record<string, unknown>;
}

export interface MonitorState {
  id: string;
  name: string;
  status: 'OK' | 'WARN' | 'ALERT' | 'NO_DATA';
  service: string;
  query: string;
  transitionedAt: Date | null;
}

export interface TimeRange {
  from: Date;
  to: Date;
}

export interface ObservabilityProvider {
  readonly kind: 'observability';
  queryMetric(
    service: string,
    metric: MetricName,
    range: TimeRange,
  ): Promise<MetricSeries>;
  queryLogs(
    service: string,
    range: TimeRange,
    opts?: { level?: LogEntry['level']; query?: string; limit?: number },
  ): Promise<LogEntry[]>;
  listMonitors(service: string): Promise<MonitorState[]>;
}

export interface MessageThread {
  id: string;
  channel: string;
}

export interface MessagingProvider {
  readonly kind: 'messaging';
  openThread(channel: string, text: string, blocks?: unknown): Promise<MessageThread>;
  replyInThread(thread: MessageThread, text: string, blocks?: unknown): Promise<void>;
  /** Returns messages in a thread, for verifying what was actually communicated. */
  readThread(thread: MessageThread): Promise<{ text: string; at: Date }[]>;
}

export interface IssueRef {
  id: string;
  key: string;
  url: string;
}

export interface IssueTrackerProvider {
  readonly kind: 'issue-tracker';
  createIssue(input: { title: string; description: string; labels?: string[] }): Promise<IssueRef>;
  updateIssue(id: string, input: { description?: string; state?: string }): Promise<void>;
}

export interface KnowledgeProvider {
  readonly kind: 'knowledge';
  search(query: string, limit?: number): Promise<{ title: string; url: string; excerpt: string }[]>;
  getDocument(id: string): Promise<{ title: string; content: string } | null>;
}

export interface DeploymentRecord {
  id: string;
  service: string;
  environment: Environment;
  commitSha: string;
  previousCommitSha: string | null;
  status: 'pending' | 'in_progress' | 'succeeded' | 'failed' | 'rolled_back';
  startedAt: Date;
  deployedAt: Date | null;
  author: string | null;
  repositoryFullName: string;
}

export interface DeploymentProvider {
  readonly kind: 'deployment';
  listDeployments(service: string, opts?: { limit?: number }): Promise<DeploymentRecord[]>;
  getDeployment(id: string): Promise<DeploymentRecord | null>;
  /** PRODUCTION_WRITE. Guarded by the policy engine, never called directly by an agent. */
  rollback(deploymentId: string): Promise<DeploymentRecord>;
}
