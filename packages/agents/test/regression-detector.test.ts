import { describe, expect, it } from 'vitest';
import type { MetricName, MetricSeries } from '@pager/providers';
import { detectRegressions, worstRegression } from '../src/regression-detector.js';

function series(metric: MetricName, values: number[], service = 'checkout-api'): MetricSeries {
  return {
    metric,
    service,
    environment: 'production',
    unit: 'ratio',
    points: values.map((value, i) => ({ at: new Date(1757772000000 + i * 60_000), value })),
  };
}

const flat = (v: number, n = 10) => Array.from({ length: n }, () => v);

describe('RegressionDetector', () => {
  it('treats 0.4% -> 0.45% error rate as noise', () => {
    const r = detectRegressions([
      { baseline: series('error_rate', flat(0.004)), observed: series('error_rate', flat(0.0045)) },
    ]);
    expect(r.regressions).toHaveLength(0);
    expect(r.dismissed[0]!.reason).toMatch(/noise/);
  });

  it('flags 0.4% -> 17.8% error rate as a high-confidence SEV1', () => {
    const r = detectRegressions([
      { baseline: series('error_rate', flat(0.004)), observed: series('error_rate', flat(0.178)) },
    ]);
    expect(r.regressions).toHaveLength(1);
    const reg = r.regressions[0]!;
    expect(reg.severity).toBe('SEV1');
    expect(reg.percentageChange).toBeCloseTo(4350, 0);
    expect(reg.confidence).toBeGreaterThan(0.8);
  });

  it('never reports certainty, because a windowed mean comparison cannot justify it', () => {
    const r = detectRegressions([
      { baseline: series('error_rate', flat(0.004)), observed: series('error_rate', flat(0.9)) },
    ]);
    expect(r.regressions[0]!.confidence).toBeLessThan(1);
    expect(r.regressions[0]!.confidence).toBeLessThanOrEqual(0.95);
  });

  it('does not report a large relative move on a negligible base', () => {
    // 0.001% -> 0.002% is +100% and completely meaningless.
    const r = detectRegressions([
      { baseline: series('error_rate', flat(0.00001)), observed: series('error_rate', flat(0.00002)) },
    ]);
    expect(r.regressions).toHaveLength(0);
    expect(r.dismissed[0]!.reason).toMatch(/below the .* floor/);
  });

  it('understands that a rise in availability is not a regression', () => {
    const r = detectRegressions([
      { baseline: series('availability', flat(0.95)), observed: series('availability', flat(0.999)) },
    ]);
    expect(r.regressions).toHaveLength(0);
    expect(r.dismissed[0]!.reason).toMatch(/healthy direction/);
  });

  it('flags a drop in availability', () => {
    const r = detectRegressions([
      { baseline: series('availability', flat(0.999)), observed: series('availability', flat(0.94)) },
    ]);
    expect(r.regressions[0]!.direction).toBe('decrease');
  });

  it('reports missing telemetry as inconclusive rather than healthy', () => {
    const r = detectRegressions([
      { baseline: series('error_rate', [0.004]), observed: series('error_rate', flat(0.178)) },
    ]);
    expect(r.regressions).toHaveLength(0);
    expect(r.dismissed).toHaveLength(0);
    expect(r.inconclusive[0]!.reason).toMatch(/unknown, not healthy/);
  });

  it('reports percentage change as null rather than Infinity when the baseline is zero', () => {
    const r = detectRegressions([
      { baseline: series('error_rate', flat(0)), observed: series('error_rate', flat(0.178)) },
    ]);
    expect(r.regressions[0]!.percentageChange).toBeNull();
    expect(r.regressions[0]!.absoluteChange).toBeCloseTo(0.178);
  });

  it('holds latency to a millisecond floor so small jitter is ignored', () => {
    const quiet = detectRegressions([
      { baseline: series('latency_p95', flat(180)), observed: series('latency_p95', flat(210)) },
    ]);
    expect(quiet.regressions).toHaveLength(0);

    const real = detectRegressions([
      { baseline: series('latency_p95', flat(180)), observed: series('latency_p95', flat(900)) },
    ]);
    expect(real.regressions).toHaveLength(1);
  });

  it('lowers confidence when the baseline is itself unstable', () => {
    const stable = detectRegressions([
      { baseline: series('error_rate', flat(0.02)), observed: series('error_rate', flat(0.09)) },
    ]);
    const noisy = detectRegressions([
      {
        baseline: series('error_rate', [0.001, 0.05, 0.002, 0.06, 0.001, 0.04, 0.003, 0.05, 0.002, 0.04]),
        observed: series('error_rate', flat(0.09)),
      },
    ]);
    expect(noisy.regressions[0]!.confidence).toBeLessThan(stable.regressions[0]!.confidence);
  });

  it('ranks the worst regression for incident severity', () => {
    const r = detectRegressions([
      { baseline: series('latency_p95', flat(180)), observed: series('latency_p95', flat(600)) },
      { baseline: series('error_rate', flat(0.004)), observed: series('error_rate', flat(0.178)) },
    ]);
    expect(worstRegression(r)!.metric).toBe('error_rate');
  });

  it('returns no regression when nothing moved', () => {
    const r = detectRegressions([
      { baseline: series('error_rate', flat(0.004)), observed: series('error_rate', flat(0.004)) },
    ]);
    expect(worstRegression(r)).toBeNull();
  });

  it('offers no way to express deployment blame', () => {
    // A structural assertion: the result type has no attribution field, so the
    // "deploy happened, therefore deploy caused it" shortcut cannot be taken here.
    const r = detectRegressions([
      { baseline: series('error_rate', flat(0.004)), observed: series('error_rate', flat(0.178)) },
    ]);
    const keys = Object.keys(r.regressions[0]!);
    expect(keys).not.toContain('deploymentId');
    expect(keys).not.toContain('cause');
    expect(keys).not.toContain('attribution');
  });
});
