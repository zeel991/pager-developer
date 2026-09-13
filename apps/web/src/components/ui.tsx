import Link from 'next/link';
import type { ReactNode } from 'react';

/** Severity colours are load-bearing, so they are defined once. */
const SEVERITY_COLOR: Record<string, string> = {
  SEV1: 'text-sev1 border-sev1/40 bg-sev1/10',
  SEV2: 'text-sev2 border-sev2/40 bg-sev2/10',
  SEV3: 'text-sev3 border-sev3/40 bg-sev3/10',
  SEV4: 'text-sev4 border-sev4/40 bg-sev4/10',
};

/** Terminal states read differently from in-flight ones. */
const STATE_COLOR: Record<string, string> = {
  RESOLVED: 'text-ok border-ok/40 bg-ok/10',
  FALSE_POSITIVE: 'text-dim border-edge bg-panel-2',
  EXTERNAL_INCIDENT: 'text-sev4 border-sev4/40 bg-sev4/10',
  APPROVAL_REJECTED: 'text-dim border-edge bg-panel-2',
  UNRESOLVED: 'text-sev2 border-sev2/40 bg-sev2/10',
  AWAITING_APPROVAL: 'text-sev3 border-sev3/40 bg-sev3/10',
};

export function Severity({ value }: { value: string }) {
  return (
    <span className={`rounded border px-1.5 py-0.5 font-mono text-[11px] font-semibold ${SEVERITY_COLOR[value] ?? 'text-muted border-edge'}`}>
      {value}
    </span>
  );
}

export function State({ value }: { value: string }) {
  return (
    <span className={`rounded border px-1.5 py-0.5 font-mono text-[11px] ${STATE_COLOR[value] ?? 'text-accent border-accent/30 bg-accent/10'}`}>
      {value}
    </span>
  );
}

/**
 * Attribution is rendered explicitly, including when it is unknown.
 *
 * An empty cell would read as "nothing to say"; "NOT DETERMINED" says that the
 * question was asked and has not been answered, which is the honest state for most
 * of an incident's life.
 */
export function Attribution({ value, confidence }: { value: string | null; confidence?: number | null }) {
  if (!value) {
    return <span className="font-mono text-[11px] text-dim">NOT DETERMINED</span>;
  }
  const tone =
    value === 'DEPLOYMENT_LIKELY_RESPONSIBLE'
      ? 'text-sev2'
      : value === 'EXTERNAL_INCIDENT' || value === 'DEPLOYMENT_NOT_RESPONSIBLE'
        ? 'text-ok'
        : 'text-muted';
  return (
    <span className={`font-mono text-[11px] ${tone}`}>
      {value.replaceAll('_', ' ')}
      {confidence != null && <span className="text-dim"> · {(confidence * 100).toFixed(0)}%</span>}
    </span>
  );
}

export function Panel({
  title,
  subtitle,
  children,
  actions,
  dense,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  actions?: ReactNode;
  dense?: boolean;
}) {
  return (
    <section className="rounded-md border border-edge bg-panel">
      <header className="flex items-baseline justify-between border-b border-edge-soft px-3 py-2">
        <div className="flex items-baseline gap-2">
          <h2 className="font-mono text-[11px] font-semibold tracking-wider text-muted uppercase">{title}</h2>
          {subtitle && <span className="text-[11px] text-dim">{subtitle}</span>}
        </div>
        {actions}
      </header>
      <div className={dense ? '' : 'p-3'}>{children}</div>
    </section>
  );
}

export function Stat({ label, value, tone }: { label: string; value: string | number; tone?: 'alert' | 'warn' | 'ok' }) {
  const color = tone === 'alert' ? 'text-sev1' : tone === 'warn' ? 'text-sev3' : tone === 'ok' ? 'text-ok' : 'text-text';
  return (
    <div className="rounded-md border border-edge bg-panel px-3 py-2">
      <div className="font-mono text-[10px] tracking-wider text-dim uppercase">{label}</div>
      <div className={`mt-0.5 font-mono text-xl leading-none ${color}`}>{value}</div>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="px-3 py-6 text-center text-[12px] text-dim">{children}</div>;
}

export function Mono({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <span className={`font-mono text-[11px] ${className}`}>{children}</span>;
}

export function IncidentLink({ id, label }: { id: string; label: string }) {
  return (
    <Link href={`/incidents/${id}`} className="font-mono text-[12px] text-accent hover:underline">
      {label}
    </Link>
  );
}

export function timeOf(iso: string): string {
  return new Date(iso).toISOString().slice(11, 19);
}

export function dateOf(iso: string): string {
  return new Date(iso).toISOString().replace('T', ' ').slice(0, 16);
}

export function shortSha(sha: string): string {
  return sha.slice(0, 8);
}
