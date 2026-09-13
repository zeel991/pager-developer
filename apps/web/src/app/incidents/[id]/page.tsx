import { notFound } from 'next/navigation';
import Link from 'next/link';
import { ApiUnavailableError, api, type IncidentDetail } from '@/lib/api';
import { ApiDown } from '@/components/api-down';
import { Sparkline } from '@/components/sparkline';
import { Attribution, Panel, Severity, State, dateOf, shortSha, timeOf } from '@/components/ui';

export const dynamic = 'force-dynamic';

function formatValue(metric: string, value: number | null): string {
  if (value === null) return '—';
  if (metric.startsWith('latency')) return `${value.toFixed(1)}ms`;
  if (metric === 'request_throughput') return `${value.toFixed(1)}/s`;
  return `${(value * 100).toFixed(2)}%`;
}

export default async function IncidentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let data: IncidentDetail;
  try {
    data = await api<IncidentDetail>(`/api/incidents/${id}`);
  } catch (err) {
    if (err instanceof ApiUnavailableError) return <ApiDown url={err.url} />;
    if (err instanceof Error && err.message === 'not-found') notFound();
    throw err;
  }

  const { incident, deployment, timeline, evidence, agentRuns, telemetry, auditLog, service } = data;

  // Pair baseline and observation windows per metric so the change is readable
  // as one row rather than two.
  const metrics = [...new Set(telemetry.map((t) => t.metric))].map((metric) => ({
    metric,
    baseline: telemetry.find((t) => t.metric === metric && t.windowKind === 'baseline') ?? null,
    observation: telemetry.find((t) => t.metric === metric && t.windowKind === 'observation') ?? null,
  }));

  const totalToolCalls = agentRuns.reduce((n, r) => n + r.toolCalls.length, 0);
  const failedToolCalls = agentRuns.reduce((n, r) => n + r.toolCalls.filter((c) => c.status === 'ERROR').length, 0);

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center gap-3">
        <Link href="/incidents" className="font-mono text-[11px] text-dim hover:text-muted">← incidents</Link>
        <h1 className="font-mono text-[15px] font-semibold">{incident.key}</h1>
        <Severity value={incident.severity} />
        <State value={incident.state} />
        <span className="text-[13px] text-muted">{incident.title}</span>
        <span className="ml-auto font-mono text-[11px] text-dim">
          {service?.name ?? 'unknown service'} · opened {dateOf(incident.openedAt)}
        </span>
      </header>

      {/* Attribution gets its own band: it is the question the whole product turns on. */}
      <div className="rounded-md border border-edge bg-panel px-3 py-2">
        <div className="flex flex-wrap items-center gap-6">
          <div>
            <div className="font-mono text-[10px] tracking-wider text-dim uppercase">Deployment attribution</div>
            <div className="mt-0.5">
              <Attribution value={incident.deploymentAttribution} confidence={incident.attributionConfidence} />
            </div>
          </div>
          {!incident.deploymentAttribution && (
            <p className="max-w-2xl text-[11px] leading-snug text-dim">
              A deployment preceded this regression, which is correlation. No verdict has been recorded
              because none is supported by evidence yet.
            </p>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <div className="space-y-4 xl:col-span-2">
          <Panel title="Telemetry" subtitle="baseline vs observation window" dense>
            {metrics.length === 0 ? (
              <div className="px-3 py-6 text-center text-[12px] text-dim">No telemetry recorded.</div>
            ) : (
              <table className="w-full">
                <tbody>
                  {metrics.map(({ metric, baseline, observation }) => (
                    <tr key={metric} className="border-b border-edge-soft last:border-0">
                      <td className="w-44 px-3 py-2 font-mono text-[11px]">{metric}</td>
                      <td className="w-24 px-2 py-2 text-right font-mono text-[11px] text-muted">
                        {formatValue(metric, baseline?.mean ?? null)}
                      </td>
                      <td className="w-6 px-1 py-2 text-center font-mono text-[11px] text-dim">→</td>
                      <td className="w-24 px-2 py-2 text-right font-mono text-[11px]">
                        {formatValue(metric, observation?.mean ?? null)}
                      </td>
                      <td className="px-3 py-1">
                        {observation && (
                          <Sparkline points={observation.points} baseline={baseline?.mean ?? null} />
                        )}
                      </td>
                      <td className="w-20 px-3 py-2 text-right font-mono text-[10px] text-dim">
                        {observation?.sampleCount ?? 0} pts
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>

          <Panel title="Deployment" subtitle={deployment ? shortSha(deployment.commitSha) : undefined} dense>
            {!deployment ? (
              <div className="px-3 py-6 text-center text-[12px] text-dim">No deployment associated.</div>
            ) : (
              <div className="divide-y divide-edge-soft">
                <div className="grid grid-cols-4 gap-3 px-3 py-2">
                  <Field label="Revision" value={`${deployment.previousCommitSha ? shortSha(deployment.previousCommitSha) : '—'} → ${shortSha(deployment.commitSha)}`} />
                  <Field label="Author" value={deployment.authorName ?? 'unknown'} />
                  <Field label="Environment" value={deployment.environment} />
                  <Field label="Deployed" value={deployment.deployedAt ? dateOf(deployment.deployedAt) : '—'} />
                </div>
                {deployment.pullRequests.length > 0 && (
                  <div className="px-3 py-2">
                    <div className="font-mono text-[10px] tracking-wider text-dim uppercase">Pull requests</div>
                    {deployment.pullRequests.map((pr) => (
                      <div key={pr.number} className="mt-1 font-mono text-[11px]">
                        <span className="text-accent">#{pr.number}</span> <span className="text-muted">{pr.title}</span>
                      </div>
                    ))}
                  </div>
                )}
                <div className="px-3 py-2">
                  <div className="font-mono text-[10px] tracking-wider text-dim uppercase">
                    Changed files ({deployment.files.length})
                  </div>
                  {deployment.files.length === 0 ? (
                    <div className="mt-1 text-[11px] text-dim">No file changes recorded.</div>
                  ) : (
                    deployment.files.map((f) => (
                      <div key={f.path} className="mt-1 flex items-center gap-2 font-mono text-[11px]">
                        <span className="w-16 text-dim">{f.status}</span>
                        <span className="text-text">{f.path}</span>
                        <span className="text-ok">+{f.additions}</span>
                        <span className="text-sev1">−{f.deletions}</span>
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}
          </Panel>

          <Panel title="Evidence" subtitle={`${evidence.length} records`} dense>
            {evidence.length === 0 ? (
              <div className="px-3 py-6 text-center text-[12px] text-dim">No evidence recorded yet.</div>
            ) : (
              <table className="w-full">
                <tbody>
                  {evidence.map((e) => (
                    <tr key={e.id} className="border-b border-edge-soft last:border-0 align-top">
                      <td className="w-36 px-3 py-2 font-mono text-[10px] text-muted">{e.kind}</td>
                      <td className="w-20 px-1 py-2">
                        {/* Derived values are marked: a computed change is not an observation. */}
                        <span className={`font-mono text-[10px] ${e.provenance === 'OBSERVED' ? 'text-ok' : 'text-sev4'}`}>
                          {e.provenance}
                        </span>
                      </td>
                      <td className="px-2 py-2 text-[11px] text-muted">{e.summary}</td>
                      <td className="w-44 px-3 py-2 text-right font-mono text-[10px] text-dim" title="The tool call that produced this">
                        {e.sourceToolCallId.slice(0, 8)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>
        </div>

        <div className="space-y-4">
          <Panel title="Timeline" subtitle={`${timeline.length} events`} dense>
            <ol className="divide-y divide-edge-soft">
              {timeline.map((e) => (
                <li key={e.id} className="px-3 py-2">
                  <div className="flex items-baseline gap-2">
                    <span className="font-mono text-[10px] text-dim">{timeOf(e.at)}</span>
                    <span className="font-mono text-[10px] text-accent">{e.kind}</span>
                  </div>
                  <div className="mt-0.5 text-[11px] leading-snug text-muted">{e.summary}</div>
                  {e.fromState && e.toState && (
                    <div className="mt-0.5 font-mono text-[10px] text-dim">{e.fromState} → {e.toState}</div>
                  )}
                </li>
              ))}
            </ol>
          </Panel>

          <Panel title="Agent runs" subtitle={`${totalToolCalls} tool calls, ${failedToolCalls} failed`} dense>
            <div className="divide-y divide-edge-soft">
              {agentRuns.map((run) => (
                <div key={run.id} className="px-3 py-2">
                  <div className="flex items-baseline justify-between">
                    <span className="font-mono text-[11px]">{run.agentName}</span>
                    <span className={`font-mono text-[10px] ${run.status === 'OK' ? 'text-ok' : 'text-sev1'}`}>
                      {run.status}
                    </span>
                  </div>
                  <div className="mt-1 space-y-0.5">
                    {run.toolCalls.map((call) => (
                      <div key={call.id} className="flex items-baseline gap-2 font-mono text-[10px]">
                        <span className={call.status === 'OK' ? 'text-dim' : 'text-sev1'}>
                          {call.status === 'OK' ? '·' : '✗'}
                        </span>
                        <span className="text-muted">{call.toolName}</span>
                        <span className="ml-auto text-dim">{call.durationMs}ms</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </Panel>

          <Panel title="Audit log" subtitle={`${auditLog.length} entries`} dense>
            {auditLog.length === 0 ? (
              <div className="px-3 py-4 text-center text-[11px] text-dim">No actions recorded.</div>
            ) : (
              <div className="divide-y divide-edge-soft">
                {auditLog.map((a) => (
                  <div key={a.id} className="px-3 py-1.5 font-mono text-[10px]">
                    <div className="flex items-baseline gap-2">
                      <span className={a.allowed ? 'text-ok' : 'text-sev1'}>{a.allowed ? 'ALLOW' : 'DENY '}</span>
                      <span className="text-muted">{a.action}</span>
                    </div>
                    <div className="text-dim">{a.actor}</div>
                    {a.denialReason && <div className="mt-0.5 text-sev2">{a.denialReason}</div>}
                  </div>
                ))}
              </div>
            )}
          </Panel>
        </div>
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="font-mono text-[10px] tracking-wider text-dim uppercase">{label}</div>
      <div className="mt-0.5 font-mono text-[11px]">{value}</div>
    </div>
  );
}
