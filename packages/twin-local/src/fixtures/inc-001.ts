import type { ScenarioFixture } from '../seed.js';

/**
 * INC-001 — a deployment introduces a null dereference in checkout.
 *
 * The code here is real and the bug is real: commit B widens `discountCode` to
 * optional in `types.ts` while `service.ts` continues to dereference `.value`
 * unconditionally. The seeded test suite passes at commit A and still passes at
 * commit B (the existing tests never exercise the missing-discount path), which is
 * exactly why the bug reached production — and exactly what makes this a fair test
 * of reproduction: Pager must write a *new* failing test, not just run the old ones.
 */

const TYPES_BEFORE = `export interface DiscountCode {
  value: string;
  percentOff: number;
}

export interface OrderRequest {
  customerId: string;
  items: { sku: string; quantity: number; unitPriceCents: number }[];
  discountCode: DiscountCode;
}
`;

const TYPES_AFTER = `export interface DiscountCode {
  value: string;
  percentOff: number;
}

export interface OrderRequest {
  customerId: string;
  items: { sku: string; quantity: number; unitPriceCents: number }[];
  // Widened in PR #377: checkout may now be submitted without a discount code.
  discountCode?: DiscountCode | null;
}
`;

const SERVICE_BEFORE = `import type { OrderRequest } from './types.js';

export interface Order {
  customerId: string;
  subtotalCents: number;
  discountCents: number;
  totalCents: number;
  appliedCode: string | null;
}

export class CheckoutService {
  createOrder(request: OrderRequest): Order {
    const subtotalCents = request.items.reduce(
      (sum, item) => sum + item.unitPriceCents * item.quantity,
      0,
    );

    const code = request.discountCode;
    const discountCents = Math.round(subtotalCents * (code.percentOff / 100));

    return {
      customerId: request.customerId,
      subtotalCents,
      discountCents,
      totalCents: subtotalCents - discountCents,
      appliedCode: code.value,
    };
  }
}
`;

// Identical to SERVICE_BEFORE. The deployment did not touch service.ts at all —
// it only widened the type — which is what makes attribution interesting: the
// failing line is unchanged, and only the contract around it moved.
const SERVICE_AFTER = SERVICE_BEFORE;

const EXISTING_TEST = `import { describe, expect, it } from 'vitest';
import { CheckoutService } from '../src/checkout/service.js';

describe('CheckoutService', () => {
  const service = new CheckoutService();

  it('applies a percentage discount', () => {
    const order = service.createOrder({
      customerId: 'cus_1',
      items: [{ sku: 'A', quantity: 2, unitPriceCents: 1000 }],
      discountCode: { value: 'SAVE10', percentOff: 10 },
    });
    expect(order.subtotalCents).toBe(2000);
    expect(order.discountCents).toBe(200);
    expect(order.totalCents).toBe(1800);
    expect(order.appliedCode).toBe('SAVE10');
  });

  it('sums multiple line items', () => {
    const order = service.createOrder({
      customerId: 'cus_2',
      items: [
        { sku: 'A', quantity: 1, unitPriceCents: 500 },
        { sku: 'B', quantity: 3, unitPriceCents: 250 },
      ],
      discountCode: { value: 'SAVE20', percentOff: 20 },
    });
    expect(order.subtotalCents).toBe(1250);
    expect(order.totalCents).toBe(1000);
  });
});
`;

const PACKAGE_JSON = `{
  "name": "checkout-api",
  "version": "1.4.2",
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "lint": "eslint .",
    "typecheck": "tsc --noEmit",
    "build": "tsc -p tsconfig.json"
  },
  "devDependencies": {
    "typescript": "^5.9.2",
    "vitest": "^3.2.4"
  }
}
`;

const TSCONFIG = `{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true
  },
  "include": ["src", "test"]
}
`;

const VITEST_CONFIG = `import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['test/**/*.test.ts'], environment: 'node' },
});
`;

const STACK_TRACE = `TypeError: Cannot read properties of null (reading 'percentOff')
    at CheckoutService.createOrder (/app/src/checkout/service.ts:20:52)
    at CheckoutController.postCheckout (/app/src/checkout/controller.ts:34:38)
    at processTicksAndRejections (node:internal/process/task_queues:95:5)`;

