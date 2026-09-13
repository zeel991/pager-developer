import type { ScenarioFixture } from '../seed.js';

/**
 * INC-011 — a misconfigured monitor. Production is healthy.
 *
 * The only abnormal signal is the monitor itself. Every metric sits inside its
 * normal band, there are no error logs, and the deployment is unremarkable.
 *
 * The correct outcome is FALSE_POSITIVE with no pull request opened. This is the
 * scenario that catches a system which treats an alerting monitor as proof of a
 * problem, and it is the one most likely to produce unnecessary 3 AM pages in real
 * life.
 */

const SERVICE = `import type { OrderRequest } from './types.ts';

export class CheckoutService {
  createOrder(request: OrderRequest) {
    const subtotalCents = request.items.reduce(
      (sum, item) => sum + item.unitPriceCents * item.quantity,
      0,
    );
    return { customerId: request.customerId, subtotalCents };
  }
}
`;

export const INC_011: ScenarioFixture = {
  id: 'INC-011',
  repository: 'acme/checkout-api',
  description: 'Checkout API service',
  service: 'checkout-api',
  defaultBranch: 'main',
  windowFrom: '2026-09-13T14:00:00Z',
  windowTo: '2026-09-13T15:00:00Z',
  deployedAt: '2026-09-13T14:31:00Z',

  commits: [
    {
      message: 'Initial checkout service',
      author: 'Priya',
      at: '2026-09-10T09:00:00Z',
      changes: [
        { path: 'package.json', content: '{\n  "name": "checkout-api",\n  "type": "module",\n  "scripts": { "test": "node --test" }\n}\n' },
        { path: 'src/checkout/service.ts', content: SERVICE },
      ],
    },
    {
      message: 'Add request id to structured logs',
      author: 'Ravi',
      at: '2026-09-13T14:26:00Z',
      branch: 'chore/log-request-id',
      changes: [
        { path: 'src/logging.ts', content: 'export const withRequestId = (id: string) => ({ requestId: id });\n' },
      ],
    },
    {
      message: 'Merge pull request #402 from acme/chore/log-request-id',
      author: 'Ravi',
      at: '2026-09-13T14:30:00Z',
      branch: 'main',
      mergeOf: 'chore/log-request-id',
      changes: [],
    },
  ],

  pullRequests: [
    {
      number: 402,
      title: 'Add request id to structured logs',
      body: 'Adds a request id field to log context.',
      headRef: 'chore/log-request-id',
      baseRef: 'main',
      mergedAtCommit: 'Merge pull request #402 from acme/chore/log-request-id',
    },
  ],

  // Every metric is flat and healthy across the whole window. Nothing regressed.
  metrics: [
    { service: 'checkout-api', metric: 'error_rate', unit: 'ratio', baseline: 0.004, after: 0.0042, jitter: 0.09 },
    { service: 'checkout-api', metric: 'http_5xx_rate', unit: 'ratio', baseline: 0.003, after: 0.0031, jitter: 0.09 },
    { service: 'checkout-api', metric: 'latency_p95', unit: 'ms', baseline: 181, after: 179, jitter: 0.05 },
    { service: 'checkout-api', metric: 'latency_p50', unit: 'ms', baseline: 63, after: 64, jitter: 0.05 },
    { service: 'checkout-api', metric: 'request_throughput', unit: 'requests/s', baseline: 240, after: 243, jitter: 0.04 },
    { service: 'checkout-api', metric: 'availability', unit: 'ratio', baseline: 0.9997, after: 0.9996, jitter: 0.0002 },
  ],

  // No error logs at all. Healthy traffic only.
  logs: [
    {
      service: 'checkout-api',
      level: 'info',
      message: 'checkout completed',
      from: '2026-09-13T14:02:00Z',
      count: 40,
      intervalSeconds: 60,
    },
  ],

  monitors: [
    {
      // The threshold compares an absolute count, not a rate. Normal traffic
      // produces more than five errors a minute at a perfectly healthy 0.4%, so
      // this fires continuously while nothing is wrong.
      name: 'checkout-api error rate',
      service: 'checkout-api',
      query: 'sum(last_5m):sum:trace.http.request.errors{service:checkout-api} > 5',
      state: 'Alert',
      transitionedAt: '2026-09-13T14:33:00Z',
    },
    {
      name: 'checkout-api p95 latency',
      service: 'checkout-api',
      query: 'avg(last_5m):p95:trace.http.request.duration{service:checkout-api} > 800',
      state: 'OK',
      transitionedAt: null,
    },
  ],

  slackChannels: ['#incidents'],

  pages: [
    {
      id: 'runbook-monitors',
      title: 'Runbook: monitor conventions',
      content: [
        '# Runbook: monitor conventions',
        'Error monitors MUST alert on a rate, never an absolute count. At normal traffic ' +
          'a healthy 0.4% error rate still produces several errors per minute, so a count ' +
          'threshold will alert continuously while the service is fine.',
        '## Before opening an incident',
        'Confirm the underlying metric actually moved. A monitor in Alert with flat ' +
          'telemetry is a monitor bug, not a production incident.',
      ].join('\n\n'),
    },
  ],
};
