import { describe, expect, it } from 'vitest';
import type { LogEntry } from '@pager/providers';
import {
  assessNovelty,
  clusterErrors,
  errorSignature,
  errorType,
  parseStackTrace,
  toRepositoryPath,
} from '../src/log-analysis.js';

const APP_TRACE = `TypeError: Cannot read properties of null (reading 'percentOff')
    at CheckoutService.createOrder (/app/src/checkout/service.ts:20:52)
    at CheckoutController.postCheckout (/app/src/checkout/controller.ts:34:38)
    at processTicksAndRejections (node:internal/process/task_queues:95:5)`;

const VENDOR_TRACE = `PaymentGatewayError: upstream returned 503 Service Unavailable
    at PaymentsClient.request (/app/node_modules/@acme/payments-sdk/dist/client.js:212:15)
    at PaymentsClient.authorize (/app/node_modules/@acme/payments-sdk/dist/client.js:88:20)
    at processTicksAndRejections (node:internal/process/task_queues:95:5)`;

const log = (over: Partial<LogEntry> = {}): LogEntry => ({
  at: new Date('2026-09-13T14:32:00Z'),
  service: 'checkout-api',
  level: 'error',
  message: "TypeError: Cannot read properties of null (reading 'percentOff')",
  stackTrace: APP_TRACE,
  attributes: { 'http.route': 'POST /checkout' },
  ...over,
});

describe('stack trace parsing', () => {
  it('locates the failure in application code', () => {
    const frames = parseStackTrace(APP_TRACE);
    expect(frames[0]).toMatchObject({
      functionName: 'CheckoutService.createOrder',
      file: '/app/src/checkout/service.ts',
      line: 20,
      isDependency: false,
    });
  });

  it('marks dependency and runtime frames as such', () => {
    const frames = parseStackTrace(VENDOR_TRACE);
    expect(frames.every((f) => f.isDependency)).toBe(true);
  });

  it('handles frames with no function name', () => {
    const frames = parseStackTrace('    at /app/src/boot.ts:4:1');
    expect(frames[0]).toMatchObject({ functionName: null, file: '/app/src/boot.ts', line: 4 });
  });

  it('ignores lines that are not frames', () => {
    expect(parseStackTrace('TypeError: boom\n  some prose\n')).toHaveLength(0);
  });

  it('strips a container prefix to a repository-relative path', () => {
    expect(toRepositoryPath('/app/src/checkout/service.ts')).toBe('src/checkout/service.ts');
    expect(toRepositoryPath('/var/task/src/a.ts')).toBe('src/a.ts');
  });
});

describe('error signatures', () => {
  it('groups occurrences that differ only in variable parts', () => {
    const a = errorSignature("Order 4471 failed for customer 'cus_abc123'");
    const b = errorSignature("Order 9902 failed for customer 'cus_zzz999'");
    expect(a).toBe(b);
  });

  it('keeps genuinely different errors apart', () => {
    expect(errorSignature('TypeError: cannot read x')).not.toBe(errorSignature('RangeError: out of range'));
  });

  it('extracts the error type', () => {
    expect(errorType('TypeError: boom')).toBe('TypeError');
    expect(errorType('PaymentGatewayError: 503')).toBe('PaymentGatewayError');
    expect(errorType('just a message')).toBeNull();
  });
});

describe('clustering', () => {
  it('collapses a thousand identical failures into one problem', () => {
    const logs = Array.from({ length: 40 }, (_, i) =>
      log({ at: new Date(Date.parse('2026-09-13T14:32:00Z') + i * 1000) }),
    );
    const clusters = clusterErrors(logs);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.count).toBe(40);
    expect(clusters[0]!.firstSeen.toISOString()).toBe('2026-09-13T14:32:00.000Z');
    expect(clusters[0]!.lastSeen.toISOString()).toBe('2026-09-13T14:32:39.000Z');
  });

  it('points at the first application frame, skipping runtime internals', () => {
    const clusters = clusterErrors([log()]);
    expect(clusters[0]!.topApplicationFrame).toMatchObject({
      file: '/app/src/checkout/service.ts',
      line: 20,
    });
    expect(clusters[0]!.entirelyInDependencies).toBe(false);
  });

  it('recognises a failure that lives entirely in a dependency', () => {
    const clusters = clusterErrors([
      log({ message: 'PaymentGatewayError: upstream returned 503', stackTrace: VENDOR_TRACE }),
    ]);
    expect(clusters[0]!.entirelyInDependencies).toBe(true);
    expect(clusters[0]!.topApplicationFrame).toBeNull();
  });

  it('does not treat a missing stack trace as an upstream fault', () => {
    // No trace is an absence of evidence, not evidence the fault is external.
    const clusters = clusterErrors([log({ stackTrace: null })]);
    expect(clusters[0]!.entirelyInDependencies).toBe(false);
  });

  it('ignores non-error levels', () => {
    expect(clusterErrors([log({ level: 'info' }), log({ level: 'warn' })])).toHaveLength(0);
  });

  it('ranks distinct failures by frequency and keeps the quieter ones', () => {
    const clusters = clusterErrors([
      ...Array.from({ length: 5 }, () => log()),
      log({ message: 'RangeError: index out of range', stackTrace: null }),
    ]);
    expect(clusters).toHaveLength(2);
    expect(clusters[0]!.count).toBe(5);
    expect(clusters[1]!.errorType).toBe('RangeError');
  });

  it('collects the affected routes', () => {
    const clusters = clusterErrors([
      log(),
      log({ attributes: { 'http.route': 'POST /checkout/express' } }),
    ]);
    expect(clusters[0]!.affectedRoutes.sort()).toEqual(['POST /checkout', 'POST /checkout/express']);
  });
});

