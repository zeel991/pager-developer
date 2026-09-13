# checkout-api architecture

CheckoutController validates the request body and delegates to CheckoutService.createOrder.

createOrder computes a subtotal, applies any discount, and returns an Order.

The OrderRequest contract is shared with the storefront, so widening a field there can
change what reaches createOrder at runtime without changing createOrder itself.
