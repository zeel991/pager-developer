import { Http } from '../http.js';
import type {
  CreateIssueInput,
  Issue,
  IssueComment,
  IssuePriority,
  IssueRef,
  IssueState,
  IssueTrackerProvider,
} from '../types.js';

/**
 * Jira Cloud adapter (REST API v3).
 *
 * Two pieces of genuine Jira complexity are handled here rather than pushed onto
 * callers:
 *
 *  - **Atlassian Document Format.** v3 will not accept a plain string for a
 *    description or a comment body; it wants a structured document. Incident
 *    narratives are multi-paragraph, so they are converted rather than flattened.
 *
 *  - **Transitions, not state writes.** A Jira issue's status cannot be assigned. You
 *    must look up the transitions available *from the issue's current status* and
 *    execute one by id, and the available set differs per project workflow. So
 *    `updateIssue` resolves the transition by name at call time instead of assuming
 *    fixed ids, which would break on any customised workflow.
 */

interface AdfNode {
  type: string;
  content?: AdfNode[];
  text?: string;
}

/** Convert plain text (with blank-line paragraphs) into ADF. */
export function toAdf(text: string): AdfNode {
  const paragraphs = text.split(/\n{2,}/).filter((p) => p.trim().length > 0);
  return {
    type: 'doc',
    content: (paragraphs.length > 0 ? paragraphs : ['']).map((p) => ({
      type: 'paragraph',
      content: [{ type: 'text', text: p }],
    })),
  };
}

/** Recover plain text from ADF, so a description we read back is usable. */
export function fromAdf(node: unknown): string {
  if (typeof node === 'string') return node;
  if (!node || typeof node !== 'object') return '';
  const n = node as AdfNode;
  if (n.type === 'text') return n.text ?? '';
  const inner = (n.content ?? []).map(fromAdf);
  // Block-level nodes separate with a blank line; inline nodes just concatenate.
  return n.type === 'paragraph' || n.type === 'heading' ? inner.join('') : inner.join('\n\n');
}

interface JiraIssueResponse {
  id: string;
  key: string;
  fields?: {
    summary?: string;
    description?: unknown;
    labels?: string[];
    created?: string;
    updated?: string;
    status?: { name?: string; statusCategory?: { key?: string } };
  };
}

interface JiraStatus {
  name?: string;
  statusCategory?: { key?: string };
}

interface JiraTransition {
  id: string;
  name: string;
  to?: { name?: string; statusCategory?: { key?: string } };
}

/**
 * Jira status categories are the only stable signal across custom workflows:
 * every status belongs to `new`, `indeterminate` or `done`. Status *names* are
 * arbitrary per project, so category is checked first and name only as a refinement.
 */
function toIssueState(status: JiraStatus | undefined): IssueState {
  const category = status?.statusCategory?.key;
  const name = (status?.name ?? '').toLowerCase();
  if (category === 'done') return name.includes('close') ? 'closed' : 'resolved';
  if (category === 'indeterminate') return name.includes('block') || name.includes('hold') ? 'blocked' : 'in_progress';
  return 'open';
}

/** Transition names we will look for, in preference order, per target state. */
const TRANSITION_NAMES: Record<IssueState, string[]> = {
  open: ['To Do', 'Open', 'Backlog', 'Reopen'],
  in_progress: ['In Progress', 'Start Progress', 'In Review'],
  blocked: ['Blocked', 'On Hold', 'Waiting'],
  resolved: ['Resolve', 'Resolved', 'Done', 'Fixed'],
  closed: ['Close', 'Closed', 'Done'],
};

