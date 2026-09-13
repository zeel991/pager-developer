/**
 * A metric sparkline.
 *
 * Drawn from the stored point list rather than a summary, so what is shown is the
 * telemetry the decision was actually made on. The baseline band is drawn behind
 * the line so an excursion is legible without reading the axis.
 */
export function Sparkline({
  points,
  baseline,
  width = 260,
  height = 44,
}: {
  points: { at: string; value: number }[];
  baseline?: number | null;
  width?: number;
  height?: number;
}) {
  if (points.length < 2) {
    return <div className="font-mono text-[10px] text-dim">insufficient samples</div>;
  }

  const values = points.map((p) => p.value);
  const min = Math.min(...values, baseline ?? Infinity);
  const max = Math.max(...values, baseline ?? -Infinity);
  const span = max - min || 1;
  const pad = 3;

  const x = (i: number) => (i / (points.length - 1)) * (width - pad * 2) + pad;
  const y = (v: number) => height - pad - ((v - min) / span) * (height - pad * 2);

  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
  const area = `${path} L${x(points.length - 1).toFixed(1)},${height - pad} L${x(0).toFixed(1)},${height - pad} Z`;

  // Colour by direction of travel, since these are almost all "lower is better".
  const rising = values[values.length - 1]! > values[0]!;
  const stroke = rising ? 'var(--color-sev1)' : 'var(--color-ok)';

  return (
    <svg width={width} height={height} className="block" role="img" aria-label="metric sparkline">
      {baseline != null && (
        <line
          x1={pad} x2={width - pad} y1={y(baseline)} y2={y(baseline)}
          stroke="var(--color-edge)" strokeDasharray="2 3" strokeWidth="1"
        />
      )}
      <path d={area} fill={stroke} opacity="0.08" />
      <path d={path} fill="none" stroke={stroke} strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}
