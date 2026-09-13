/**
 * API client.
 *
 * Every fetch is uncached: an incident dashboard showing stale state is worse than
 * one that is briefly empty, because a resolved incident that still reads as
 * burning sends people to a fire that is already out.
 */
const BASE = process.env.PAGER_API_URL ?? 'http://127.0.0.1:4000';

export class ApiUnavailableError extends Error {
  constructor(readonly url: string, cause: unknown) {
    super(`Could not reach the Pager Developer API at ${url}`);
    this.name = 'ApiUnavailableError';
    this.cause = cause;
  }
}

export async function api<T>(path: string): Promise<T> {
  const url = `${BASE}${path}`;
  let res: Response;
  try {
    res = await fetch(url, { cache: 'no-store' });
  } catch (err) {
    throw new ApiUnavailableError(url, err);
  }
  if (!res.ok) {
    if (res.status === 404) throw new Error('not-found');
    throw new Error(`${url} responded ${res.status}`);
  }
  return (await res.json()) as T;
}

export interface IncidentRow {
  id: string;
  key: string;
  state: string;
  severity: string;
  title: string;
  deploymentAttribution: string | null;
  attributionConfidence: number | null;
  openedAt: string;
  resolvedAt: string | null;
  slackChannel: string | null;
}

export interface DeploymentRow {
  id: string;
  commitSha: string;
  previousCommitSha: string | null;
  authorName: string | null;
  environment: string;
  status: string;
  startedAt: string;
  deployedAt: string | null;
}

export interface Overview {
  organization: { id: string; name: string; autonomyLevel: string } | null;
  incidents: IncidentRow[];
  deployments: DeploymentRow[];
  counts: {
    activeIncidents: number;
    investigating: number;
    awaitingApproval: number;
    resolved: number;
    deploymentsTracked: number;
    unattributed: number;
  };
}

export interface TimelineEvent {
  id: string;
  at: string;
  kind: string;
  summary: string;
  fromState: string | null;
  toState: string | null;
}

export interface EvidenceRow {
  id: string;
  kind: string;
  provenance: string;
  summary: string;
  sourceToolCallId: string;
  sourceRef: string | null;
  collectedAt: string;
}

export interface ToolCallRow {
  id: string;
  toolName: string;
  status: string;
  durationMs: number;
  error: string | null;
  startedAt: string;
}

export interface AgentRunRow {
  id: string;
  agentName: string;
  status: string;
  startedAt: string;
  endedAt: string | null;
  toolCalls: ToolCallRow[];
}

export interface TelemetrySnapshot {
  id: string;
  metric: string;
  windowKind: string;
  unit: string;
  sampleCount: number;
  mean: number | null;
  min: number | null;
  max: number | null;
  points: { at: string; value: number }[];
}

export interface IncidentDetail {
  incident: IncidentRow & { serviceId: string; suspectedDeploymentId: string | null; slackThreadTs: string | null };
  service: { id: string; name: string; ownerTeam: string | null } | null;
  deployment:
    | (DeploymentRow & {
        files: { path: string; status: string; additions: number; deletions: number }[];
        commits: { sha: string; message: string; authorName: string; committedAt: string }[];
        pullRequests: { number: number; title: string; url: string }[];
      })
    | null;
  timeline: TimelineEvent[];
  evidence: EvidenceRow[];
  agentRuns: AgentRunRow[];
  auditLog: { id: string; actor: string; action: string; allowed: boolean; denialReason: string | null; at: string }[];
  telemetry: TelemetrySnapshot[];
}