export const INC_001: ScenarioFixture = {
  id: 'INC-001',
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
        { path: 'package.json', content: PACKAGE_JSON },
        { path: 'tsconfig.json', content: TSCONFIG },
        { path: 'vitest.config.ts', content: VITEST_CONFIG },
        { path: 'src/checkout/types.ts', content: TYPES_BEFORE },
        { path: 'src/checkout/service.ts', content: SERVICE_BEFORE },
        { path: 'test/checkout.test.ts', content: EXISTING_TEST },
      ],
    },
    {
      message: 'Make discount code optional at checkout',
      author: 'Dana',
      at: '2026-09-13T14:20:00Z',
      branch: 'feat/optional-discount',
      changes: [
        { path: 'src/checkout/types.ts', content: TYPES_AFTER },
        { path: 'src/checkout/service.ts', content: SERVICE_AFTER },
      ],
    },
    {
      message: 'Merge pull request #377 from acme/feat/optional-discount',
      author: 'Dana',
      at: '2026-09-13T14:29:00Z',
      branch: 'main',
      mergeOf: 'feat/optional-discount',
      changes: [],
    },
  ],

  pullRequests: [
    {
      number: 377,
      title: 'Make discount code optional at checkout',
      body:
        'Customers without a promo code were being blocked at checkout. This widens ' +
        '`OrderRequest.discountCode` to be optional so the field can be omitted.',
      headRef: 'feat/optional-discount',
      baseRef: 'main',
      mergedAtCommit: 'Merge pull request #377 from acme/feat/optional-discount',
    },
  ],

  metrics: [
    { service: 'checkout-api', metric: 'error_rate', unit: 'ratio', baseline: 0.004, after: 0.178, jitter: 0.08 },
    { service: 'checkout-api', metric: 'http_5xx_rate', unit: 'ratio', baseline: 0.003, after: 0.171, jitter: 0.08 },
    // Latency and throughput stay flat: this is a correctness failure, not
    // saturation, and a detector that blames latency here is wrong.
    { service: 'checkout-api', metric: 'latency_p95', unit: 'ms', baseline: 182, after: 179, jitter: 0.04 },
    { service: 'checkout-api', metric: 'latency_p50', unit: 'ms', baseline: 64, after: 63, jitter: 0.04 },
    { service: 'checkout-api', metric: 'request_throughput', unit: 'requests/s', baseline: 240, after: 238, jitter: 0.03 },
    { service: 'checkout-api', metric: 'availability', unit: 'ratio', baseline: 0.9996, after: 0.9994, jitter: 0.0002 },
  ],

  logs: [
    {
      service: 'checkout-api',
      level: 'error',
      message: "TypeError: Cannot read properties of null (reading 'percentOff')",
      stack: STACK_TRACE,
      from: '2026-09-13T14:32:00Z',
      count: 24,
      intervalSeconds: 45,
      attributes: { 'http.route': 'POST /checkout', 'http.status_code': 500 },
    },
    {
      service: 'checkout-api',
      level: 'info',
      message: 'checkout completed',
      from: '2026-09-13T14:05:00Z',
      count: 12,
      intervalSeconds: 120,
    },
  ],

  monitors: [
    {
      name: 'checkout-api error rate',
      service: 'checkout-api',
      query: 'avg(last_5m):sum:trace.http.request.errors{service:checkout-api}.as_rate() > 0.05',
      state: 'Alert',
      transitionedAt: '2026-09-13T14:34:00Z',
    },
    {
      name: 'checkout-api p95 latency',
      service: 'checkout-api',
      query: 'avg(last_5m):p95:trace.http.request.duration{service:checkout-api} > 800',
      state: 'OK',
      transitionedAt: null,
    },
  ],

  slackChannels: ['#incidents', '#checkout-team'],

  pages: [
    {
      id: 'runbook-checkout',
      title: 'Runbook: checkout-api',
      content: [
        '# Runbook: checkout-api',
        'Owner: payments-team. Tier 1 service. Handles POST /checkout.',
        '## Rollback',
        'Redeploy the previous release tag. Rollback is safe: checkout-api holds no migration state.',
        '## Known failure modes',
        '- Upstream payment gateway 503s surface as PaymentGatewayError and are NOT caused by our deploys.',
        '- Null dereferences in createOrder have historically followed changes to the OrderRequest contract.',
        '## Escalation',
        'Page the payments on-call. Do not modify the production database under any circumstances.',
      ].join('\n\n'),
    },
    {
      id: 'doc-checkout-arch',
      title: 'checkout-api architecture',
      content: [
        '# checkout-api architecture',
        'CheckoutController validates the request body and delegates to CheckoutService.createOrder.',
        'createOrder computes a subtotal, applies any discount, and returns an Order.',
        'The OrderRequest contract is shared with the storefront, so widening a field there can ' +
          'change what reaches createOrder at runtime without changing createOrder itself.',
      ].join('\n\n'),
    },
  ],
};
