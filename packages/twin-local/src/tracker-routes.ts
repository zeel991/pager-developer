import { randomUUID } from 'node:crypto';
import type { Route } from './router.js';
import type { StoredIssue, StoredPage, TwinState } from './store.js';

/**
 * Jira, Linear and Notion surfaces.
 *
 * All three read and write the same underlying issue and page stores, but each
 * speaks its own protocol — Jira REST with ADF bodies and explicit transitions,
 * Linear GraphQL with an `errors` array, Notion blocks with pagination. Reproducing
 * the protocol differences is the point: an adapter that only ever meets an
 * idealised API is untested where it will actually break.
 */

// ── Jira ─────────────────────────────────────────────────────────────────────

/** Jira workflow used by this twin, with the status categories the adapter reads. */
const JIRA_STATUSES: Record<string, { category: string }> = {
  'To Do': { category: 'new' },
  'In Progress': { category: 'indeterminate' },
  Blocked: { category: 'indeterminate' },
  Resolved: { category: 'done' },
  Closed: { category: 'done' },
};

/** Transitions available from each status, mirroring a real constrained workflow. */
const JIRA_TRANSITIONS: Record<string, string[]> = {
  'To Do': ['In Progress', 'Closed'],
  'In Progress': ['Blocked', 'Resolved', 'Closed'],
  Blocked: ['In Progress', 'Closed'],
  Resolved: ['Closed', 'Reopen'],
  Closed: ['Reopen'],
};

function adfToText(node: unknown): string {
  if (typeof node === 'string') return node;
  if (!node || typeof node !== 'object') return '';
  const n = node as { type?: string; text?: string; content?: unknown[] };
  if (n.type === 'text') return n.text ?? '';
  const inner = (n.content ?? []).map(adfToText);
  return n.type === 'paragraph' || n.type === 'heading' ? inner.join('') : inner.join('\n\n');
}

function textToAdf(text: string): unknown {
  return {
    type: 'doc',
    version: 1,
    content: text.split(/\n{2,}/).map((p) => ({
      type: 'paragraph',
      content: [{ type: 'text', text: p }],
    })),
  };
}

function jiraIssueJson(issue: StoredIssue) {
  return {
    id: issue.id,
    key: issue.key,
    fields: {
      summary: issue.title,
      description: textToAdf(issue.description),
      labels: issue.labels,
      created: issue.createdAt,
      updated: issue.updatedAt,
      status: {
        name: issue.status,
        statusCategory: { key: JIRA_STATUSES[issue.status]?.category ?? 'new' },
      },
    },
  };
}

function findIssue(state: TwinState, idOrKey: string): StoredIssue | undefined {
  return state.issues.find((i) => i.id === idOrKey || i.key === idOrKey);
}

