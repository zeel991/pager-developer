import type { ScenarioFixture } from '../seed.js';

/**
 * INC-009 — a third-party payment API outage. The deployment is innocent.
 *
 * Everything that would make a naive system blame the deploy is present: a real
 * regression, a recent deployment, an alerting monitor. What exonerates the
 * deployment is only visible on inspection:
 *
 *  - the deployed commit touches documentation only, no application code
 *  - errors begin 21 minutes AFTER the deploy, not immediately
 *  - every stack frame is inside node_modules, none in application code
 *
 * A system that scores well on INC-001 and blames the deploy here is worse than
 * useless, because it will send engineers to revert innocent changes during an
 * outage they cannot fix that way.
 */

const README_BEFORE = `# checkout-api

Checkout service for the storefront.
`;

const README_AFTER = `# checkout-api

Checkout service for the storefront.

## Local development

Run \`npm test\` to execute the suite. See docs/runbook.md for operational guidance.
`;

const RUNBOOK = `# Runbook

Escalate to the payments on-call for upstream gateway failures.
`;

const SERVICE = `import type { OrderRequest } from './types.ts';

export class CheckoutService {
  async createOrder(request: OrderRequest) {
    const subtotalCents = request.items.reduce(
      (sum, item) => sum + item.unitPriceCents * item.quantity,
      0,
    );
    // Delegates to the upstream payment gateway via the vendor SDK.
    const authorization = await this.gateway.authorize(subtotalCents);
    return { customerId: request.customerId, subtotalCents, authorization };
  }
}
`;

const STACK_TRACE = `PaymentGatewayError: upstream returned 503 Service Unavailable
    at PaymentsClient.request (/app/node_modules/@acme/payments-sdk/dist/client.js:212:15)
    at PaymentsClient.authorize (/app/node_modules/@acme/payments-sdk/dist/client.js:88:20)
    at processTicksAndRejections (node:internal/process/task_queues:95:5)`;

export const INC_009: ScenarioFixture = {
  id: 'INC-009',
  repository: 'acme/checkout-api',
  description: 'Checkout API service',
  service: 'checkout-api',
  defaultBranch: 'main',
  windowFrom: '2026-09-13T14:00:00Z',
  windowTo: '2026-09-13T15:30:00Z',
  deployedAt: '2026-09-13T14:31:00Z',

  commits: [
    {
      message: 'Initial checkout service',
      author: 'Priya',
      at: '2026-09-10T09:00:00Z',
      changes: [
        { path: 'package.json', content: '{\n  "name": "checkout-api",\n  "type": "module",\n  "scripts": { "test": "node --test" }\n}\n' },
        { path: 'src/checkout/service.ts', content: SERVICE },
        { path: 'README.md', content: README_BEFORE },
      ],
    },
    {
      message: 'Document local development setup',
      author: 'Sam',
      at: '2026-09-13T14:25:00Z',
      branch: 'docs/local-dev',
      changes: [
        { path: 'README.md', content: README_AFTER },
        { path: 'docs/runbook.md', content: RUNBOOK },
      ],
    },
    {
      message: 'Merge pull request #391 from acme/docs/local-dev',
      author: 'Sam',
      at: '2026-09-13T14:30:00Z',
      branch: 'main',
      mergeOf: 'docs/local-dev',
      changes: [],
    },
  ],

  pullRequests: [
    {
      number: 391,
      title: 'Document local development setup',
      body: 'Documentation only. No functional change.',
      headRef: 'docs/local-dev',
      baseRef: 'main',
      mergedAtCommit: 'Merge pull request #391 from acme/docs/local-dev',
    },
  ],

  metrics: [
    // Onset is 21 minutes after the deployment, not at it. That gap is the
    // strongest timing evidence against attribution.
    { service: 'checkout-api', metric: 'error_rate', unit: 'ratio', baseline: 0.004, after: 0.14, onsetAt: '2026-09-13T14:52:00Z', jitter: 0.08 },
    { service: 'checkout-api', metric: 'http_5xx_rate', unit: 'ratio', baseline: 0.003, after: 0.137, onsetAt: '2026-09-13T14:52:00Z', jitter: 0.08 },
    // Latency rises too: the upstream is timing out before failing.
    { service: 'checkout-api', metric: 'latency_p95', unit: 'ms', baseline: 180, after: 2400, onsetAt: '2026-09-13T14:52:00Z', jitter: 0.06 },
    { service: 'checkout-api', metric: 'latency_p50', unit: 'ms', baseline: 64, after: 410, onsetAt: '2026-09-13T14:52:00Z', jitter: 0.05 },
    { service: 'checkout-api', metric: 'request_throughput', unit: 'requests/s', baseline: 240, after: 236, jitter: 0.03 },
    { service: 'checkout-api', metric: 'availability', unit: 'ratio', baseline: 0.9996, after: 0.86, onsetAt: '2026-09-13T14:52:00Z', jitter: 0.001 },
  ],

  logs: [
    {
      service: 'checkout-api',
      level: 'error',
      message: 'PaymentGatewayError: upstream returned 503 Service Unavailable',
      stack: STACK_TRACE,
      from: '2026-09-13T14:52:00Z',
      count: 30,
      intervalSeconds: 40,
      attributes: { 'http.route': 'POST /checkout', 'http.status_code': 502, 'upstream.host': 'api.payments.example.com' },
    },
    {
      service: 'checkout-api',
      level: 'info',
      message: 'checkout completed',
      from: '2026-09-13T14:05:00Z',
      count: 20,
      intervalSeconds: 120,
    },
  ],

  monitors: [
    {
      name: 'payments upstream availability',
      service: 'checkout-api',
      query: 'avg(last_5m):avg:synthetics.http.availability{service:checkout-api} < 0.95',
      state: 'Alert',
      transitionedAt: '2026-09-13T14:52:00Z',
    },
    {
      name: 'checkout-api error rate',
      service: 'checkout-api',
      query: 'avg(last_5m):sum:trace.http.request.errors{service:checkout-api}.as_rate() > 0.05',
      state: 'Alert',
      transitionedAt: '2026-09-13T14:54:00Z',
    },
  ],

  slackChannels: ['#incidents', '#checkout-team'],

  pages: [
    {
      id: 'runbook-checkout',
      title: 'Runbook: checkout-api',
      content: [
        '# Runbook: checkout-api',
        'Owner: payments-team. Tier 1 service.',
        '## Known failure modes',
        '- Upstream payment gateway 503s surface as PaymentGatewayError with frames inside ' +
          '@acme/payments-sdk. These are NOT caused by our deployments and cannot be fixed by rolling back.',
        '## Escalation',
        'For upstream gateway failures, page the payments vendor. Do not revert application deploys.',
      ].join('\n\n'),
    },
  ],
};
