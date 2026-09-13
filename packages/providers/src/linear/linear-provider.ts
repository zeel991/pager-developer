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
 * Linear adapter (GraphQL API).
 *
 * Linear differs from Jira in three ways that matter here:
 *
 *  - It is GraphQL over a single endpoint, and it answers HTTP 200 with an `errors`
 *    array for application-level failures. Every response is therefore checked for
 *    `errors` — a 200 is not success.
 *  - Workflow states are per-team rows with a `type` (`triage`, `unstarted`,
 *    `started`, `completed`, `canceled`). Setting a state means resolving a state id
 *    for that team, so states are fetched and cached per team rather than guessed.
 *  - Priority is an integer 0-4, not a name.
 */

interface GraphQLResponse<T> {
  data?: T;
  errors?: { message: string; extensions?: Record<string, unknown> }[];
}

export class LinearApiError extends Error {
  constructor(readonly operation: string, readonly messages: string[]) {
    super(`Linear ${operation} failed: ${messages.join('; ')}`);
    this.name = 'LinearApiError';
  }
}

interface LinearIssueNode {
  id: string;
  identifier: string;
  title: string;
  description?: string | null;
  url: string;
  createdAt: string;
  updatedAt?: string | null;
  labels?: { nodes: { name: string }[] };
  state?: { name: string; type: string };
}

interface LinearWorkflowState {
  id: string;
  name: string;
  type: string;
}

/** Linear priority is an integer: 0 none, 1 urgent … 4 low. */
const PRIORITY_VALUES: Record<IssuePriority, number> = {
  urgent: 1,
  high: 2,
  medium: 3,
  low: 4,
};

function toIssueState(state: { name?: string; type?: string } | undefined): IssueState {
  const name = (state?.name ?? '').toLowerCase();
  switch (state?.type) {
    case 'completed':
      return 'resolved';
    case 'canceled':
      return 'closed';
    case 'started':
      return name.includes('block') || name.includes('hold') ? 'blocked' : 'in_progress';
    default:
      return 'open';
  }
}

/** Preferred Linear state types for each normalised state, in order. */
const STATE_TYPES: Record<IssueState, string[]> = {
  open: ['unstarted', 'triage', 'backlog'],
  in_progress: ['started'],
  blocked: ['started'],
  resolved: ['completed'],
  closed: ['canceled', 'completed'],
};

const ISSUE_FIELDS = `
  id identifier title description url createdAt updatedAt
  labels { nodes { name } }
  state { name type }
`;

export interface LinearProviderOptions {
  baseUrl?: string;
  teamId: string;
  apiKey?: string;
  fetchImpl?: typeof globalThis.fetch;
}

export class LinearProvider implements IssueTrackerProvider {
  readonly kind = 'issue-tracker' as const;
  private readonly http: Http;
  private readonly teamId: string;
  private statesCache: LinearWorkflowState[] | null = null;

  constructor(opts: LinearProviderOptions) {
    this.teamId = opts.teamId;
    this.http = new Http({
      baseUrl: opts.baseUrl ?? 'https://api.linear.app',
      headers: opts.apiKey
        ? // A Linear personal API key is sent bare; an OAuth token uses Bearer.
          { authorization: opts.apiKey.startsWith('lin_oauth') ? `Bearer ${opts.apiKey}` : opts.apiKey }
        : {},
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    });
  }

  private async query<T>(operation: string, query: string, variables: Record<string, unknown>): Promise<T> {
    const res = await this.http.post<GraphQLResponse<T>>('/graphql', { query, variables });
    if (res.errors?.length) {
      throw new LinearApiError(operation, res.errors.map((e) => e.message));
    }
    if (!res.data) throw new LinearApiError(operation, ['response carried no data']);
    return res.data;
  }

  /** Workflow states for the configured team. Cached: they change rarely. */
  private async workflowStates(): Promise<LinearWorkflowState[]> {
    if (this.statesCache) return this.statesCache;
    const data = await this.query<{ team: { states: { nodes: LinearWorkflowState[] } } }>(
      'workflowStates',
      `query States($teamId: String!) { team(id: $teamId) { states { nodes { id name type } } } }`,
      { teamId: this.teamId },
    );
    this.statesCache = data.team.states.nodes;
    return this.statesCache;
  }

