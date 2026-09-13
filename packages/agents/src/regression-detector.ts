import type { MetricName, MetricSeries } from '@pager/providers';

/**
 * RegressionDetector — Phase 2.
 *
 * Decides whether production behaviour materially changed after a deployment.
 *
 * It deliberately does NOT decide whether the deployment caused the change. The
 * output type has no field for that, so the question cannot be answered here even by
 * accident: encoding "deploy happened + production broke = deploy broke production"
 * is the single most damaging thing this system could learn to do. Attribution is
 * Phase 3's job, and it works from evidence.
 */

export type Severity = 'SEV1' | 'SEV2' | 'SEV3' | 'SEV4';

export interface Regression {
  metric: MetricName;
  service: string;
  baseline: number;
  observed: number;
  absoluteChange: number;
  /** Null when the baseline is zero: a ratio against zero is not a number we can report. */
  percentageChange: number | null;
  severity: Severity;
  confidence: number;
  direction: 'increase' | 'decrease';
  rationale: string;
  baselineSampleCount: number;
  observedSampleCount: number;
}

export interface DetectionResult {
  regressions: Regression[];
  /** Metrics examined but judged unchanged, with the reason. Kept for auditability. */
  dismissed: { metric: MetricName; reason: string }[];
  /** Metrics that could not be judged at all — absence of data is not absence of a problem. */
  inconclusive: { metric: MetricName; reason: string }[];
}

/**
 * Per-metric detection thresholds.
 *
 * `worseWhen` encodes direction: a rise in error rate is bad, a rise in availability
 * is good. Without this a recovery would be reported as a regression.
 *
 * Both `minAbsolute` and `minRelative` must be exceeded. Requiring only relative
 * change makes 0.001% -> 0.002% a "100% regression"; requiring only absolute change
 * misses a meaningful move on a small base. Requiring both is what separates
 * 0.4% -> 0.45% (noise) from 0.4% -> 17.8% (an incident).
 */
export interface MetricThreshold {
  worseWhen: 'increase' | 'decrease';
  minAbsolute: number;
  minRelative: number;
  /** Absolute change at or above which this is SEV1 on its own. */
  criticalAbsolute: number;
}

export const DEFAULT_THRESHOLDS: Record<MetricName, MetricThreshold> = {
  // Rates are ratios: 0.004 is 0.4%.
  error_rate: { worseWhen: 'increase', minAbsolute: 0.01, minRelative: 0.5, criticalAbsolute: 0.1 },
  http_5xx_rate: { worseWhen: 'increase', minAbsolute: 0.01, minRelative: 0.5, criticalAbsolute: 0.1 },
  availability: { worseWhen: 'decrease', minAbsolute: 0.01, minRelative: 0.01, criticalAbsolute: 0.05 },
  // Latency in ms.
  latency_p50: { worseWhen: 'increase', minAbsolute: 50, minRelative: 0.3, criticalAbsolute: 1000 },
  latency_p95: { worseWhen: 'increase', minAbsolute: 100, minRelative: 0.3, criticalAbsolute: 2000 },
  latency_p99: { worseWhen: 'increase', minAbsolute: 200, minRelative: 0.3, criticalAbsolute: 3000 },
  // Throughput can move for entirely legitimate reasons, so it is held to a high bar
  // and is rarely an incident on its own.
  request_throughput: { worseWhen: 'decrease', minAbsolute: 10, minRelative: 0.5, criticalAbsolute: 1000 },
  cpu_utilization: { worseWhen: 'increase', minAbsolute: 0.2, minRelative: 0.5, criticalAbsolute: 0.9 },
  memory_utilization: { worseWhen: 'increase', minAbsolute: 0.2, minRelative: 0.5, criticalAbsolute: 0.9 },
};

/** Below this many samples in either window, a comparison is not trustworthy. */
export const MIN_SAMPLES = 3;

export interface DetectOptions {
  thresholds?: Partial<Record<MetricName, MetricThreshold>>;
  minSamples?: number;
}

