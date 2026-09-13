import { join } from 'node:path';
import { loadDemoScenario } from '../demo-loader.js';
import type { ScenarioFixture } from '../seed.js';

/**
 * INC-001 — a deployment widens a contract and checkout starts throwing.
 *
 * Loaded from the real repository under `demo/`, not from string constants. That
 * repository is runnable: `cd demo/checkout-api && node --test` passes against the
 * broken code, which is exactly why the bug reached production and why reproducing
 * this incident requires writing a new test rather than running the existing suite.
 *
 * The deployment does not touch `service.ts` at all — PR #377 only widens
 * `discountCode` to optional in `types.ts`, while the line that throws is unchanged.
 * So attribution cannot be settled by checking whether the failing file appears in
 * the diff, which is the shortcut a naive implementation would take.
 */

const DEMO_ROOT = join(import.meta.dirname, '..', '..', '..', '..', 'demo');

export const INC_001: ScenarioFixture = loadDemoScenario(DEMO_ROOT);
