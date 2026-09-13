import { z } from 'zod';
import { assertToolAllowed, type AutonomyLevel, type ToolDefinition } from '@pager/core';
import type { AgentRunContext } from '@pager/observability';
import type {
  KnowledgeProvider,
  MetricName,
  ObservabilityProvider,
  SourceControlProvider,
  TimeRange,
} from '@pager/providers';
import type { ModelToolSpec } from '../model/anthropic-model.js';

/**
 * The read-only surface an investigation may reach.
 *
 * Three properties are enforced here rather than requested in a prompt:
 *
 *  1. Every tool is READ_ONLY and declared as such. The investigator is offered
 *     nothing that can write to any external system, so a model that decides it
 *     would like to open a pull request simply has no way to.
 *  2. Every call runs through `ctx.tool`, so the tracer mints the id, records the
 *     call, and records failures. The id handed back to the model is the only thing
 *     it may cite as evidence.
 *  3. The revision is fixed by the caller. The model chooses *which* file to read,
 *     never *which revision* — otherwise it could quietly read the fixed code on a
 *     later commit and "discover" the bug it was told to find.
 */

export interface InvestigationTarget {
  service: string;
  repository: string;
  /** The revision production is running. Established from deployment evidence. */
  deployedRevision: string;
  /** The revision it replaced, when known. Null disables the diff tool. */
  previousRevision: string | null;
  baselineWindow: TimeRange;
  observationWindow: TimeRange;
}

export interface InvestigationProviders {
  observability: ObservabilityProvider;
  sourceControl: SourceControlProvider;
  knowledge: KnowledgeProvider | null;
}

const READ_ONLY = {
  risk: 'READ_ONLY',
  minAutonomy: 'L1',
  requiresApproval: false,
  audit: false,
  timeoutMs: 30_000,
  maxRetries: 1,
} as const;

/** Tool declarations, with their JSON Schema and their policy metadata together. */
interface InvestigationTool {
  definition: ToolDefinition;
  spec: ModelToolSpec;
  run(
    ctx: AgentRunContext,
    args: Record<string, unknown>,
    target: InvestigationTarget,
    providers: InvestigationProviders,
  ): Promise<unknown>;
}

const METRIC_NAMES: MetricName[] = [
  'error_rate',
  'http_5xx_rate',
  'request_throughput',
  'latency_p50',
  'latency_p95',
  'latency_p99',
  'availability',
  'cpu_utilization',
  'memory_utilization',
];

function def(name: string, description: string): ToolDefinition {
  return {
    name,
    description,
    inputSchema: z.unknown(),
    outputSchema: z.unknown(),
    ...READ_ONLY,
  };
}

