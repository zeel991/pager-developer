import { ApiUnavailableError, api, type IncidentRow } from '@/lib/api';
import { ApiDown } from '@/components/api-down';
import { Attribution, IncidentLink, Panel, Severity, State, dateOf } from '@/components/ui';

export const dynamic = 'force-dynamic';

export default async function IncidentsPage() {
  let data: { incidents: IncidentRow[] };
  try {
    data = await api<{ incidents: IncidentRow[] }>('/api/incidents');
  } catch (err) {
    if (err instanceof ApiUnavailableError) return <ApiDown url={err.url} />;
    throw err;
  }

  return (
    <div className="space-y-4">
      <h1 className="text-[15px] font-semibold">Incidents</h1>
      <Panel title="All incidents" subtitle={`${data.incidents.length} total`} dense>
        {data.incidents.length === 0 ? (
          <div className="px-3 py-6 text-center text-[12px] text-dim">No incidents recorded.</div>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b border-edge-soft font-mono text-[10px] tracking-wider text-dim uppercase">
                <th className="px-3 py-1.5 text-left">Key</th>
                <th className="px-1 py-1.5 text-left">Sev</th>
                <th className="px-2 py-1.5 text-left">Title</th>
                <th className="px-2 py-1.5 text-left">State</th>
                <th className="px-2 py-1.5 text-left">Attribution</th>
                <th className="px-3 py-1.5 text-right">Opened</th>
              </tr>
            </thead>
            <tbody>
              {data.incidents.map((i) => (
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
    </div>
  );
}
