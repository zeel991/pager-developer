export interface DiscountCode {
  value: string;
  percentOff: number;
}

export interface OrderRequest {
  customerId: string;
  items: { sku: string; quantity: number; unitPriceCents: number }[];
  // Widened in PR #377: checkout may now be submitted without a discount code.
  discountCode?: DiscountCode | null;
}