  private async resolveStateId(target: IssueState): Promise<string> {
    const states = await this.workflowStates();
    for (const type of STATE_TYPES[target]) {
      // For `blocked`, prefer a started state actually named for blocking.
      if (target === 'blocked') {
        const named = states.find(
          (s) => s.type === type && /block|hold|wait/i.test(s.name),
        );
        if (named) return named.id;
      }
      const match = states.find((s) => s.type === type);
      if (match) return match.id;
    }
    throw new LinearApiError(
      'resolveState',
      [`team ${this.teamId} has no workflow state matching "${target}" (types tried: ${STATE_TYPES[target].join(', ')})`],
    );
  }

  async createIssue(input: CreateIssueInput): Promise<IssueRef> {
    const data = await this.query<{ issueCreate: { success: boolean; issue: LinearIssueNode } }>(
      'issueCreate',
      `mutation Create($input: IssueCreateInput!) {
         issueCreate(input: $input) { success issue { id identifier url } }
       }`,
      {
        input: {
          teamId: this.teamId,
          title: input.title,
          description: input.description,
          ...(input.priority ? { priority: PRIORITY_VALUES[input.priority] } : {}),
        },
      },
    );
    if (!data.issueCreate.success) throw new LinearApiError('issueCreate', ['success was false']);
    const issue = data.issueCreate.issue;
    return { id: issue.id, key: issue.identifier, url: issue.url };
  }

  async getIssue(idOrKey: string): Promise<Issue | null> {
    const data = await this.query<{ issue: LinearIssueNode | null }>(
      'issue',
      `query Issue($id: String!) { issue(id: $id) { ${ISSUE_FIELDS} } }`,
      { id: idOrKey },
    );
    const node = data.issue;
    if (!node) return null;
    return {
      id: node.id,
      key: node.identifier,
      url: node.url,
      title: node.title,
      description: node.description ?? '',
      state: toIssueState(node.state),
      labels: node.labels?.nodes.map((l) => l.name) ?? [],
      createdAt: new Date(node.createdAt),
      updatedAt: node.updatedAt ? new Date(node.updatedAt) : null,
    };
  }

  async updateIssue(
    idOrKey: string,
    input: { title?: string; description?: string; state?: IssueState },
  ): Promise<void> {
    const patch: Record<string, unknown> = {};
    if (input.title !== undefined) patch.title = input.title;
    if (input.description !== undefined) patch.description = input.description;
    if (input.state) patch.stateId = await this.resolveStateId(input.state);
    if (Object.keys(patch).length === 0) return;

    const data = await this.query<{ issueUpdate: { success: boolean } }>(
      'issueUpdate',
      `mutation Update($id: String!, $input: IssueUpdateInput!) {
         issueUpdate(id: $id, input: $input) { success }
       }`,
      { id: idOrKey, input: patch },
    );
    if (!data.issueUpdate.success) throw new LinearApiError('issueUpdate', ['success was false']);
  }

  async addComment(idOrKey: string, body: string): Promise<IssueComment> {
    const data = await this.query<{ commentCreate: { success: boolean; comment: { id: string; createdAt: string } } }>(
      'commentCreate',
      `mutation Comment($input: CommentCreateInput!) {
         commentCreate(input: $input) { success comment { id createdAt } }
       }`,
      { input: { issueId: idOrKey, body } },
    );
    if (!data.commentCreate.success) throw new LinearApiError('commentCreate', ['success was false']);
    return {
      id: data.commentCreate.comment.id,
      body,
      createdAt: new Date(data.commentCreate.comment.createdAt),
    };
  }

  async listComments(idOrKey: string): Promise<IssueComment[]> {
    const data = await this.query<{ issue: { comments: { nodes: { id: string; body: string; createdAt: string }[] } } | null }>(
      'comments',
      `query Comments($id: String!) { issue(id: $id) { comments { nodes { id body createdAt } } } }`,
      { id: idOrKey },
    );
    return (data.issue?.comments.nodes ?? []).map((c) => ({
      id: c.id,
      body: c.body,
      createdAt: new Date(c.createdAt),
    }));
  }
}
