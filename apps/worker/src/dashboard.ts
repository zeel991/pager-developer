/**
 * The worker's own dashboard.
 *
 * Served by the watcher itself so there is one place to answer "is it running, and
 * what has it done". No database and no build step: the state is already in memory,
 * this only renders it.
 *
 * The distinction the whole product turns on is carried into the layout. Exit codes
 * from processes that really ran are shown as OBSERVED. A diagnosis, an attribution
 * and a confidence are shown as MODEL CONCLUSION, visually separated, because one is
 * a reading and the other is an inference. A check that did not run is shown as
 * "not run" and never as a pass.
 *
 * It holds only what this process has seen: a restart starts the history empty, and
 * the page says so rather than presenting an empty list as "no incidents".
 */

interface Renderable {
  startedAt: string;
  lastTickAt: string | null;
  lastOutcome: string | null;
  ticks: number;
  busy: boolean;
  busySince: string | null;
  incidents: {
    revision: string;
    at: string;
    durationMs: number;
    outcome: string;
    pullRequest: string | null;
    errorType: string | null;
    occurrences: number;
    location: string | null;
    diagnosis: string | null;
    attribution: string | null;
    confidence: number | null;
    uncertainty: string | null;
    citedObservations: number;
    reproduction: { command: string; beforeExit: number | null; afterExit: number | null; proven: boolean } | null;
    checks: { kind: string; passed: boolean; skipped: boolean; exitCode: number | null }[];
    model: string | null;
    modelCalls: number;
    inputTokens: number | null;
    outputTokens: number | null;
    toolCalls: number;
    failedToolCalls: number;
  }[];
  handledRevisions: string[];
  config: {
    service: string;
    repository: string;
    model: string;
    intervalSeconds: number;
    readOnly: boolean;
  } | null;
}

/** Escape untrusted text. Diagnoses are model output and go into HTML. */
function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function ago(iso: string | null): string {
  if (!iso) return 'never';
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
}

const STYLE = `
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body { margin:0; background:#0b0d10; color:#c9d1d9; font:13px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace; }
a { color:#79b8ff; }
.wrap { max-width:1080px; margin:0 auto; padding:28px 20px 60px; }
h1 { font-size:15px; margin:0; letter-spacing:.02em; }
h1 span { color:#6e7681; font-weight:400; }
.sub { color:#6e7681; font-size:11px; margin-top:4px; }
.bar { display:flex; flex-wrap:wrap; gap:10px 26px; align-items:baseline;
       border:1px solid #1f2428; background:#0f1216; border-radius:6px; padding:12px 14px; margin:18px 0; }
.k { color:#6e7681; font-size:10px; text-transform:uppercase; letter-spacing:.08em; }
.v { color:#c9d1d9; }
.pill { display:inline-block; padding:1px 7px; border-radius:10px; font-size:11px; border:1px solid; }
.live { color:#3fb950; border-color:#238636; }
.busy { color:#d29922; border-color:#9e6a03; }
.panel { border:1px solid #1f2428; background:#0f1216; border-radius:6px; margin-bottom:14px; }
.phead { padding:9px 14px; border-bottom:1px solid #1f2428; display:flex; gap:12px; align-items:baseline; flex-wrap:wrap; }
.pbody { padding:12px 14px; }
.tag { font-size:10px; text-transform:uppercase; letter-spacing:.08em; padding:1px 6px; border-radius:3px; }
.observed { background:#0d2818; color:#3fb950; }
.inferred { background:#2d2410; color:#d29922; }
.sect { margin-top:12px; }
.sect h3 { font-size:10px; text-transform:uppercase; letter-spacing:.08em; color:#6e7681; margin:0 0 5px; font-weight:600; }
.prose { color:#adbac7; white-space:pre-wrap; font-size:12px; }
.pass { color:#3fb950; } .fail { color:#f85149; } .skip { color:#6e7681; }
.empty { padding:28px 14px; text-align:center; color:#6e7681; font-size:12px; }
.note { color:#6e7681; font-size:11px; margin-top:6px; }
code { background:#161b22; padding:1px 5px; border-radius:3px; color:#adbac7; }
`;

