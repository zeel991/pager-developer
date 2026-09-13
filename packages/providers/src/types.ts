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
  /** Most recent commits on a ref, newest first. Used to resolve what is deployed. */
  listCommits(repo: string, opts?: { ref?: string; limit?: number }): Promise<Commit[]>;
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

/**
 * A normalised issue state.
 *
 * Jira workflows and Linear team states are both configurable and neither maps onto
 * the other, so adapters translate to this vocabulary rather than leaking their own.
 * `blocked` exists because an incident that is waiting on a human approval is not
 * the same as one being worked on, and the distinction matters on an incident board.
 */
export type IssueState = 'open' | 'in_progress' | 'blocked' | 'resolved' | 'closed';

export type IssuePriority = 'urgent' | 'high' | 'medium' | 'low';

export interface Issue {
  id: string;
  key: string;
  url: string;
  title: string;
  description: string;
  state: IssueState;
  labels: string[];
  createdAt: Date;
  updatedAt: Date | null;
}

export interface IssueComment {
  id: string;
  body: string;
  createdAt: Date;
}

export interface CreateIssueInput {
  title: string;
  description: string;
  labels?: string[];
  priority?: IssuePriority;
}

export interface IssueTrackerProvider {
  readonly kind: 'issue-tracker';
  createIssue(input: CreateIssueInput): Promise<IssueRef>;
  getIssue(idOrKey: string): Promise<Issue | null>;
  updateIssue(
    idOrKey: string,
    input: { title?: string; description?: string; state?: IssueState },
  ): Promise<void>;
  /** Incident updates are appended as comments, never by rewriting the description. */
  addComment(idOrKey: string, body: string): Promise<IssueComment>;
  listComments(idOrKey: string): Promise<IssueComment[]>;
}

export interface KnowledgeDocument {
  id: string;
  title: string;
  url: string;
  content: string;
}

export interface KnowledgeSearchResult {
  id: string;
  title: string;
  url: string;
  excerpt: string;
}

export interface KnowledgeProvider {
  readonly kind: 'knowledge';
  search(query: string, limit?: number): Promise<KnowledgeSearchResult[]>;
  getDocument(id: string): Promise<KnowledgeDocument | null>;
  /** Used for incident postmortems. WRITE_NON_PRODUCTION. */
  createDocument(input: { title: string; content: string; parentId?: string }): Promise<KnowledgeDocument>;
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