export function jiraRoutes(): Route[] {
  return [
    {
      method: 'POST',
      pattern: /^\/rest\/api\/3\/issue$/,
      handler: (ctx) => {
        const body = ctx.json as { fields?: Record<string, unknown> };
        const fields = body.fields ?? {};
        const summary = fields.summary as string | undefined;
        if (!summary) {
          return { status: 400, body: { errorMessages: ['summary is required'] } };
        }
        const n = ctx.state.issues.length + 1;
        const projectKey = ((fields.project as { key?: string })?.key ?? 'INC');
        const issue: StoredIssue = {
          id: String(10000 + n),
          key: `${projectKey}-${n}`,
          title: summary,
          description: adfToText(fields.description),
          status: 'To Do',
          labels: (fields.labels as string[]) ?? [],
          priority: ((fields.priority as { name?: string })?.name) ?? null,
          createdAt: new Date(ctx.now()).toISOString(),
          updatedAt: null,
          comments: [],
        };
        ctx.state.issues.push(issue);
        return { status: 201, body: { id: issue.id, key: issue.key, self: `/rest/api/3/issue/${issue.id}` } };
      },
    },
    {
      method: 'GET',
      pattern: /^\/rest\/api\/3\/issue\/([^/]+)$/,
      handler: (ctx) => {
        const issue = findIssue(ctx.state, ctx.params[0]!);
        if (!issue) return { status: 404, body: { errorMessages: ['Issue does not exist'] } };
        return { status: 200, body: jiraIssueJson(issue) };
      },
    },
    {
      method: 'PUT',
      pattern: /^\/rest\/api\/3\/issue\/([^/]+)$/,
      handler: (ctx) => {
        const issue = findIssue(ctx.state, ctx.params[0]!);
        if (!issue) return { status: 404, body: { errorMessages: ['Issue does not exist'] } };
        const fields = (ctx.json as { fields?: Record<string, unknown> }).fields ?? {};
        if (fields.summary !== undefined) issue.title = String(fields.summary);
        if (fields.description !== undefined) issue.description = adfToText(fields.description);
        issue.updatedAt = new Date(ctx.now()).toISOString();
        // Jira answers 204 with no body for a successful field update.
        return { status: 204, body: '' };
      },
    },
    {
      method: 'GET',
      pattern: /^\/rest\/api\/3\/issue\/([^/]+)\/transitions$/,
      handler: (ctx) => {
        const issue = findIssue(ctx.state, ctx.params[0]!);
        if (!issue) return { status: 404, body: { errorMessages: ['Issue does not exist'] } };
        const available = JIRA_TRANSITIONS[issue.status] ?? [];
        return {
          status: 200,
          body: {
            transitions: available.map((name, i) => ({
              id: String(i + 11),
              name,
              to: {
                name: name === 'Reopen' ? 'To Do' : name,
                statusCategory: { key: JIRA_STATUSES[name === 'Reopen' ? 'To Do' : name]?.category ?? 'new' },
              },
            })),
          },
        };
      },
    },
    {
      method: 'POST',
      pattern: /^\/rest\/api\/3\/issue\/([^/]+)\/transitions$/,
      handler: (ctx) => {
        const issue = findIssue(ctx.state, ctx.params[0]!);
        if (!issue) return { status: 404, body: { errorMessages: ['Issue does not exist'] } };
        const transitionId = (ctx.json as { transition?: { id?: string } }).transition?.id;
        const available = JIRA_TRANSITIONS[issue.status] ?? [];
        const name = available[Number(transitionId) - 11];
        if (!name) {
          return { status: 400, body: { errorMessages: ['Transition is not valid for this issue'] } };
        }
        issue.status = name === 'Reopen' ? 'To Do' : name;
        issue.updatedAt = new Date(ctx.now()).toISOString();
        return { status: 204, body: '' };
      },
    },
    {
      method: 'POST',
      pattern: /^\/rest\/api\/3\/issue\/([^/]+)\/comment$/,
      handler: (ctx) => {
        const issue = findIssue(ctx.state, ctx.params[0]!);
        if (!issue) return { status: 404, body: { errorMessages: ['Issue does not exist'] } };
        const comment = {
          id: String(issue.comments.length + 1),
          body: adfToText((ctx.json as { body?: unknown }).body),
          createdAt: new Date(ctx.now()).toISOString(),
        };
        issue.comments.push(comment);
        return { status: 201, body: { id: comment.id, created: comment.createdAt, body: textToAdf(comment.body) } };
      },
    },
    {
      method: 'GET',
      pattern: /^\/rest\/api\/3\/issue\/([^/]+)\/comment$/,
      handler: (ctx) => {
        const issue = findIssue(ctx.state, ctx.params[0]!);
        if (!issue) return { status: 404, body: { errorMessages: ['Issue does not exist'] } };
        return {
          status: 200,
          body: {
            comments: issue.comments.map((c) => ({
              id: c.id,
              body: textToAdf(c.body),
              created: c.createdAt,
            })),
          },
        };
      },
    },
  ];
}

// ── Linear ───────────────────────────────────────────────────────────────────

const LINEAR_STATES = [
  { id: 'st_backlog', name: 'Backlog', type: 'backlog' },
  { id: 'st_todo', name: 'Todo', type: 'unstarted' },
  { id: 'st_progress', name: 'In Progress', type: 'started' },
  { id: 'st_blocked', name: 'Blocked', type: 'started' },
  { id: 'st_done', name: 'Done', type: 'completed' },
  { id: 'st_canceled', name: 'Canceled', type: 'canceled' },
];

function linearIssueJson(issue: StoredIssue) {
  const state = LINEAR_STATES.find((s) => s.id === issue.status) ?? LINEAR_STATES[1]!;
  return {
    id: issue.id,
    identifier: issue.key,
    title: issue.title,
    description: issue.description,
    url: `https://linear.app/acme/issue/${issue.key}`,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    labels: { nodes: issue.labels.map((name) => ({ name })) },
    state: { name: state.name, type: state.type },
  };
}

