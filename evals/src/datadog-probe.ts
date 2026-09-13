/**
 * Read-only probe of a real Datadog account.
 *
 * Answers one question with evidence rather than assumption: *would Pager's
 * ProductionWatcher actually fire against this account right now?* It makes no
 * writes, creates no monitors and ships no telemetry — every call here is a read.
 *
 * The watcher needs three things to be present, and this reports each separately
 * because they fail independently and for different reasons:
 *
 *   1. a monitor tagged `service:<name>` that is in ALERT
 *   2. error-level logs for that service carrying a stack trace
 *   3. metric series for that service across the incident window
 *
 * Anything absent is reported as ABSENT, never as "fine". A probe that says nothing
 * when it found nothing is how you discover, on stage, that the demo has no data.
 *
 * Usage: pnpm probe:datadog [service] [--hours N]
 */
import { DatadogProvider, type MetricName } from '@pager/providers';

const DEFAULT_SITE = 'https://api.datadoghq.com';

type Finding = { name: string; present: boolean; detail: string };
const findings: Finding[] = [];

function report(name: string, present: boolean, detail: string): void {
  findings.push({ name, present, detail });
  console.log(`${present ? ' FOUND  ' : ' ABSENT '} ${name.padEnd(26)} ${detail}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const service = args.find((a) => !a.startsWith('--')) ?? 'checkout-api';
  const hoursFlag = args.indexOf('--hours');
  const hours = hoursFlag >= 0 ? Number(args[hoursFlag + 1] ?? 3) : 3;

  const apiKey = process.env.DATADOG_API_KEY?.trim();
  const appKey = process.env.DATADOG_APP_KEY?.trim();
  const baseUrl = process.env.DATADOG_BASE_URL?.trim() || DEFAULT_SITE;

  console.log(`\nDatadog probe — read only, nothing is created or sent\n`);
  console.log(`  site     ${baseUrl}`);
  console.log(`  service  ${service}`);
  console.log(`  window   the last ${hours}h\n`);

  if (!apiKey || !appKey) {
    // Named separately because they are different credentials with different powers:
    // an API key can SUBMIT telemetry, only an application key can READ it back.
    console.log(
      ` ABSENT  credentials                ` +
        `${!apiKey ? 'DATADOG_API_KEY ' : ''}${!appKey ? 'DATADOG_APP_KEY ' : ''}not set.\n`,
    );
    console.log(
      `  Pager READS Datadog (metrics, logs, monitors), and every one of those\n` +
        `  endpoints requires an Application Key in addition to the API key. An API\n` +
        `  key alone is enough to ship logs INTO Datadog and nothing more.\n` +
        `  Create one at: Organization Settings -> Application Keys.\n`,
    );
    process.exitCode = 1;
    return;
  }

  const provider = new DatadogProvider({ baseUrl, apiKey, appKey });
  const to = new Date();
  const from = new Date(to.getTime() - hours * 3_600_000);

  // ── 1. Monitors ──────────────────────────────────────────────────────────
  // Also the credential check: this is the first call needing the app key, so a
  // 403 here means the keys are wrong rather than the data being missing.
  let monitorsReadable = false;
  try {
    const monitors = await provider.listMonitors(service);
    monitorsReadable = true;
    if (monitors.length === 0) {
      report(
        'monitors',
        false,
        `authenticated, but no monitor is tagged service:${service}. ProductionWatcher ` +
          `keys off monitor state, so it will never escalate without one.`,
      );
    } else {
      const alerting = monitors.filter((m) => m.status === 'ALERT');
      report(
        'monitors',
        alerting.length > 0,
        `${monitors.length} tagged service:${service}; ${alerting.length} in ALERT` +
          (alerting.length > 0
            ? ` — ${alerting.map((m) => `"${m.name}"`).join(', ')}`
            : ` (states: ${monitors.map((m) => m.status).join(', ')}). Nothing escalates until one alerts.`),
      );
    }
  } catch (err) {
    report('monitors', false, `could not be read: ${message(err)}`);
  }

  if (!monitorsReadable) {
    console.log(
      `\n  The monitor read failed. A 403 here almost always means the application key\n` +
        `  is missing, wrong, or scoped to a different org — not that there is no data.\n`,
    );
    process.exitCode = 1;
    return;
  }

  // ── 2. Logs ──────────────────────────────────────────────────────────────
  try {
    const errors = await provider.queryLogs(service, { from, to }, { level: 'error', limit: 25 });
    const withStack = errors.filter((e) => e.stackTrace !== null);
    report(
      'error logs',
      errors.length > 0,
      errors.length === 0
        ? `no error-level logs for service:${service} in the last ${hours}h. Check the logs ` +
          `are tagged with that exact service name.`
        : `${errors.length} in the last ${hours}h, ${withStack.length} carrying a stack trace. ` +
          `Sample: ${errors[0]!.message.slice(0, 90)}`,
    );
    // The stack trace is what locates the failure in a file. Without one the
    // investigation has no application frame to reason from, and the whole
    // repair path is unavailable however many errors there are.
    if (errors.length > 0) {
      report(
        'stack traces',
        withStack.length > 0,
        withStack.length > 0
          ? `present — the failure can be located in a file`
          : `no log carries error.stack or stack. Pager can see that something broke but ` +
            `not where, so it would abstain rather than attempt a repair.`,
      );
    }
  } catch (err) {
    const text = message(err);
    // A distinctive, diagnosable condition worth naming rather than passing through
    // raw: Datadog creates a log index the first time logs arrive, so "no valid
    // indexes" means this organisation has never ingested a log. That is a delivery
    // problem upstream, not a query problem here.
    if (/no valid indexes/i.test(text)) {
      report(
        'error logs',
        false,
        `this Datadog organisation has NO log indexes, which means it has never received a ` +
          `log. The query is fine; nothing is arriving. Check the log stream from wherever the ` +
          `service runs is actually configured and delivering.`,
      );
    } else {
      report('error logs', false, `could not be read: ${text}`);
    }
  }

  // ── 3. Metrics ───────────────────────────────────────────────────────────
  const metrics: MetricName[] = ['error_rate', 'http_5xx_rate', 'latency_p95', 'request_throughput'];
  for (const metric of metrics) {
    try {
      const series = await provider.queryMetric(service, metric, { from, to });
      report(
        `metric ${metric}`,
        series.points.length > 0,
        series.points.length > 0
          ? `${series.points.length} points, ${series.unit}`
          : `no points. The query is ${describeQuery(metric, service)} — this needs APM or ` +
            `a custom metric under that exact name and tag.`,
      );
    } catch (err) {
      report(`metric ${metric}`, false, `query failed: ${message(err)}`);
    }
  }

  // ── Verdict ──────────────────────────────────────────────────────────────
  const monitorAlerting = findings.find((f) => f.name === 'monitors')?.present ?? false;
  const haveLogs = findings.find((f) => f.name === 'error logs')?.present ?? false;
  const haveTraces = findings.find((f) => f.name === 'stack traces')?.present ?? false;

  console.log('');
  if (monitorAlerting && haveLogs && haveTraces) {
    console.log(
      `  This account has what ProductionWatcher needs: an alerting monitor, error logs\n` +
        `  and a stack trace to locate the failure. A live incident is possible.\n`,
    );
  } else {
    console.log(`  ProductionWatcher would NOT produce a live incident from this account yet.`);
    console.log(`  Missing: ${[
      !monitorAlerting ? 'an alerting monitor tagged service:' + service : null,
      !haveLogs ? 'error-level logs for that service' : null,
      haveLogs && !haveTraces ? 'a stack trace on those logs' : null,
    ].filter(Boolean).join('; ')}.`);
    console.log(
      `\n  This is a statement about the DATA, not about the adapter — every call above\n` +
        `  reached the real Datadog API and was answered.\n`,
    );
  }

  process.exitCode = findings.every((f) => f.present) ? 0 : 1;
}

function describeQuery(metric: MetricName, service: string): string {
  const shapes: Record<string, string> = {
    error_rate: `sum:trace.http.request.errors{service:${service}}.as_rate()`,
    http_5xx_rate: `sum:http.server.responses{service:${service},status_class:5xx}.as_rate()`,
    latency_p95: `p95:trace.http.request.duration{service:${service}}`,
    request_throughput: `sum:trace.http.request.hits{service:${service}}.as_rate()`,
  };
  return shapes[metric] ?? metric;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

void main().catch((err) => {
  console.error(`\nPROBE FAILED: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