export function mean(values: number[]): number {
  if (values.length === 0) return Number.NaN;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * Compare a baseline window against an observation window, per metric.
 *
 * Three outcomes, kept distinct on purpose: a regression, a dismissal (we looked and
 * it is fine), and inconclusive (we could not tell). Collapsing the third into the
 * second would let missing telemetry read as healthy telemetry.
 */
export function detectRegressions(
  windows: { baseline: MetricSeries; observed: MetricSeries }[],
  opts: DetectOptions = {},
): DetectionResult {
  const minSamples = opts.minSamples ?? MIN_SAMPLES;
  const result: DetectionResult = { regressions: [], dismissed: [], inconclusive: [] };

  for (const { baseline, observed } of windows) {
    const metric = baseline.metric;
    const threshold = opts.thresholds?.[metric] ?? DEFAULT_THRESHOLDS[metric];

    if (baseline.points.length < minSamples || observed.points.length < minSamples) {
      result.inconclusive.push({
        metric,
        reason:
          `Insufficient samples to compare (baseline ${baseline.points.length}, ` +
          `observation ${observed.points.length}, need ${minSamples}). ` +
          `This is unknown, not healthy.`,
      });
      continue;
    }

    const baseValue = mean(baseline.points.map((p) => p.value));
    const obsValue = mean(observed.points.map((p) => p.value));
    const absoluteChange = obsValue - baseValue;
    const direction: 'increase' | 'decrease' = absoluteChange >= 0 ? 'increase' : 'decrease';

    // A change in the healthy direction is never a regression, however large.
    if (direction !== threshold.worseWhen) {
      result.dismissed.push({
        metric,
        reason: `Moved in the healthy direction (${fmt(baseValue)} -> ${fmt(obsValue)}).`,
      });
      continue;
    }

    const magnitude = Math.abs(absoluteChange);
    const percentageChange = baseValue === 0 ? null : (absoluteChange / Math.abs(baseValue)) * 100;
    const relative = baseValue === 0 ? Infinity : magnitude / Math.abs(baseValue);

    if (magnitude < threshold.minAbsolute) {
      result.dismissed.push({
        metric,
        reason:
          `Absolute change ${fmt(magnitude)} is below the ${fmt(threshold.minAbsolute)} floor ` +
          `(${fmt(baseValue)} -> ${fmt(obsValue)}); treated as noise.`,
      });
      continue;
    }
    if (relative < threshold.minRelative) {
      result.dismissed.push({
        metric,
        reason:
          `Relative change ${(relative * 100).toFixed(1)}% is below the ` +
          `${(threshold.minRelative * 100).toFixed(0)}% floor; treated as noise.`,
      });
      continue;
    }

    const severity = severityFor(magnitude, relative, threshold);
    result.regressions.push({
      metric,
      service: baseline.service,
      baseline: baseValue,
      observed: obsValue,
      absoluteChange,
      percentageChange,
      severity,
      confidence: confidenceFor(baseline, observed, relative, threshold),
      direction,
      rationale:
        `${metric} moved ${fmt(baseValue)} -> ${fmt(obsValue)} ` +
        `(${percentageChange === null ? 'baseline was zero' : `${percentageChange.toFixed(1)}%`}), ` +
        `exceeding both the ${fmt(threshold.minAbsolute)} absolute and ` +
        `${(threshold.minRelative * 100).toFixed(0)}% relative floors.`,
      baselineSampleCount: baseline.points.length,
      observedSampleCount: observed.points.length,
    });
  }

  return result;
}

function severityFor(magnitude: number, relative: number, t: MetricThreshold): Severity {
  if (magnitude >= t.criticalAbsolute) return 'SEV1';
  if (relative >= 5) return 'SEV1';
  if (relative >= 2) return 'SEV2';
  if (relative >= 1) return 'SEV3';
  return 'SEV4';
}

/**
 * Confidence that the change is real rather than sampling noise.
 *
 * This is a calibrated heuristic over effect size and sample count, not a p-value,
 * and it is capped below 1.0 — a windowed mean comparison cannot justify certainty.
 * It is reported as confidence in the *detection*, never as confidence about a cause.
 */
function confidenceFor(
  baseline: MetricSeries,
  observed: MetricSeries,
  relative: number,
  t: MetricThreshold,
): number {
  const samples = Math.min(baseline.points.length, observed.points.length);
  const sampleFactor = Math.min(1, samples / 20);
  const effectFactor = Math.min(1, relative / (t.minRelative * 4));
  const spread = coefficientOfVariation(baseline.points.map((p) => p.value));
  // A noisy baseline makes any single comparison less trustworthy.
  const stabilityFactor = 1 / (1 + spread);
  const raw = 0.45 + 0.3 * effectFactor + 0.15 * sampleFactor + 0.1 * stabilityFactor;
  return Math.min(0.95, Number(raw.toFixed(2)));
}

function coefficientOfVariation(values: number[]): number {
  const m = mean(values);
  if (!Number.isFinite(m) || m === 0) return 0;
  const variance = mean(values.map((v) => (v - m) ** 2));
  return Math.sqrt(variance) / Math.abs(m);
}

function fmt(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  return Math.abs(n) < 1 ? n.toFixed(4) : n.toFixed(2);
}

/** The most severe regression, which drives incident severity. */
export function worstRegression(r: DetectionResult): Regression | null {
  const order: Severity[] = ['SEV1', 'SEV2', 'SEV3', 'SEV4'];
  return (
    [...r.regressions].sort(
      (a, b) => order.indexOf(a.severity) - order.indexOf(b.severity) || b.confidence - a.confidence,
    )[0] ?? null
  );
}