/**
 * A deliberately small GraphQL dispatcher.
 *
 * It matches on operation name rather than parsing GraphQL, which is enough to
 * exercise the adapter's request shaping, error handling and state resolution — the
 * parts that actually break.
 */
export function linearRoutes(): Route[] {
  return [
    {
      method: 'POST',
      pattern: /^\/graphql$/,
      handler: (ctx) => {
        const body = ctx.json as { query?: string; variables?: Record<string, unknown> };
        const query = body.query ?? '';
        const vars = body.variables ?? {};
        const now = new Date(ctx.now()).toISOString();

        const fail = (message: string) => ({ status: 200, body: { errors: [{ message }] } });

        if (query.includes('states {')) {
          return { status: 200, body: { data: { team: { states: { nodes: LINEAR_STATES } } } } };
        }

        if (query.includes('issueCreate')) {
          const input = (vars.input ?? {}) as { title?: string; description?: string };
          if (!input.title) return fail('Argument Validation Error: title is required');
          const n = ctx.state.issues.length + 1;
          const issue: StoredIssue = {
            id: randomUUID(),
            key: `ENG-${n}`,
            title: input.title,
            description: input.description ?? '',
            status: 'st_todo',
            labels: [],
            priority: null,
            createdAt: now,
            updatedAt: null,
            comments: [],
          };
          ctx.state.issues.push(issue);
          return {
            status: 200,
            body: { data: { issueCreate: { success: true, issue: linearIssueJson(issue) } } },
          };
        }

        if (query.includes('issueUpdate')) {
          const issue = findIssue(ctx.state, String(vars.id ?? ''));
          if (!issue) return fail('Entity not found: Issue');
          const input = (vars.input ?? {}) as { title?: string; description?: string; stateId?: string };
          if (input.title !== undefined) issue.title = input.title;
          if (input.description !== undefined) issue.description = input.description;
          if (input.stateId !== undefined) {
            if (!LINEAR_STATES.some((s) => s.id === input.stateId)) {
              return fail(`Entity not found: WorkflowState ${input.stateId}`);
            }
            issue.status = input.stateId;
          }
          issue.updatedAt = now;
          return { status: 200, body: { data: { issueUpdate: { success: true } } } };
        }

        if (query.includes('commentCreate')) {
          const input = (vars.input ?? {}) as { issueId?: string; body?: string };
          const issue = findIssue(ctx.state, String(input.issueId ?? ''));
          if (!issue) return fail('Entity not found: Issue');
          const comment = { id: randomUUID(), body: input.body ?? '', createdAt: now };
          issue.comments.push(comment);
          return {
            status: 200,
            body: { data: { commentCreate: { success: true, comment: { id: comment.id, createdAt: comment.createdAt } } } },
          };
        }

        if (query.includes('comments {')) {
          const issue = findIssue(ctx.state, String(vars.id ?? ''));
          if (!issue) return { status: 200, body: { data: { issue: null } } };
          return { status: 200, body: { data: { issue: { comments: { nodes: issue.comments } } } } };
        }

        if (query.includes('issue(')) {
          const issue = findIssue(ctx.state, String(vars.id ?? ''));
          return { status: 200, body: { data: { issue: issue ? linearIssueJson(issue) : null } } };
        }

        return fail(`Unknown operation: ${query.slice(0, 60)}`);
      },
    },
  ];
}

// ── Notion ───────────────────────────────────────────────────────────────────

function notionPageJson(page: StoredPage) {
  return {
    object: 'page',
    id: page.id,
    url: `https://notion.so/${page.id.replace(/-/g, '')}`,
    properties: {
      // A database page names its title property arbitrarily; the adapter must
      // find it by type, so this twin deliberately does not call it "title".
      Name: { type: 'title', title: [{ type: 'text', plain_text: page.title, text: { content: page.title } }] },
    },
    parent: page.parentId ? { type: 'page_id', page_id: page.parentId } : { type: 'workspace' },
  };
}

