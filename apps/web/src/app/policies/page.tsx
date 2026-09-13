import { Panel } from '@/components/ui';

export const dynamic = 'force-dynamic';

const LEVELS = [
  ['L0', 'Observe', 'Read telemetry only.'],
  ['L1', 'Investigate', 'Read repositories, logs and documentation.'],
  ['L2', 'Prepare remediation', 'Write to an isolated sandbox.'],
  ['L3', 'Create a pull request', 'Open a fix branch and a PR. The default.'],
  ['L4', 'Execute approved remediation', 'Act on production with a recorded approval.'],
  ['L5', 'Execute pre-authorized remediation', 'Act without per-incident approval.'],
] as const;

const PROHIBITED = [
  'push to the default branch',
  'delete production data',
  'modify a production database',
  'modify IAM',
  'rotate credentials',
  'destroy infrastructure',
  'execute arbitrary production commands',
  'deploy arbitrary code',
  'disable security controls',
];

export default function PoliciesPage() {
  return (
    <div className="space-y-4">
      <h1 className="text-[15px] font-semibold">Policies</h1>

      <Panel title="Autonomy" subtitle="current level: L3" dense>
        <table className="w-full">
          <tbody>
            {LEVELS.map(([level, name, detail]) => (
              <tr key={level} className={`border-b border-edge-soft last:border-0 ${level === 'L3' ? 'bg-accent/5' : ''}`}>
                <td className="w-12 px-3 py-2 font-mono text-[11px] text-accent">{level}</td>
                <td className="w-64 px-2 py-2 text-[12px]">{name}</td>
                <td className="px-2 py-2 text-[11px] text-muted">{detail}</td>
                <td className="w-20 px-3 py-2 text-right font-mono text-[10px]">
                  {level === 'L3' ? <span className="text-accent">ACTIVE</span> : <span className="text-dim">—</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      <Panel title="Prohibited capabilities" subtitle="refused at every autonomy level, including L5">
        <p className="mb-2 text-[11px] text-muted">
          These are not high-risk actions requiring approval. They are outside the product&apos;s remit, and
          an attempt to register one is a programming error rather than a policy decision.
        </p>
        <ul className="grid grid-cols-2 gap-x-6 gap-y-1">
          {PROHIBITED.map((p) => (
            <li key={p} className="font-mono text-[11px] text-sev1">✗ {p}</li>
          ))}
        </ul>
      </Panel>

      <Panel title="Approval semantics">
        <ul className="space-y-1.5 text-[12px] text-muted">
          <li>• An approval satisfies a tool&apos;s approval requirement. It never raises the autonomy level.</li>
          <li>• An approval authorises one exact action; a mismatched or expired one is refused, not stretched.</li>
          <li>• Every decision is audited, refusals included.</li>
          <li>• An incident reaches RESOLVED only from VERIFYING_RECOVERY, so a merged fix cannot close it.</li>
        </ul>
      </Panel>
    </div>
  );
}