export function renderDashboard(s: Renderable): string {
  const state = s.busy
    ? `<span class="pill busy">INVESTIGATING</span>`
    : `<span class="pill live">WATCHING</span>`;

  const cfg = s.config;

  const incidents = s.incidents.length === 0
    ? `<div class="panel"><div class="empty">
         No incidents since this process started ${esc(ago(s.startedAt))}.<br>
         That means none were <em>observed</em> — not that none occurred. History is
         held in memory, so a restart begins empty.
       </div></div>`
    : s.incidents.map((i) => {
        const ran = i.checks.filter((c) => !c.skipped);
        const skipped = i.checks.filter((c) => c.skipped);
        return `
<div class="panel">
  <div class="phead">
    <strong>${esc(i.errorType ?? 'Incident')}</strong>
    <span class="v">×${i.occurrences}</span>
    ${i.location ? `<code>${esc(i.location)}</code>` : ''}
    <span class="k" style="margin-left:auto">${esc(ago(i.at))} · ${(i.durationMs / 1000).toFixed(0)}s</span>
  </div>
  <div class="pbody">
    <div><span class="k">outcome</span> <span class="v">${esc(i.outcome)}</span></div>
    ${i.pullRequest ? `<div style="margin-top:5px"><span class="k">handoff</span>
        <a href="${esc(i.pullRequest)}" target="_blank" rel="noreferrer">${esc(i.pullRequest)}</a>
        &nbsp;<span class="k">awaiting a human — this agent cannot merge</span></div>` : ''}
    <div style="margin-top:5px"><span class="k">revision investigated</span> <code>${esc(i.revision.slice(0, 12))}</code></div>

    ${i.reproduction ? `
    <div class="sect">
      <h3><span class="tag observed">observed</span> &nbsp;reproduction — fail before, pass after</h3>
      <div class="prose"><code>${esc(i.reproduction.command)}</code></div>
      <div style="margin-top:4px">
        before patch <span class="fail">exit ${esc(i.reproduction.beforeExit)}</span> &nbsp;·&nbsp;
        after patch <span class="${i.reproduction.afterExit === 0 ? 'pass' : 'fail'}">exit ${esc(i.reproduction.afterExit ?? 'n/a')}</span>
      </div>
    </div>` : ''}

    ${i.checks.length > 0 ? `
    <div class="sect">
      <h3><span class="tag observed">observed</span> &nbsp;checks</h3>
      ${ran.map((c) => `<div><span class="${c.passed ? 'pass' : 'fail'}">${c.passed ? 'pass' : 'FAIL'}</span>
         <span class="v">${esc(c.kind)}</span> <span class="k">exit ${esc(c.exitCode)}</span></div>`).join('')}
      ${skipped.length > 0 ? `<div class="skip">not run: ${skipped.map((c) => esc(c.kind)).join(', ')}
         — reported as unmeasured, never as passing</div>` : ''}
    </div>` : ''}

    ${i.diagnosis ? `
    <div class="sect">
      <h3><span class="tag inferred">model conclusion</span> &nbsp;diagnosis</h3>
      <div class="prose">${esc(i.diagnosis)}</div>
      <div class="note">
        attribution <span class="v">${esc(i.attribution)}</span> ·
        stated confidence <span class="v">${i.confidence?.toFixed(2) ?? '—'}</span> ·
        from ${i.citedObservations} cited observation(s) — an inference, not a verified fact
      </div>
    </div>` : ''}

    ${i.uncertainty ? `
    <div class="sect">
      <h3><span class="tag inferred">model conclusion</span> &nbsp;what it could not establish</h3>
      <div class="prose">${esc(i.uncertainty)}</div>
    </div>` : ''}

    <div class="sect note">
      ${i.model ? `${esc(i.model)} · ${i.modelCalls} model call(s) · ${esc(i.inputTokens ?? '?')} in / ${esc(i.outputTokens ?? '?')} out tokens · ` : ''}
      ${i.toolCalls} tool call(s), ${i.failedToolCalls} failed
    </div>
  </div>
</div>`;
      }).join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pager Developer — watching ${esc(cfg?.service ?? '')}</title>
<meta http-equiv="refresh" content="15">
<style>${STYLE}</style></head>
<body><div class="wrap">
  <h1>pager<span>·</span>developer &nbsp;${state}</h1>
  <div class="sub">An AI production engineer. It watches, investigates, reproduces, repairs — and hands a human a pull request. It never merges and never deploys.</div>

  <div class="bar">
    <div><div class="k">service</div><div class="v">${esc(cfg?.service ?? '—')}</div></div>
    <div><div class="k">repository</div><div class="v">${esc(cfg?.repository ?? '—')}</div></div>
    <div><div class="k">model</div><div class="v">${esc(cfg?.model ?? '—')}</div></div>
    <div><div class="k">checks every</div><div class="v">${esc(cfg?.intervalSeconds ?? '—')}s</div></div>
    <div><div class="k">autonomy</div><div class="v">${cfg?.readOnly ? 'L2 — may not open PRs' : 'L3 — may open PRs'}</div></div>
  </div>

  <div class="bar">
    <div><div class="k">uptime since</div><div class="v">${esc(ago(s.startedAt))}</div></div>
    <div><div class="k">checks run</div><div class="v">${s.ticks}</div></div>
    <div><div class="k">last check</div><div class="v">${esc(ago(s.lastTickAt))}</div></div>
    <div><div class="k">incidents handled</div><div class="v">${s.incidents.length}</div></div>
    <div style="flex:1 1 260px"><div class="k">last outcome</div><div class="v">${esc(s.lastOutcome ?? (s.busy ? 'first check in progress' : 'no check has completed yet'))}</div></div>
  </div>

  ${incidents}

  <div class="note">
    Auto-refreshes every 15s. Raw state at <a href="/status">/status</a>.
    Every connection is live: Datadog, Slack, GitHub and the model. The revision
    investigated is read from the service's own health endpoint, never assumed.
  </div>
</div></body></html>`;
}
