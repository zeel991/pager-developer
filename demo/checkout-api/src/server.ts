import { createServer } from 'node:http';
import { CheckoutService } from './checkout/service.ts';
import type { OrderRequest } from './checkout/types.ts';

const port = Number(process.env.PORT ?? 4101);
const service = new CheckoutService();

const server = createServer(async (request, response) => {
  const started = Date.now();
  const path = new URL(request.url ?? '/', 'http://localhost').pathname;
  let status = 200;

  const send = (code: number, body: unknown) => {
    status = code;
    response.writeHead(code, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  };

  try {
    if (request.method === 'GET' && path === '/health') {
      send(200, { status: 'ok', service: 'checkout-api' });
      return;
    }
    if (request.method !== 'POST' || path !== '/orders') {
      send(404, { error: 'not_found' });
      return;
    }

    let raw = '';
    for await (const chunk of request) {
      raw += chunk;
      if (raw.length > 64_000) {
        send(413, { error: 'payload_too_large' });
        return;
      }
    }
    let input: OrderRequest;
    try {
      input = JSON.parse(raw) as OrderRequest;
    } catch {
      send(400, { error: 'invalid_json' });
      return;
    }
    if (!input || typeof input.customerId !== 'string' || !Array.isArray(input.items)) {
      send(400, { error: 'invalid_order' });
      return;
    }
    send(201, service.createOrder(input));
  } catch (error) {
    status = 500;
    console.error(JSON.stringify({
      timestamp: new Date().toISOString(),
      service: 'checkout-api',
      env: process.env.DD_ENV ?? 'hackathon',
      // `status` is Datadog's RESERVED attribute for log level, not for an HTTP
      // code. Emitting the number here made every error log land as `info`, so a
      // search for status:error returned nothing while the errors were plainly
      // there. The HTTP code keeps its own field.
      status: 'error',
      http_status: status,
      route: path,
      error: error instanceof Error ? error.name : 'UnknownError',
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    }));
    send(500, { error: 'checkout_failed' });
  } finally {
    console.log(JSON.stringify({
      timestamp: new Date().toISOString(),
      service: 'checkout-api',
      env: process.env.DD_ENV ?? 'hackathon',
      status: status >= 500 ? 'error' : 'info',
      http_status: status,
      route: path,
      method: request.method,
      duration_ms: Date.now() - started,
    }));
  }
});

server.listen(port, '0.0.0.0', () => {
  console.log(`checkout-api listening on ${port}`);
});