const TOOLS: InvestigationTool[] = [
  {
    definition: def('datadog.queryLogs', 'Read production logs for the service in a window.'),
    spec: {
      name: 'read_logs',
      description:
        'Read production logs for the affected service. Returns log entries with stack traces. ' +
        'Use window "observation" for the period the incident covers, "baseline" for before it.',
      inputSchema: {
        type: 'object',
        properties: {
          window: { type: 'string', enum: ['baseline', 'observation'] },
          level: { type: 'string', enum: ['debug', 'info', 'warn', 'error', 'fatal'] },
          limit: { type: 'integer', minimum: 1, maximum: 50 },
        },
        required: ['window'],
        additionalProperties: false,
      },
    },
    async run(ctx, args, target, providers) {
      const range = args.window === 'baseline' ? target.baselineWindow : target.observationWindow;
      const { value } = await ctx.tool(
        'datadog.queryLogs',
        { service: target.service, window: args.window, level: args.level },
        () =>
          providers.observability.queryLogs(target.service, range, {
            ...(typeof args.level === 'string'
              ? { level: args.level as 'error' }
              : {}),
            limit: typeof args.limit === 'number' ? Math.min(args.limit, 50) : 25,
          }),
      );
      return value.map((entry) => ({
        at: entry.at.toISOString(),
        level: entry.level,
        message: entry.message,
        stackTrace: entry.stackTrace,
        attributes: entry.attributes,
      }));
    },
  },
  {
    definition: def('datadog.queryMetric', 'Read a metric series for the service in a window.'),
    spec: {
      name: 'read_metric',
      description:
        'Read a production metric series for the affected service in the baseline or ' +
        'observation window. Returns individual points plus their mean.',
      inputSchema: {
        type: 'object',
        properties: {
          metric: { type: 'string', enum: METRIC_NAMES },
          window: { type: 'string', enum: ['baseline', 'observation'] },
        },
        required: ['metric', 'window'],
        additionalProperties: false,
      },
    },
    async run(ctx, args, target, providers) {
      const range = args.window === 'baseline' ? target.baselineWindow : target.observationWindow;
      const { value } = await ctx.tool(
        'datadog.queryMetric',
        { service: target.service, metric: args.metric, window: args.window },
        () => providers.observability.queryMetric(target.service, args.metric as MetricName, range),
      );
      const values = value.points.map((p) => p.value);
      return {
        metric: value.metric,
        unit: value.unit,
        sampleCount: values.length,
        mean: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null,
        min: values.length ? Math.min(...values) : null,
        max: values.length ? Math.max(...values) : null,
      };
    },
  },
  {
    definition: def('github.listFiles', 'List file paths at the deployed revision.'),
    spec: {
      name: 'list_repository_files',
      description:
        'List every file path present in the repository at the revision production is ' +
        'currently running. Use this before reading a file if you are unsure of its path.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    async run(ctx, _args, target, providers) {
      const { value } = await ctx.tool(
        'github.listFiles',
        { repo: target.repository, ref: target.deployedRevision },
        () => providers.sourceControl.listFiles(target.repository, target.deployedRevision),
      );
      return { revision: target.deployedRevision, paths: value };
    },
  },
  {
    definition: def('github.getFile', 'Read one file at the deployed revision.'),
    spec: {
      name: 'read_repository_file',
      description:
        'Read one file from the repository AT THE DEPLOYED REVISION — the exact code ' +
        'running in production. Returns null if the path does not exist at that revision.',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
        additionalProperties: false,
      },
    },
    async run(ctx, args, target, providers) {
      const { value } = await ctx.tool(
        'github.getFile',
        { repo: target.repository, ref: target.deployedRevision, path: args.path },
        () =>
          providers.sourceControl.getFile(
            target.repository,
            target.deployedRevision,
            String(args.path),
          ),
      );
      return value === null
        ? { path: args.path, revision: target.deployedRevision, content: null, note: 'No such file at this revision.' }
        : { path: args.path, revision: target.deployedRevision, content: value };
    },
  },
  {
    definition: def('github.getDiff', 'Diff the deployed revision against its predecessor.'),
    spec: {
      name: 'read_deployment_diff',
      description:
        'Read what the deployment actually changed: the diff between the previously ' +
        'deployed revision and the currently deployed one. An empty file list means the ' +
        'diff could not be computed, NOT that nothing changed.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    async run(ctx, _args, target, providers) {
      if (!target.previousRevision) {
        return {
          available: false,
          note:
            'The previously deployed revision is unknown, so no diff can be computed. ' +
            'This is missing information, not evidence that nothing changed.',
        };
      }
      const { value } = await ctx.tool(
        'github.getDiff',
        { repo: target.repository, base: target.previousRevision, head: target.deployedRevision },
        () =>
          providers.sourceControl.getDiff(
            target.repository,
            target.previousRevision!,
            target.deployedRevision,
          ),
      );
      return {
        available: true,
        baseSha: value.baseSha,
        headSha: value.headSha,
        files: value.files,
        patch: value.patch,
        note:
          value.files.length === 0
            ? 'The provider returned no changed files. Treat this as an unknown diff, not an empty one.'
            : undefined,
      };
    },
  },
  {
    definition: def('github.listCommitsBetween', 'Commits included in the deployment.'),
    spec: {
      name: 'read_deployment_commits',
      description: 'List the commits included in the currently deployed revision since the previous one.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    async run(ctx, _args, target, providers) {
      if (!target.previousRevision) return { available: false, note: 'Previous revision unknown.' };
      const { value } = await ctx.tool(
        'github.listCommitsBetween',
        { repo: target.repository, base: target.previousRevision, head: target.deployedRevision },
        () =>
          providers.sourceControl.listCommitsBetween(
            target.repository,
            target.previousRevision!,
            target.deployedRevision,
          ),
      );
      return {
        available: true,
        commits: value.map((c) => ({
          sha: c.sha,
          message: c.message,
          author: c.authorName,
          at: c.committedAt instanceof Date ? c.committedAt.toISOString() : c.committedAt,
        })),
      };
    },
  },
  {
    definition: def('notion.search', 'Search team runbooks and architecture notes.'),
    spec: {
      name: 'search_runbooks',
      description:
        'Search the team knowledge base (runbooks, architecture notes, prior postmortems) ' +
        'for documents relevant to a query. Returns titles, ids and excerpts.',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 10 } },
        required: ['query'],
        additionalProperties: false,
      },
    },
    async run(ctx, args, _target, providers) {
      if (!providers.knowledge) {
        return { available: false, note: 'No knowledge provider is configured for this incident.' };
      }
      const { value } = await ctx.tool('notion.search', { query: args.query }, () =>
        providers.knowledge!.search(String(args.query), typeof args.limit === 'number' ? args.limit : 5),
      );
      return { available: true, results: value };
    },
  },
  {
    definition: def('notion.getDocument', 'Read one runbook or note in full.'),
    spec: {
      name: 'read_runbook',
      description:
        'Read one knowledge-base document in full by its id, as returned by search_runbooks. ' +
        'Use this to check documented failure modes, rollback procedures and constraints.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
        additionalProperties: false,
      },
    },
    async run(ctx, args, _target, providers) {
      if (!providers.knowledge) {
        return { available: false, note: 'No knowledge provider is configured for this incident.' };
      }
      const { value } = await ctx.tool('notion.getDocument', { id: args.id }, () =>
        providers.knowledge!.getDocument(String(args.id)),
      );
      return value === null ? { available: true, document: null } : { available: true, document: value };
    },
  },
];

/** Tools offered at an autonomy level, with the policy check applied to each. */
export function investigationTools(
  autonomy: AutonomyLevel,
  providers: InvestigationProviders,
): InvestigationTool[] {
  return TOOLS.filter((tool) => {
    // A tool whose backing provider is absent is not offered at all, rather than
    // offered and failing: a model that is told a tool exists will keep trying it.
    if (!providers.knowledge && tool.definition.name.startsWith('notion.')) return false;
    try {
      assertToolAllowed(tool.definition, { autonomy });
      return true;
    } catch {
      return false;
    }
  });
}

export type { InvestigationTool };
