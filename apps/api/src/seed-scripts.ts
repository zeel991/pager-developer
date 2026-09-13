/**
 * Patches supplied to the scripted generator when seeding.
 *
 * These exist to exercise the pipeline around code authorship so the dashboard has
 * a complete incident to show. They are NOT the agent solving anything: every
 * proposal is tagged `scripted` and that tag reaches the PR body and the UI. When a
 * model is configured, this file stops being used.
 */

const PATCHED_CHECKOUT_SERVICE = `import type { OrderRequest } from './types.ts';

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

    const code = request.discountCode ?? null;
    const discountCents = code ? Math.round(subtotalCents * (code.percentOff / 100)) : 0;

    return {
      customerId: request.customerId,
      subtotalCents,
      discountCents,
      totalCents: subtotalCents - discountCents,
      appliedCode: code ? code.value : null,
    };
  }
}
`;

const REGRESSION_TEST = `import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CheckoutService } from '../src/checkout/service.ts';

describe('checkout regression', () => {
  it('creates an order when no discount code is supplied', () => {
    const order = new CheckoutService().createOrder({
      customerId: 'cus_9',
      items: [{ sku: 'A', quantity: 1, unitPriceCents: 1000 }],
    });
    assert.equal(order.discountCents, 0);
    assert.equal(order.totalCents, 1000);
    assert.equal(order.appliedCode, null);
  });
});
`;

export interface SeedScript {
  regressionTest?: { path: string; source: string; rationale?: string };
  patch?: {
    rootCause: string;
    explanation: string;
    files: { path: string; content: string }[];
    risks: string[];
    rollbackPlan: string;
    confidence: number;
  };
}

export const SCRIPTS: Record<string, SeedScript> = {
  'INC-001': {
    regressionTest: { path: 'test/regression-checkout.test.ts', source: REGRESSION_TEST },
    patch: {
      rootCause:
        'createOrder dereferenced request.discountCode without a null check after PR #377 ' +
        'widened the field to optional.',
      explanation: 'Guard the optional discount code instead of dereferencing it.',
      files: [{ path: 'src/checkout/service.ts', content: PATCHED_CHECKOUT_SERVICE }],
      risks: ['Touches a contract shared with the storefront.'],
      rollbackPlan: 'Revert the merge commit. checkout-api holds no migration state.',
      confidence: 0.91,
    },
  },
};
