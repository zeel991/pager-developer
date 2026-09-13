import type { Metadata } from 'next';
import Link from 'next/link';
import './globals.css';

export const metadata: Metadata = {
  title: 'Pager Developer',
  description: 'AI production engineer assigned to software deployments',
};

const NAV = [
  ['Overview', '/'],
  ['Incidents', '/incidents'],
  ['Deployments', '/deployments'],
  ['Agent Runs', '/agent-runs'],
  ['Policies', '/policies'],
] as const;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">
        <div className="flex min-h-screen">
          <nav className="w-48 shrink-0 border-r border-edge bg-panel">
            <div className="border-b border-edge px-3 py-3">
              <div className="font-mono text-[13px] font-semibold tracking-tight">
                pager<span className="text-accent">·</span>developer
              </div>
              <div className="mt-0.5 font-mono text-[10px] text-dim">production engineer</div>
            </div>
            <ul className="p-2">
              {NAV.map(([label, href]) => (
                <li key={href}>
                  <Link
                    href={href}
                    className="block rounded px-2 py-1.5 text-[12px] text-muted hover:bg-panel-2 hover:text-text"
                  >
                    {label}
                  </Link>
                </li>
              ))}
            </ul>
            <div className="mx-2 mt-2 rounded border border-edge-soft bg-panel-2 px-2 py-2">
              <div className="font-mono text-[10px] tracking-wider text-dim uppercase">Autonomy</div>
              <div className="mt-0.5 font-mono text-[12px] text-accent">L3</div>
              <div className="mt-1 text-[10px] leading-snug text-dim">
                May open a pull request. May not execute remediation.
              </div>
            </div>
          </nav>
          <main className="min-w-0 flex-1 p-4">{children}</main>
        </div>
      </body>
    </html>
  );
}
