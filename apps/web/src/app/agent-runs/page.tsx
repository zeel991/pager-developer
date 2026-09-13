import { ApiUnavailableError, api } from '@/lib/api';
import { ApiDown } from '@/components/api-down';
import { Panel } from '@/components/ui';

export const dynamic = 'force-dynamic';

interface AgentStat { agent_name: string; status: string; runs: number; avg_ms: number | null }
interface ToolStat { tool_name: string; status: string; calls: number; avg_ms: number | null }

/**
 * Pager's own observability.
 *
 * Failed tool calls are shown alongside successful ones rather than filtered out:
 * a rising failure rate on one provider is the earliest signal that Pager's own
 * conclusions are becoming unreliable.
 */
export default async function AgentRunsPage() {
  let data: { agents: AgentStat[]; tools: ToolStat[] };
  try {
    data = await api<{ agents: AgentStat[]; tools: ToolStat[] }>('/api/agent-runs');
  } catch (err) {
    if (err instanceof ApiUnavailableError) return <ApiDown url={err.url} />;
    throw err;
  }

  const failing = data.tools.filter((t) => t.status === 'ERROR');

  return (
    <div className="space-y-4">
      <h1 className="text-[15px] font-semibold">Agent Runs</h1>

      <Panel title="Agents" subtitle="runs by outcome" dense>
        <table className="w-full">
          <tbody>
            {data.agents.map((a, i) => (
              <tr key={i} className="border-b border-edge-soft last:border-0">
                <td className="px-3 py-2 font-mono text-[11px]">{a.agent_name}</td>
                <td className={`w-20 px-2 py-2 font-mono text-[11px] ${a.status === 'OK' ? 'text-ok' : 'text-sev1'}`}>
                  {a.status}
                </td>
                <td className="w-20 px-2 py-2 text-right font-mono text-[11px]">{a.runs}</td>
                <td className="w-24 px-3 py-2 text-right font-mono text-[11px] text-dim">
                  {a.avg_ms != null ? `${a.avg_ms}ms` : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      <Panel title="Tool calls" subtitle={failing.length > 0 ? `${failing.length} tool(s) with failures` : 'no failures'} dense>
        <table className="w-full">
          <tbody>
            {data.tools.map((t, i) => (
              <tr key={i} className="border-b border-edge-soft last:border-0">
                <td className="px-3 py-2 font-mono text-[11px]">{t.tool_name}</td>
                <td className={`w-20 px-2 py-2 font-mono text-[11px] ${t.status === 'OK' ? 'text-ok' : 'text-sev1'}`}>
                  {t.status}
                </td>
                <td className="w-20 px-2 py-2 text-right font-mono text-[11px]">{t.calls}</td>
                <td className="w-24 px-3 py-2 text-right font-mono text-[11px] text-dim">
                  {t.avg_ms != null ? `${t.avg_ms}ms` : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </div>
  );
}
