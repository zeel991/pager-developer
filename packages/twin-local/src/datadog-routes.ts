import type { Route } from './router.js';

/**
 * Datadog API surface.
 *
 * Returns real Datadog response shapes, including the quirks the adapter already
 * handles: pointlists as [epochMillis, value] pairs with nulls for gaps, and the
 * 200-with-error-payload case a query can produce.
 */

/** Extract `service:foo` from a Datadog query string. */
function serviceFromQuery(query: string): string | null {
  return /service:([A-Za-z0-9_.-]+)/.exec(query)?.[1] ?? null;
}

/** Map a Datadog query back to the metric name the scenario seeded. */
function metricFromQuery(query: string): string | null {
  if (query.includes('errors')) return 'error_rate';
  if (query.includes('status_class:5xx')) return 'http_5xx_rate';
  if (query.includes('request.hits')) return 'request_throughput';
  if (query.includes('p50:')) return 'latency_p50';
  if (query.includes('p95:')) return 'latency_p95';
  if (query.includes('p99:')) return 'latency_p99';
  if (query.includes('availability')) return 'availability';
  if (query.includes('cpu')) return 'cpu_utilization';
  if (query.includes('mem')) return 'memory_utilization';
  return null;
}

export function datadogRoutes(): Route[] {
  return [
    {
      method: 'GET',
      pattern: /^\/api\/v1\/query$/,
      handler: (ctx) => {
        const query = ctx.query.query ?? '';
        const from = Number(ctx.query.from ?? 0) * 1000;
        const to = Number(ctx.query.to ?? 0) * 1000;
        const service = serviceFromQuery(query);
        const metric = metricFromQuery(query);

        if (!service || !metric) {
          // Datadog answers 200 with an error payload for a malformed query.
          return { status: 200, body: { status: 'error', error: `Invalid query: ${query}` } };
        }

        const series = ctx.state.metrics.find((s) => s.service === service && s.metric === metric);
        if (!series) return { status: 200, body: { status: 'ok', series: [] } };

        const points = series.points
          .filter((p) => p.at >= from && p.at <= to)
          .map((p) => [p.at, p.value]);
        return {
          status: 200,
          body: {
            status: 'ok',
            series: [{ metric, pointlist: points, unit: [{ name: series.unit }], scope: `service:${service}` }],
          },
        };
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/v2\/logs\/events\/search$/,
      handler: (ctx) => {
        const body = ctx.json as {
          filter?: { query?: string; from?: string; to?: string };
          page?: { limit?: number };
        };
        const query = body.filter?.query ?? '';
        const service = serviceFromQuery(query);
        const from = body.filter?.from ? Date.parse(body.filter.from) : 0;
        const to = body.filter?.to ? Date.parse(body.filter.to) : Number.MAX_SAFE_INTEGER;
        const level = /status:([a-z]+)/.exec(query)?.[1];

        const matched = ctx.state.logs
          .filter((l) => (!service || l.service === service) && l.at >= from && l.at <= to)
          .filter((l) => !level || l.level === level)
          .slice(0, body.page?.limit ?? 100);

        return {
          status: 200,
          body: {
            data: matched.map((l, i) => ({
              id: `log-${i}`,
              type: 'log',
              attributes: {
                timestamp: new Date(l.at).toISOString(),
                status: l.level,
                message: l.message,
                service: l.service,
                attributes: { ...l.attributes, ...(l.stack ? { error: { stack: l.stack } } : {}) },
              },
            })),
          },
        };
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/v1\/monitor$/,
      handler: (ctx) => {
        const tag = ctx.query.tags ?? '';
        const service = tag.replace(/^service:/, '');
        return {
          status: 200,
          body: ctx.state.monitors
            .filter((m) => !service || m.service === service)
            .map((m) => ({
              id: m.id,
              name: m.name,
              overall_state: m.state,
              query: m.query,
              tags: [`service:${m.service}`],
              overall_state_modified: m.transitionedAt,
            })),
        };
      },
    },
  ];
}