/** Render stored plain text back into Notion blocks. */
function pageBlocks(page: StoredPage): NotionBlockJson[] {
  return page.content
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line, i) => {
      const heading = /^(#{1,3})\s+(.*)$/.exec(line);
      if (heading) {
        const level = heading[1]!.length;
        return {
          object: 'block',
          id: `${page.id}-b${i}`,
          type: `heading_${level}`,
          [`heading_${level}`]: { rich_text: [{ type: 'text', plain_text: heading[2]! }] },
        };
      }
      const bullet = /^-\s+(.*)$/.exec(line);
      if (bullet) {
        return {
          object: 'block',
          id: `${page.id}-b${i}`,
          type: 'bulleted_list_item',
          bulleted_list_item: { rich_text: [{ type: 'text', plain_text: bullet[1]! }] },
        };
      }
      return {
        object: 'block',
        id: `${page.id}-b${i}`,
        type: 'paragraph',
        paragraph: { rich_text: [{ type: 'text', plain_text: line }] },
      };
    });
}

interface NotionBlockJson {
  object: string;
  id: string;
  type: string;
  [key: string]: unknown;
}

function blocksToText(children: unknown): string {
  if (!Array.isArray(children)) return '';
  return children
    .map((child) => {
      const b = child as Record<string, unknown>;
      const type = String(b.type ?? 'paragraph');
      const body = b[type] as { rich_text?: { plain_text?: string; text?: { content?: string } }[] } | undefined;
      const text = (body?.rich_text ?? [])
        .map((r) => r.plain_text ?? r.text?.content ?? '')
        .join('');
      const level = /^heading_(\d)$/.exec(type);
      return level ? `${'#'.repeat(Number(level[1]))} ${text}` : text;
    })
    .join('\n\n');
}

/** Notion pages children with a small page size, so pagination is actually exercised. */
const NOTION_PAGE_SIZE = 2;

export function notionRoutes(): Route[] {
  return [
    {
      method: 'POST',
      pattern: /^\/v1\/search$/,
      handler: (ctx) => {
        if (!ctx.headers['notion-version']) {
          return { status: 400, body: { object: 'error', code: 'missing_version', message: 'Notion-Version header is required' } };
        }
        const body = ctx.json as { query?: string; page_size?: number };
        const q = (body.query ?? '').toLowerCase();
        const hits = ctx.state.pages.filter(
          (p) => !q || p.title.toLowerCase().includes(q) || p.content.toLowerCase().includes(q),
        );
        return {
          status: 200,
          body: { object: 'list', results: hits.slice(0, body.page_size ?? 10).map(notionPageJson) },
        };
      },
    },
    {
      method: 'GET',
      pattern: /^\/v1\/pages\/([^/]+)$/,
      handler: (ctx) => {
        if (!ctx.headers['notion-version']) {
          return { status: 400, body: { object: 'error', code: 'missing_version' } };
        }
        const page = ctx.state.pages.find((p) => p.id === ctx.params[0]);
        if (!page) return { status: 404, body: { object: 'error', code: 'object_not_found' } };
        return { status: 200, body: notionPageJson(page) };
      },
    },
    {
      method: 'GET',
      pattern: /^\/v1\/blocks\/([^/]+)\/children$/,
      handler: (ctx) => {
        const page = ctx.state.pages.find((p) => p.id === ctx.params[0]);
        if (!page) return { status: 404, body: { object: 'error', code: 'object_not_found' } };
        const all = pageBlocks(page);
        const start = Number(ctx.query.start_cursor ?? 0);
        const slice = all.slice(start, start + NOTION_PAGE_SIZE);
        const next = start + NOTION_PAGE_SIZE;
        return {
          status: 200,
          body: {
            object: 'list',
            results: slice,
            has_more: next < all.length,
            next_cursor: next < all.length ? String(next) : null,
          },
        };
      },
    },
    {
      method: 'POST',
      pattern: /^\/v1\/pages$/,
      handler: (ctx) => {
        if (!ctx.headers['notion-version']) {
          return { status: 400, body: { object: 'error', code: 'missing_version' } };
        }
        const body = ctx.json as {
          parent?: { page_id?: string; database_id?: string };
          properties?: Record<string, { title?: { text?: { content?: string } }[] }>;
          children?: unknown;
        };
        const parentId = body.parent?.page_id ?? body.parent?.database_id ?? null;
        if (!parentId) {
          return { status: 400, body: { object: 'error', code: 'validation_error', message: 'parent is required' } };
        }
        const titleProp = Object.values(body.properties ?? {}).find((p) => p.title);
        const title = titleProp?.title?.[0]?.text?.content ?? 'Untitled';

        const page: StoredPage = {
          id: randomUUID(),
          title,
          content: blocksToText(body.children),
          parentId,
        };
        ctx.state.pages.push(page);
        return { status: 200, body: notionPageJson(page) };
      },
    },
  ];
}
