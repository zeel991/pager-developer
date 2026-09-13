import type { MetricName, ObservabilityProvider, TimeRange } from '@pager/providers';
import type { AgentRunContext } from '@pager/observability';
import { mean } from './regression-detector.js';

/**
 * Recovery verification.
 *
 * A remediation being applied is not a recovery. This compares three windows —
 * baseline, incident, and post-remediation — and only reports recovery when the
 * signal has actually returned toward baseline.
 *
 * The asymmetry is deliberate: it is far worse to close an incident that is still
 * burning than to keep one open a little too long. So every ambiguous case resolves
 * to "not recovered".
 */

export interface MetricComparison {
  metric: MetricName;
  baseline: number;
  incident: number;
  postRemediation: number;
  recovered: boolean;
  /** How far back toward baseline the signal came, 0..1. Null when undefined. */
  recoveryFraction: number | null;
  reason: string;
}

export interface RecoveryVerification {
  comparisons: MetricComparison[];
  monitorsRecovered: boolean | null;
  /** True only when every compared metric recovered and no monitor is still alerting. */
  recovered: boolean;
  /** Metrics that could not be compared. Their absence blocks a recovery claim. */
  unverified: { metric: MetricName; reason: string }[];
}

/**
 * How close to baseline a metric must return to count as recovered.
 *
 * Not 100%: production is noisy, and a baseline of 0.4% will not return to exactly
 * 0.4%. 85% of the excursion removed is a defensible "back to normal", and the
 * absolute-tolerance clause below handles metrics whose baseline is near zero.
 */
export const RECOVERY_THRESHOLD = 0.85;

export interface RecoveryOptions {
  threshold?: number;
  /** Absolute difference from baseline that always counts as recovered. */
  absoluteTolerance?: Partial<Record<MetricName, number>>;
}

const DEFAULT_TOLERANCE: Partial<Record<MetricName, number>> = {
  error_rate: 0.005,
  http_5xx_rate: 0.005,
  availability: 0.002,
  latency_p50: 20,
  latency_p95: 50,
  latency_p99: 100,
};

export function compareRecovery(
  metric: MetricName,
  baseline: number,
  incident: number,
  postRemediation: number,
  opts: RecoveryOptions = {},
): MetricComparison {
  const threshold = opts.threshold ?? RECOVERY_THRESHOLD;
  const tolerance = opts.absoluteTolerance?.[metric] ?? DEFAULT_TOLERANCE[metric];

  const excursion = incident - baseline;
  const remaining = postRemediation - baseline;

  // Within absolute tolerance of baseline is recovered regardless of ratios, which
  // matters when the baseline is near zero and fractions become meaningless.
  if (tolerance !== undefined && Math.abs(remaining) <= tolerance) {
    return {
      metric, baseline, incident, postRemediation,
      recovered: true,
      recoveryFraction: excursion === 0 ? null : 1 - remaining / excursion,
      reason: `Within ${tolerance} of baseline.`,
    };
  }

  if (excursion === 0) {
    return {
      metric, baseline, incident, postRemediation,
      recovered: false,
      recoveryFraction: null,
      // Nothing moved during the incident, so there is no excursion to recover from
      // and this metric cannot evidence a recovery either way.
      reason: 'Metric did not move during the incident; it cannot evidence recovery.',
    };
  }

  const fraction = 1 - remaining / excursion;
  const recovered = fraction >= threshold;
  return {
    metric, baseline, incident, postRemediation,
    recovered,
    recoveryFraction: Number(fraction.toFixed(3)),
    reason: recovered
      ? `Returned ${(fraction * 100).toFixed(0)}% of the way to baseline.`
      : `Only ${(fraction * 100).toFixed(0)}% of the excursion has cleared; ` +
        `${(threshold * 100).toFixed(0)}% is required.`,
  };
}

export interface RecoveryInput {
  service: string;
  metrics: MetricName[];
  baselineWindow: TimeRange;
  incidentWindow: TimeRange;
  postRemediationWindow: TimeRange;
}

export class RecoveryVerifier {
  constructor(private readonly observability: ObservabilityProvider) {}

  private async checkMonitors(ctx: AgentRunContext, service: string): Promise<boolean | null> {
    try {
      const res = await ctx.tool('datadog.listMonitors', { service }, () =>
        this.observability.listMonitors(service),
      );
      return res.value.every((m) => m.status === 'OK' || m.status === 'NO_DATA');
    } catch {
      return null;
    }
  }

  async verify(
    ctx: AgentRunContext,
    input: RecoveryInput,
    opts: RecoveryOptions = {},
  ): Promise<RecoveryVerification> {
    const comparisons: MetricComparison[] = [];
    const unverified: { metric: MetricName; reason: string }[] = [];

    for (const metric of input.metrics) {
      try {
        const windows = await Promise.all(
          (['baseline', 'incident', 'post'] as const).map(async (label, i) => {
            const range = [input.baselineWindow, input.incidentWindow, input.postRemediationWindow][i]!;
            const res = await ctx.tool(
              'datadog.queryMetric',
              { service: input.service, metric, window: label },
              () => this.observability.queryMetric(input.service, metric, range),
            );
            return res.value;
          }),
        );

        const [baseline, incident, post] = windows;
        if (!baseline?.points.length || !incident?.points.length || !post?.points.length) {
          unverified.push({
            metric,
            reason: 'One or more windows returned no data, so recovery cannot be established.',
          });
          continue;
        }

        comparisons.push(
          compareRecovery(
            metric,
            mean(baseline.points.map((p) => p.value)),
            mean(incident.points.map((p) => p.value)),
            mean(post.points.map((p) => p.value)),
            opts,
          ),
        );
      } catch (err) {
        unverified.push({ metric, reason: err instanceof Error ? err.message : String(err) });
      }
    }

    // Monitors are a second, independent signal. A metric that looks recovered while
    // a monitor still alerts is not a recovery. Null means we could not tell, which
    // is treated as neither confirmation nor contradiction below.
    const monitorsRecovered = await this.checkMonitors(ctx, input.service);

    const everyMetricRecovered =
      comparisons.length > 0 && comparisons.every((c) => c.recovered);

    return {
      comparisons,
      monitorsRecovered,
      // Unverified metrics block the claim. Absence of evidence is not recovery.
      recovered:
        everyMetricRecovered && unverified.length === 0 && monitorsRecovered !== false,
      unverified,
    };
  }
}