describe('novelty', () => {
  const known = [
    { marker: 'PaymentGatewayError', description: 'Upstream gateway 503s', source: 'Runbook: checkout-api' },
  ];

  it('treats a documented failure mode as anticipated', () => {
    const cluster = clusterErrors([
      log({ message: 'PaymentGatewayError: upstream returned 503', stackTrace: VENDOR_TRACE }),
    ])[0]!;
    const verdict = assessNovelty(cluster, known);
    expect(verdict.novel).toBe(false);
    expect(verdict.reason).toMatch(/documented failure mode/);
  });

  it('treats an unrecognised failure as novel, which is what opens an incident', () => {
    const verdict = assessNovelty(clusterErrors([log()])[0]!, known);
    expect(verdict.novel).toBe(true);
    expect(verdict.matched).toBeNull();
  });

  it('ignores markers too short to be distinctive', () => {
    // A vague runbook must not be able to suppress a novel failure.
    const verdict = assessNovelty(clusterErrors([log()])[0]!, [
      { marker: 'e', description: 'anything', source: 'bad runbook' },
    ]);
    expect(verdict.novel).toBe(true);
  });

  it('reports novel when there are no documented modes at all', () => {
    expect(assessNovelty(clusterErrors([log()])[0]!, []).novel).toBe(true);
  });
});

/**
 * Frame shapes observed on real deployments.
 *
 * Each of these was seen in production telemetry and, before being handled,
 * produced a path that matched no file in the repository — which reads downstream
 * as "the file is not there" rather than "the frame was not understood".
 */
describe('toRepositoryPath on real runtimes', () => {
  it('handles a Render container root behind a file:// URL', () => {
    expect(
      toRepositoryPath('file:///opt/render/project/src/src/checkout/service.ts'),
    ).toBe('src/checkout/service.ts');
  });

  it('handles a Render container root without a scheme', () => {
    expect(toRepositoryPath('/opt/render/project/src/src/checkout/service.ts')).toBe(
      'src/checkout/service.ts',
    );
  });

  it('still handles the container roots it already knew', () => {
    expect(toRepositoryPath('/app/src/checkout/service.ts')).toBe('src/checkout/service.ts');
    expect(toRepositoryPath('/var/task/handler.js')).toBe('handler.js');
  });

  it('parses a real Render stack frame end to end', () => {
    const frames = parseStackTrace(
      `TypeError: Cannot read properties of undefined (reading 'percentOff')\n` +
        `    at CheckoutService.createOrder (file:///opt/render/project/src/src/checkout/service.ts:22:60)\n` +
        `    at Server.<anonymous> (file:///opt/render/project/src/src/server.ts:48:24)`,
    );
    expect(frames).toHaveLength(2);
    expect(frames[0]!.isDependency).toBe(false);
    expect(toRepositoryPath(frames[0]!.file)).toBe('src/checkout/service.ts');
    expect(frames[0]!.line).toBe(22);
  });
});

/**
 * Log shapes observed on a real deployment.
 *
 * Structured JSON loggers split the error type into its own field and name the
 * route plainly. Reading only the OpenTelemetry keys reported "Error on unknown
 * route" for a log that stated both — a small untruth that then appears in the
 * ticket, the Slack message and the pull request.
 */
describe('clustering real structured logs', () => {
  const entry = (): LogEntry => ({
    at: new Date('2026-09-14T00:20:00Z'),
    service: 'checkout-api',
    level: 'error',
    message: "Cannot read properties of undefined (reading 'percentOff')",
    stackTrace:
      "TypeError: Cannot read properties of undefined (reading 'percentOff')\n" +
      '    at CheckoutService.createOrder (file:///opt/render/project/src/src/checkout/service.ts:22:60)',
    attributes: { error: 'TypeError', route: '/orders', http_status: 500 },
  });

  it('takes the error type from its own field when the message has no prefix', () => {
    expect(clusterErrors([entry()])[0]!.errorType).toBe('TypeError');
  });

  it('finds the route under a plain `route` key', () => {
    expect(clusterErrors([entry()])[0]!.affectedRoutes).toEqual(['/orders']);
  });

  it('still prefers the type stated in the message', () => {
    const log = { ...entry(), message: 'RangeError: out of bounds', attributes: { error: 'TypeError' } };
    expect(clusterErrors([log])[0]!.errorType).toBe('RangeError');
  });

  it('locates the failure in a repository file', () => {
    const frame = clusterErrors([entry()])[0]!.topApplicationFrame!;
    expect(toRepositoryPath(frame.file)).toBe('src/checkout/service.ts');
    expect(frame.line).toBe(22);
  });
});
