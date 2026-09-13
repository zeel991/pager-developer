# Runbook: checkout-api

Owner: payments-team. Tier 1 service. Handles POST /checkout.

## Rollback

Redeploy the previous release tag. Rollback is safe: checkout-api holds no migration state.

## Known failure modes

- Upstream payment gateway 503s surface as PaymentGatewayError with frames inside
  @acme/payments-sdk. These are NOT caused by our deployments and cannot be fixed by
  rolling back.

## Escalation

Page the payments on-call. Do not modify the production database under any circumstances.
