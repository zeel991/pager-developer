import type {
  KnowledgeProvider,
  LogEntry,
  MonitorState,
  ObservabilityProvider,
  TimeRange,
} from '@pager/providers';
import type { AgentRunContext } from '@pager/observability';
import {
  assessNovelty,
  clusterErrors,
  type ErrorCluster,
  type KnownFailureMode,
  type NoveltyVerdict,
} from './log-analysis.js';

/**
 * Production watcher.
 *
 * Datadog watches production continuously; this is what notices a monitor has gone
 * to Alert, pulls the logs around it, and decides whether the failure is something
 * the team already prepared for.
 *
 * The escalation rule is narrow on purpose: an alerting monitor is not by itself a
 * reason to wake an agent up. Escalation requires an alerting monitor AND error logs
 * that do not match a documented failure mode. A monitor firing with no errors
 * beneath it is far more likely to be a monitor problem than a production one.
 */

export interface ProductionAlert {
  service: string;
  monitor: MonitorState;
  firedAt: Date;
  logWindow: TimeRange;
  logs: LogEntry[];
  clusters: ErrorCluster[];
  /** The failure to act on, if any. */
  primary: ErrorCluster | null;
  novelty: NoveltyVerdict | null;
  escalate: boolean;
  /** Why this was or was not escalated. Always populated. */
  rationale: string;
  /**
   * Ids of the tool calls that produced this alert.
   *
   * Evidence derived from an alert cites these, so a claim about the logs points at
   * the query that actually returned them rather than at a summary.
   */
  toolCallIds: { monitors: string; logs: string | null };
}

export interface WatchOptions {
  /** How far back from the monitor transition to read logs. */
  lookbackMinutes?: number;
  /** How far forward. Alerts usually fire a few minutes after onset. */
  lookaheadMinutes?: number;
  logLimit?: number;
  now?: () => Date;
}

const DEFAULT_LOOKBACK = 15;
const DEFAULT_LOOKAHEAD = 10;

/**
 * Pull known failure modes out of runbook text.
 *
 * Looks for the capitalised error-type names a runbook mentions, since those are
 * specific enough to match against a real error without suppressing unrelated ones.
 * Prose alone never registers a failure mode — a runbook saying "sometimes the
 * gateway is slow" must not silence a novel gateway crash.
 */
export function extractKnownFailureModes(
  documents: readonly { title: string; content: string }[],
): KnownFailureMode[] {
  const modes: KnownFailureMode[] = [];
  const seen = new Set<string>();

  for (const doc of documents) {
    for (const line of doc.content.split('\n')) {
      for (const match of line.matchAll(/\b([A-Z][A-Za-z0-9_]*(?:Error|Exception))\b/g)) {
        const marker = match[1]!;
        if (seen.has(marker)) continue;
        seen.add(marker);
        modes.push({ marker, description: line.trim().slice(0, 200), source: doc.title });
      }
    }
  }

  return modes;
}

export class ProductionWatcher {
  constructor(
    private readonly observability: ObservabilityProvider,
    private readonly knowledge: KnowledgeProvider | null = null,
  ) {}

  /** Documented failure modes for a service, from its runbooks. */
  async knownFailureModes(ctx: AgentRunContext, service: string): Promise<KnownFailureMode[]> {
    if (!this.knowledge) return [];
    try {
      const { value: hits } = await ctx.tool('notion.search', { query: service }, () =>
        this.knowledge!.search(`runbook ${service}`, 5),
      );

      const documents: { title: string; content: string }[] = [];
      for (const hit of hits) {
        const { value: doc } = await ctx.tool('notion.getDocument', { id: hit.id }, () =>
          this.knowledge!.getDocument(hit.id),
        );
        if (doc) documents.push({ title: doc.title, content: doc.content });
      }
      return extractKnownFailureModes(documents);
    } catch {
      // Runbooks are context, not a dependency. Losing them makes everything look
      // novel, which errs toward escalation — the safe direction.
      return [];
    }
  }

  /**
   * Check a service for an alerting monitor and, if one is firing, work out whether
   * it represents something new.
   */
  async check(
    ctx: AgentRunContext,
    service: string,
    opts: WatchOptions = {},
  ): Promise<ProductionAlert | null> {
    const now = opts.now ?? (() => new Date());

    const monitorsCall = await ctx.tool('datadog.listMonitors', { service }, () =>
      this.observability.listMonitors(service),
    );
    const monitors = monitorsCall.value;

    const alerting = monitors.find((m) => m.status === 'ALERT');
    if (!alerting) return null;

    const firedAt = alerting.transitionedAt ?? now();
    const logWindow: TimeRange = {
      from: new Date(firedAt.getTime() - (opts.lookbackMinutes ?? DEFAULT_LOOKBACK) * 60_000),
      to: new Date(firedAt.getTime() + (opts.lookaheadMinutes ?? DEFAULT_LOOKAHEAD) * 60_000),
    };

    const logsCall = await ctx.tool(
      'datadog.queryLogs',
      { service, level: 'error', from: logWindow.from, to: logWindow.to },
      () => this.observability.queryLogs(service, logWindow, { level: 'error', limit: opts.logLimit ?? 200 }),
    );
    const logs = logsCall.value;

    const clusters = clusterErrors(logs);

    if (clusters.length === 0) {
      // The most important non-escalation. A monitor in Alert with no errors under
      // it is a monitor that is wrong about production.
      return {
        service,
        monitor: alerting,
        firedAt,
        logWindow,
        logs,
        clusters,
        primary: null,
        novelty: null,
        escalate: false,
        toolCallIds: { monitors: monitorsCall.toolCallId, logs: logsCall.toolCallId },
        rationale:
          `Monitor "${alerting.name}" is alerting but produced no error logs in the ` +
          `surrounding ${Math.round((logWindow.to.getTime() - logWindow.from.getTime()) / 60_000)} minutes. ` +
          `This is more likely a monitor problem than a production one, and is not escalated.`,
      };
    }

    const primary = clusters[0]!;
    const known = await this.knownFailureModes(ctx, service);
    const novelty = assessNovelty(primary, known);

    return {
      service,
      monitor: alerting,
      firedAt,
      logWindow,
      logs,
      clusters,
      primary,
      novelty,
      escalate: novelty.novel,
      toolCallIds: { monitors: monitorsCall.toolCallId, logs: logsCall.toolCallId },
      rationale: novelty.novel
        ? `Monitor "${alerting.name}" is alerting and ${primary.count} error(s) match no documented ` +
          `failure mode. Escalating: ${primary.sample.slice(0, 120)}`
        : `Monitor "${alerting.name}" is alerting, but this failure is documented. ${novelty.reason} ` +
          `Handle via its runbook rather than investigating from scratch.`,
    };
  }
}

/** A short, factual description of where an alert says the failure is. */
export function describeAlert(alert: ProductionAlert): string {
  if (!alert.primary) return alert.rationale;

  const cluster = alert.primary;
  const location = cluster.topApplicationFrame
    ? `${cluster.topApplicationFrame.file}:${cluster.topApplicationFrame.line}`
    : cluster.entirelyInDependencies
      ? 'entirely inside dependencies'
      : 'no stack trace available';

  return (
    `${cluster.errorType ?? 'Error'} ×${cluster.count} on ` +
    `${cluster.affectedRoutes.join(', ') || 'unknown route'} — ${location}`
  );
}
