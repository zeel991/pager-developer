import type {
  MetricName,
  MetricSeries,
  ObservabilityProvider,
  TimeRange,
} from '@pager/providers';
import type { AgentRunContext } from '@pager/observability';

/**
 * Collects the baseline and observation windows a regression comparison needs.
 *
 * Every series is fetched through an instrumented tool call, so each one carries an
 * evidence-citable id. This is what lets a later claim about the error rate point at
 * the specific query that produced the numbers, rather than at a summary.
 *
 * A metric that cannot be fetched is recorded as a failure and excluded, never
 * substituted with an empty series — an empty series would compare as "no change"
 * and quietly exonerate a deployment.
 */

export const DEFAULT_MONITORED_METRICS: MetricName[] = [
  'error_rate',
  'http_5xx_rate',
  'latency_p50',
  'latency_p95',
  'request_throughput',
  'availability',
];

export interface WindowPair {
  baseline: MetricSeries;
  observed: MetricSeries;
  baselineToolCallId: string;
  observedToolCallId: string;
}

export interface TelemetryCollection {
  windows: WindowPair[];
  /** Metrics that could not be collected, with the reason. */
  failures: { metric: MetricName; reason: string }[];
}

export async function collectWindows(
  ctx: AgentRunContext,
  observability: ObservabilityProvider,
  service: string,
  baseline: TimeRange,
  observation: TimeRange,
  metrics: MetricName[] = DEFAULT_MONITORED_METRICS,
): Promise<TelemetryCollection> {
  const windows: WindowPair[] = [];
  const failures: { metric: MetricName; reason: string }[] = [];

  for (const metric of metrics) {
    try {
      const before = await ctx.tool(
        'datadog.queryMetric',
        { service, metric, window: 'baseline', from: baseline.from, to: baseline.to },
        () => observability.queryMetric(service, metric, baseline),
      );
      const after = await ctx.tool(
        'datadog.queryMetric',
        { service, metric, window: 'observation', from: observation.from, to: observation.to },
        () => observability.queryMetric(service, metric, observation),
      );
      windows.push({
        baseline: before.value,
        observed: after.value,
        baselineToolCallId: before.toolCallId,
        observedToolCallId: after.toolCallId,
      });
    } catch (err) {
      failures.push({ metric, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  return { windows, failures };
}
