import { ApiUnavailableError, api, type Overview } from '@/lib/api';
import { ApiDown } from '@/components/api-down';
import { Attribution, IncidentLink, Panel, Severity, State, Stat, dateOf, shortSha } from '@/components/ui';

export const dynamic = 'force-dynamic';

export default async function OverviewPage() {
  let data: Overview;
  try {
    data = await api<Overview>('/api/overview');
  } catch (err) {
    if (err instanceof ApiUnavailableError) return <ApiDown url={err.url} />;
    throw err;
  }

  const { counts } = data;
  const active = data.incidents.filter((i) => !i.resolvedAt);

  return (
    <div className="space-y-4">
      <header className="flex items-baseline justify-between">
        <h1 className="text-[15px] font-semibold">Overview</h1>
        <span className="font-mono text-[11px] text-dim">
          {data.organization?.name ?? 'no organization'} · autonomy {data.organization?.autonomyLevel ?? '—'}
        </span>
      </header>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
        <Stat label="Active incidents" value={counts.activeIncidents} tone={counts.activeIncidents > 0 ? 'alert' : 'ok'} />
        <Stat label="Investigating" value={counts.investigating} />
        <Stat label="Awaiting approval" value={counts.awaitingApproval} tone={counts.awaitingApproval > 0 ? 'warn' : undefined} />
        <Stat label="Unattributed" value={counts.unattributed} />
        <Stat label="Resolved" value={counts.resolved} tone="ok" />
        <Stat label="Deployments watched" value={counts.deploymentsTracked} />
      </div>

      <Panel title="Active incidents" subtitle={`${active.length} open`} dense>
        {active.length === 0 ? (
          <div className="px-3 py-6 text-center text-[12px] text-dim">
            No active incidents. Production is healthy across watched services.
          </div>
        ) : (
          <table className="w-full">
            <tbody>
              {active.map((i) => (
                <tr key={i.id} className="border-b border-edge-soft last:border-0 hover:bg-panel-2">
                  <td className="w-20 px-3 py-2"><IncidentLink id={i.id} label={i.key} /></td>
                  <td className="w-16 px-1 py-2"><Severity value={i.severity} /></td>
                  <td className="px-2 py-2 text-[12px]">{i.title}</td>
                  <td className="w-44 px-2 py-2"><State value={i.state} /></td>
                  <td className="w-56 px-2 py-2">
                    <Attribution value={i.deploymentAttribution} confidence={i.attributionConfidence} />
                  </td>
                  <td className="w-32 px-3 py-2 text-right font-mono text-[11px] text-dim">{dateOf(i.openedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <Panel title="Recent deployments" subtitle="watched for regressions" dense>
        {data.deployments.length === 0 ? (
          <div className="px-3 py-6 text-center text-[12px] text-dim">No deployments recorded.</div>
        ) : (
          <table className="w-full">
            <tbody>
              {data.deployments.map((d) => (
                <tr key={d.id} className="border-b border-edge-soft last:border-0 hover:bg-panel-2">
                  <td className="w-28 px-3 py-2 font-mono text-[11px] text-accent">{shortSha(d.commitSha)}</td>
                  <td className="w-28 px-2 py-2 font-mono text-[11px] text-dim">
                    {d.previousCommitSha ? `← ${shortSha(d.previousCommitSha)}` : '(first)'}
                  </td>
                  <td className="px-2 py-2 text-[12px] text-muted">{d.authorName ?? 'unknown author'}</td>
                  <td className="w-24 px-2 py-2 font-mono text-[11px] text-dim">{d.environment}</td>
                  <td className="w-24 px-2 py-2 font-mono text-[11px] text-ok">{d.status}</td>
                  <td className="w-40 px-3 py-2 text-right font-mono text-[11px] text-dim">
                    {d.deployedAt ? dateOf(d.deployedAt) : dateOf(d.startedAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </div>
  );
}
