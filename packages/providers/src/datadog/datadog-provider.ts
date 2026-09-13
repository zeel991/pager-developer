import type { Environment } from '@pager/core';
import { Http } from '../http.js';
import type {
  LogEntry,
  MetricName,
  MetricSeries,
  MonitorState,
  ObservabilityProvider,
  TimeRange,
} from '../types.js';

/**
 * Datadog observability adapter.
 *
 * Written against the real Datadog API (v1 query/monitors, v2 log search), so the
 * same class serves an Arga Datadog twin and api.datadoghq.com.
 *
 * Telemetry only ever originates here, from an HTTP response. There is no code path
 * by which a reasoning model can introduce a metric point or a log line — fabricated
 * telemetry is prevented by construction, not by instruction.
 */

const METRIC_QUERIES: Record<MetricName, (service: string) => string> = {
  error_rate: (s) => `sum:trace.http.request.errors{service:${s}}.as_rate()`,
  http_5xx_rate: (s) => `sum:http.server.responses{service:${s},status_class:5xx}.as_rate()`,
  request_throughput: (s) => `sum:trace.http.request.hits{service:${s}}.as_rate()`,
  latency_p50: (s) => `p50:trace.http.request.duration{service:${s}}`,
  latency_p95: (s) => `p95:trace.http.request.duration{service:${s}}`,
  latency_p99: (s) => `p99:trace.http.request.duration{service:${s}}`,
  availability: (s) => `avg:synthetics.http.availability{service:${s}}`,
  cpu_utilization: (s) => `avg:system.cpu.user{service:${s}}`,
  memory_utilization: (s) => `avg:system.mem.pct_usable{service:${s}}`,
};

const METRIC_UNITS: Record<MetricName, string> = {
  error_rate: 'ratio',
  http_5xx_rate: 'ratio',
  request_throughput: 'requests/s',
  latency_p50: 'ms',
  latency_p95: 'ms',
  latency_p99: 'ms',
  availability: 'ratio',
  cpu_utilization: 'ratio',
  memory_utilization: 'ratio',
};

interface DdQueryResponse {
  series?: { metric: string; pointlist: [number, number | null][]; unit?: { name: string }[] }[];
  status?: string;
  error?: string;
}

interface DdLogsResponse {
  data?: {
    attributes?: {
      timestamp?: string;
      status?: string;
      message?: string;
      service?: string;
      attributes?: Record<string, unknown>;
    };
  }[];
}

interface DdMonitor {
  id: number;
  name: string;
  overall_state?: string;
  query?: string;
  tags?: string[];
  overall_state_modified?: string;
}

const LOG_LEVELS: Record<string, LogEntry['level']> = {
  debug: 'debug',
  info: 'info',
  warn: 'warn',
  warning: 'warn',
  error: 'error',
  critical: 'fatal',
  emergency: 'fatal',
  fatal: 'fatal',
};

const MONITOR_STATES: Record<string, MonitorState['status']> = {
  OK: 'OK',
  Warn: 'WARN',
  Alert: 'ALERT',
  'No Data': 'NO_DATA',
};

export interface DatadogProviderOptions {
  baseUrl: string;
  apiKey?: string;
  appKey?: string;
  environment?: Environment;
  fetchImpl?: typeof globalThis.fetch;
}

export class DatadogProvider implements ObservabilityProvider {
  readonly kind = 'observability' as const;
  private readonly http: Http;
  private readonly environment: Environment;

  constructor(opts: DatadogProviderOptions) {
    this.environment = opts.environment ?? 'production';
    this.http = new Http({
      baseUrl: opts.baseUrl,
      headers: {
        ...(opts.apiKey ? { 'dd-api-key': opts.apiKey } : {}),
        ...(opts.appKey ? { 'dd-application-key': opts.appKey } : {}),
      },
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    });
  }

  async queryMetric(service: string, metric: MetricName, range: TimeRange): Promise<MetricSeries> {
    const res = await this.http.get<DdQueryResponse>('/api/v1/query', {
      from: Math.floor(range.from.getTime() / 1000),
      to: Math.floor(range.to.getTime() / 1000),
      query: METRIC_QUERIES[metric](service),
    });

    // A Datadog query can return 200 with an error payload. Treating that as an
    // empty series would silently manufacture "no regression", so it must throw.
    if (res.error) {
      throw new Error(`Datadog query failed for ${metric} on ${service}: ${res.error}`);
    }

    const points = (res.series?.[0]?.pointlist ?? [])
      // Datadog emits null for gaps. Dropping them keeps a gap a gap, rather than
      // letting it read as a zero and invent a recovery or a regression.
      .filter((p): p is [number, number] => p[1] !== null)
      .map(([ts, value]) => ({ at: new Date(ts), value }));

    return {
      metric,
      service,
      environment: this.environment,
      points,
      unit: res.series?.[0]?.unit?.[0]?.name ?? METRIC_UNITS[metric],
    };
  }

  async queryLogs(
    service: string,
    range: TimeRange,
    opts: { level?: LogEntry['level']; query?: string; limit?: number } = {},
  ): Promise<LogEntry[]> {
    const filters = [`service:${service}`];
    if (opts.level) filters.push(`status:${opts.level}`);
    if (opts.query) filters.push(opts.query);

    const res = await this.http.post<DdLogsResponse>('/api/v2/logs/events/search', {
      filter: {
        query: filters.join(' '),
        from: range.from.toISOString(),
        to: range.to.toISOString(),
      },
      page: { limit: opts.limit ?? 100 },
      sort: 'timestamp',
    });

    return (res.data ?? []).map((d) => {
      const a = d.attributes ?? {};
      const nested = a.attributes ?? {};
      return {
        at: a.timestamp ? new Date(a.timestamp) : new Date(0),
        service: a.service ?? service,
        level: LOG_LEVELS[(a.status ?? 'info').toLowerCase()] ?? 'info',
        message: a.message ?? '',
        stackTrace: extractStack(nested),
        attributes: nested,
      };
    });
  }

  async listMonitors(service: string): Promise<MonitorState[]> {
    const res = await this.http.get<DdMonitor[]>('/api/v1/monitor', { tags: `service:${service}` });
    return (res ?? []).map((m) => ({
      id: String(m.id),
      name: m.name,
      status: MONITOR_STATES[m.overall_state ?? ''] ?? 'NO_DATA',
      service,
      query: m.query ?? '',
      transitionedAt: m.overall_state_modified ? new Date(m.overall_state_modified) : null,
    }));
  }
}

function extractStack(attrs: Record<string, unknown>): string | null {
  const err = attrs.error;
  if (err && typeof err === 'object' && 'stack' in err) {
    const stack = (err as { stack?: unknown }).stack;
    if (typeof stack === 'string') return stack;
  }
  return typeof attrs.stack === 'string' ? attrs.stack : null;
}
