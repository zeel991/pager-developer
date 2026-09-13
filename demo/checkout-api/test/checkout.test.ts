import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CheckoutService } from '../src/checkout/service.ts';

/**
 * The suite as it existed when the bad change shipped.
 *
 * Every case supplies a discount code, so none of them exercise the path that
 * breaks in production. That is why the deployment passed CI — and why reproducing
 * this incident requires writing a NEW test, not running the existing ones.
 */
describe('CheckoutService', () => {
  const service = new CheckoutService();

  it('applies a percentage discount', () => {
    const order = service.createOrder({
      customerId: 'cus_1',
      items: [{ sku: 'A', quantity: 2, unitPriceCents: 1000 }],
      discountCode: { value: 'SAVE10', percentOff: 10 },
    });
    assert.equal(order.subtotalCents, 2000);
    assert.equal(order.discountCents, 200);
    assert.equal(order.totalCents, 1800);
    assert.equal(order.appliedCode, 'SAVE10');
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
    assert.equal(order.subtotalCents, 1250);
    assert.equal(order.totalCents, 1000);
  });
});
