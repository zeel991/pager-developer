import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadDemoScenario } from '../src/demo-loader.js';

const DEMO_ROOT = join(import.meta.dirname, '..', '..', '..', 'demo');

describe('demo scenario loader', () => {
  const scenario = loadDemoScenario(DEMO_ROOT);

  it('builds the history from the real working tree', () => {
    expect(scenario.id).toBe('INC-001');
    expect(scenario.repository).toBe('acme/checkout-api');
    expect(scenario.commits).toHaveLength(3);
  });

  it('lays the overlay over the initial commit, giving the pre-change contract', () => {
    const initial = scenario.commits[0]!;
    const types = initial.changes.find((c) => c.path === 'src/checkout/types.ts')!;
    expect(types.content).toContain('discountCode: DiscountCode;');
    expect(types.content).not.toContain('discountCode?:');
  });

  it('takes the working-tree version for the change that broke production', () => {
    const change = scenario.commits[1]!;
    expect(change.changes).toHaveLength(1);
    expect(change.changes[0]!.content).toContain('discountCode?: DiscountCode | null');
  });

  it('carries the real test suite into the repository', () => {
    const initial = scenario.commits[0]!;
    const paths = initial.changes.map((c) => c.path);
    expect(paths).toContain('test/checkout.test.ts');
    expect(paths).toContain('package.json');
    // The service file is present at the initial commit and never changed after.
    expect(paths).toContain('src/checkout/service.ts');
    expect(scenario.commits[1]!.changes.map((c) => c.path)).not.toContain('src/checkout/service.ts');
  });

  it('excludes files that are not part of the repository', () => {
    const paths = scenario.commits[0]!.changes.map((c) => c.path);
    expect(paths.some((p) => p.includes('node_modules'))).toBe(false);
    expect(paths.some((p) => p.includes('.DS_Store'))).toBe(false);
  });

  it('loads runbooks from disk for the knowledge twin', () => {
    const runbook = scenario.pages!.find((p) => p.id === 'runbook-checkout')!;
    expect(runbook.content).toContain('PaymentGatewayError');
    expect(runbook.content).toContain('Do not modify the production database');
  });

  it('refuses a manifest naming files that are not there', () => {
    // A silently empty commit would be a baffling scenario to debug.
    expect(() => loadDemoScenario(join(import.meta.dirname, 'fixtures-missing'))).toThrow();
  });
});
