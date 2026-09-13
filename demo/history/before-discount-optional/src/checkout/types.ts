export interface DiscountCode {
  value: string;
  percentOff: number;
}

export interface OrderRequest {
  customerId: string;
  items: { sku: string; quantity: number; unitPriceCents: number }[];
  discountCode: DiscountCode;
}
