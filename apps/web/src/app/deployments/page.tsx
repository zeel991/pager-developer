import { ApiUnavailableError, api, type DeploymentRow } from '@/lib/api';
import { ApiDown } from '@/components/api-down';
import { Panel, dateOf, shortSha } from '@/components/ui';

export const dynamic = 'force-dynamic';

export default async function DeploymentsPage() {
  let data: { deployments: DeploymentRow[] };
  try {
    data = await api<{ deployments: DeploymentRow[] }>('/api/deployments');
  } catch (err) {
    if (err instanceof ApiUnavailableError) return <ApiDown url={err.url} />;
    throw err;
  }

  return (
    <div className="space-y-4">
      <h1 className="text-[15px] font-semibold">Deployments</h1>
      <Panel title="Deployment timeline" subtitle={`${data.deployments.length} tracked`} dense>
        {data.deployments.length === 0 ? (
          <div className="px-3 py-6 text-center text-[12px] text-dim">No deployments recorded.</div>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b border-edge-soft font-mono text-[10px] tracking-wider text-dim uppercase">
                <th className="px-3 py-1.5 text-left">Commit</th>
                <th className="px-2 py-1.5 text-left">Previous</th>
                <th className="px-2 py-1.5 text-left">Author</th>
                <th className="px-2 py-1.5 text-left">Env</th>
                <th className="px-2 py-1.5 text-left">Status</th>
                <th className="px-3 py-1.5 text-right">Deployed</th>
              </tr>
            </thead>
            <tbody>
              {data.deployments.map((d) => (
                <tr key={d.id} className="border-b border-edge-soft last:border-0 hover:bg-panel-2">
                  <td className="w-28 px-3 py-2 font-mono text-[11px] text-accent">{shortSha(d.commitSha)}</td>
                  <td className="w-28 px-2 py-2 font-mono text-[11px] text-dim">
                    {d.previousCommitSha ? shortSha(d.previousCommitSha) : '(first)'}
                  </td>
                  <td className="px-2 py-2 text-[12px] text-muted">{d.authorName ?? 'unknown'}</td>
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
