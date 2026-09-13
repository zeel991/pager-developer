/**
 * Shown when the API cannot be reached.
 *
 * Says what is wrong and how to fix it. A dashboard that renders an empty state
 * when it simply cannot reach its backend is actively misleading during an
 * incident — "no active incidents" and "I cannot tell you" must never look alike.
 */
export function ApiDown({ url }: { url: string }) {
  return (
    <div className="rounded-md border border-sev2/40 bg-sev2/5 p-4">
      <div className="font-mono text-[12px] font-semibold text-sev2">API unreachable</div>
      <p className="mt-1 text-[12px] text-muted">
        Could not reach the Pager Developer API at <span className="font-mono">{url}</span>. This is not the
        same as having no incidents — nothing can be reported until the API answers.
      </p>
      <pre className="mt-3 overflow-x-auto rounded border border-edge bg-ink px-3 py-2 font-mono text-[11px] text-muted">
{`pnpm api:seed   # populate by running the real pipeline
pnpm api        # start the API on :4000`}
      </pre>
    </div>
  );
}