const PRIORITY_NAMES: Record<IssuePriority, string> = {
  urgent: 'Highest',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

export class JiraStateError extends Error {
  constructor(readonly issue: string, readonly target: IssueState, readonly available: string[]) {
    super(
      `Jira issue ${issue} has no transition to "${target}". Available from its current status: ` +
        `${available.join(', ') || '(none)'}`,
    );
    this.name = 'JiraStateError';
  }
}

export interface JiraProviderOptions {
  baseUrl: string;
  projectKey: string;
  issueType?: string;
  /** Atlassian API token, used with `email` as HTTP Basic. */
  email?: string;
  apiToken?: string;
  /** OAuth bearer, as an alternative to Basic. */
  token?: string;
  siteUrl?: string;
  fetchImpl?: typeof globalThis.fetch;
}

export class JiraProvider implements IssueTrackerProvider {
  readonly kind = 'issue-tracker' as const;
  private readonly http: Http;
  private readonly projectKey: string;
  private readonly issueType: string;
  private readonly siteUrl: string;

  constructor(opts: JiraProviderOptions) {
    this.projectKey = opts.projectKey;
    this.issueType = opts.issueType ?? 'Task';
    this.siteUrl = (opts.siteUrl ?? opts.baseUrl).replace(/\/+$/, '');

    const headers: Record<string, string> = {};
    if (opts.email && opts.apiToken) {
      headers.authorization = `Basic ${Buffer.from(`${opts.email}:${opts.apiToken}`).toString('base64')}`;
    } else if (opts.token) {
      headers.authorization = `Bearer ${opts.token}`;
    }

    this.http = new Http({
      baseUrl: opts.baseUrl,
      headers,
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    });
  }

  async createIssue(input: CreateIssueInput): Promise<IssueRef> {
    const res = await this.http.post<{ id: string; key: string }>('/rest/api/3/issue', {
      fields: {
        project: { key: this.projectKey },
        issuetype: { name: this.issueType },
        summary: input.title,
        description: toAdf(input.description),
        ...(input.labels?.length ? { labels: input.labels } : {}),
        ...(input.priority ? { priority: { name: PRIORITY_NAMES[input.priority] } } : {}),
      },
    });
    return { id: res.id, key: res.key, url: `${this.siteUrl}/browse/${res.key}` };
  }

  async getIssue(idOrKey: string): Promise<Issue | null> {
    const res = await this.http.getOptional<JiraIssueResponse>(`/rest/api/3/issue/${idOrKey}`);
    if (!res) return null;
    const f = res.fields ?? {};
    return {
      id: res.id,
      key: res.key,
      url: `${this.siteUrl}/browse/${res.key}`,
      title: f.summary ?? '',
      description: fromAdf(f.description),
      state: toIssueState(f.status),
      labels: f.labels ?? [],
      createdAt: f.created ? new Date(f.created) : new Date(0),
      updatedAt: f.updated ? new Date(f.updated) : null,
    };
  }

  async updateIssue(
    idOrKey: string,
    input: { title?: string; description?: string; state?: IssueState },
  ): Promise<void> {
    const fields: Record<string, unknown> = {};
    if (input.title !== undefined) fields.summary = input.title;
    if (input.description !== undefined) fields.description = toAdf(input.description);
    if (Object.keys(fields).length > 0) {
      await this.http.put(`/rest/api/3/issue/${idOrKey}`, { fields });
    }
    if (input.state) await this.transitionTo(idOrKey, input.state);
  }

  /**
   * Move an issue to a state by finding a matching transition from its current
   * status. Fails loudly when none exists rather than reporting a silent success —
   * an incident that believes it is resolved when the tracker still says open is
   * worse than an error.
   */
  private async transitionTo(idOrKey: string, target: IssueState): Promise<void> {
    const res = await this.http.get<{ transitions?: JiraTransition[] }>(
      `/rest/api/3/issue/${idOrKey}/transitions`,
    );
    const transitions = res.transitions ?? [];
    const wanted = TRANSITION_NAMES[target].map((n) => n.toLowerCase());

    const match =
      transitions.find((t) => wanted.includes(t.name.toLowerCase())) ??
      // Fall back to any transition landing in the right status category.
      transitions.find((t) => toIssueState(t.to) === target);

    if (!match) {
      throw new JiraStateError(idOrKey, target, transitions.map((t) => t.name));
    }
    await this.http.post(`/rest/api/3/issue/${idOrKey}/transitions`, { transition: { id: match.id } });
  }

  async addComment(idOrKey: string, body: string): Promise<IssueComment> {
    const res = await this.http.post<{ id: string; created?: string }>(
      `/rest/api/3/issue/${idOrKey}/comment`,
      { body: toAdf(body) },
    );
    return { id: res.id, body, createdAt: res.created ? new Date(res.created) : new Date() };
  }

  async listComments(idOrKey: string): Promise<IssueComment[]> {
    const res = await this.http.get<{ comments?: { id: string; body?: unknown; created?: string }[] }>(
      `/rest/api/3/issue/${idOrKey}/comment`,
    );
    return (res.comments ?? []).map((c) => ({
      id: c.id,
      body: fromAdf(c.body),
      createdAt: c.created ? new Date(c.created) : new Date(0),
    }));
  }
}
