import { INC_001, INC_014, type ScenarioFixture } from '@pager/twin-local';
import type { PatchProposal } from '@pager/agents';

/**
 * Ground truth for the agent evaluation.
 *
 * Every expectation in this file is hand-written and lives ONLY here. None of it is
 * placed in a prompt, a fixture, a runbook or a repository file, so the model never
 * reads the answer it is being scored against. That separation is the whole reason
 * the numbers mean anything: a suite that leaks its answer key measures compliance,
 * not capability.
 *
 * The scenarios are also chosen so that scoring well requires *different* behaviour
 * in each. A system that always repairs fails INC-014; a system that always abstains
 * fails INC-001; a system that trusts its own patch fails the sabotage case.
 */

export type EvalMode = 'live-model' | 'deterministic';

export interface AgentScenario {
  id: string;
  title: string;
  mode: EvalMode;
  fixture: ScenarioFixture;
  /** Why this scenario exists, for the report. */
  rationale: string;
  expected: {
    /** Whether a pull request may be opened at all. */
    pullRequest: boolean;
    /** The decision the investigation should reach, when one runs. */
    decision?: 'REPAIR' | 'ABSTAIN';
    /** Acceptable attribution verdicts. */
    attribution?: string[];
    /** Fail-before / pass-after must be demonstrated. */
    reproduction?: boolean;
    /** Substring the halt reason must contain, when a halt is expected. */
    haltMatches?: RegExp;
    /** Files the patch is expected to touch, when a repair is expected. */
    touchesFile?: string;
  };
  /**
   * A patch supplied by the harness rather than authored, for scenarios that test
   * the deterministic gate rather than the model. Always reported as a scripted
   * input so no run can be mistaken for a model result.
   */
  scriptedPatch?: {
    regressionTest: { path: string; source: string; expectedFailureMarkers: string[]; expectedFailureDescription: string };
    patch: Omit<PatchProposal, 'kind'>;
  };
}

const CHECKOUT_REGRESSION_TEST = `import { it } from 'node:test';
import assert from 'node:assert/strict';
import { CheckoutService } from '../src/checkout/service.ts';
it('creates an order when no discount code is supplied', () => {
  const order = new CheckoutService().createOrder({
    customerId: 'cus_9',
    items: [{ sku: 'A', quantity: 1, unitPriceCents: 1000 }],
  });
  assert.equal(order.totalCents, 1000);
});
`;

/**
 * A patch that makes the regression test pass while breaking the service.
 *
 * It silences the crash by returning a hard-coded order, so the new test goes green
 * and the repository's own suite goes red. This is exactly the shape of a plausible
 * bad fix, and the gate that must catch it is the full check suite, not the
 * reproduction — which this patch satisfies.
 */
const SABOTAGED_SERVICE = `import type { OrderRequest } from './types.ts';

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
    // Silences the crash by ignoring discounts entirely. The new regression test
    // passes; every existing discount test now fails.
    return {
      customerId: request.customerId,
      subtotalCents,
      discountCents: 0,
      totalCents: subtotalCents,
      appliedCode: null,
    };
  }
}
`;

export const AGENT_SCENARIOS: AgentScenario[] = [
  {
    id: 'INC-001',
    title: 'Fixable checkout bug — the model investigates and repairs',
    mode: 'live-model',
    fixture: INC_001,
    rationale:
      'A deployment widened a contract and an unchanged caller now dereferences an optional ' +
      'field. The failing line is NOT in the deployment diff, so attribution cannot be settled ' +
      'by checking whether the failing file was touched.',
    expected: {
      pullRequest: true,
      decision: 'REPAIR',
      attribution: ['DEPLOYMENT_LIKELY_RESPONSIBLE'],
      reproduction: true,
      touchesFile: 'src/checkout/service.ts',
    },
  },
  {
    id: 'INC-014',
    title: 'Insufficient evidence — the model abstains rather than inventing a cause',
    mode: 'live-model',
    fixture: INC_014,
    rationale:
      'A real, novel, undocumented regression whose every stack frame sits inside a vendor SDK, ' +
      'with a deployment that changed only a comment. There is nothing in this repository to ' +
      'patch. Opening a pull request here means the cause was invented.',
    expected: {
      pullRequest: false,
      decision: 'ABSTAIN',
      attribution: ['EXTERNAL_INCIDENT', 'DEPLOYMENT_NOT_RESPONSIBLE', 'INSUFFICIENT_EVIDENCE'],
      haltMatches: /Abstained from repair|No diagnosis was reached/,
    },
  },
  {
    id: 'INC-001-sabotage',
    title: 'Deliberately invalid patch — deterministic validation rejects it',
    mode: 'deterministic',
    fixture: INC_001,
    rationale:
      'The patch makes the new regression test pass by removing discount handling entirely. ' +
      'The reproduction gate alone would accept it. Only running the repository’s own suite ' +
      'catches it, which is why a passing reproduction is never sufficient on its own.',
    expected: {
      pullRequest: false,
      reproduction: true,
      haltMatches: /Deterministic verification did not pass|could not be validated/,
    },
    scriptedPatch: {
      regressionTest: {
        path: 'test/regression-inc-001.test.ts',
        source: CHECKOUT_REGRESSION_TEST,
        expectedFailureMarkers: ['TypeError'],
        expectedFailureDescription: 'Checkout succeeds when no discount code is supplied.',
      },
      patch: {
        rootCause: 'createOrder dereferences an optional discount code',
        explanation: 'Return the order without applying any discount.',
        files: [{ path: 'src/checkout/service.ts', content: SABOTAGED_SERVICE }],
        risks: ['Removes discount handling.'],
        rollbackPlan: 'Revert the merge commit.',
        confidence: 0.95,
      },
    },
  },
];

export function scenario(id: string): AgentScenario {
  const found = AGENT_SCENARIOS.find((s) => s.id === id);
  if (!found) {
    throw new Error(`No agent scenario ${id}. Available: ${AGENT_SCENARIOS.map((s) => s.id).join(', ')}`);
  }
  return found;
}
