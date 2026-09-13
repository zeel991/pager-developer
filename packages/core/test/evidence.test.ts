import { describe, expect, it } from 'vitest';
import {
  UnsupportedClaimError,
  assertClaimSupported,
  danglingCitations,
  promoteToFact,
  type Claim,
  type Evidence,
} from '../src/domain/evidence.js';

const ev = (id: string, kind: Evidence['kind']): Evidence => ({
  id,
  incidentId: 'INC-184',
  kind,
  provenance: 'OBSERVED',
  summary: `evidence ${id}`,
  sourceToolCallId: `tc-${id}`,
  collectedAt: new Date('2026-09-13T14:37:00Z'),
  payload: {},
});

const claim = (over: Partial<Claim> = {}): Claim => ({
  id: 'claim-1',
  incidentId: 'INC-184',
  status: 'HYPOTHESIS',
  statement: 'CheckoutService introduced the regression',
  evidenceIds: [],
  confidence: 0.8,
  ...over,
});

describe('evidence gate', () => {
  const evidence = [ev('log-831', 'DATADOG_LOG'), ev('diff-31', 'CODE_DIFF')];

  it('rejects a fact asserted with no evidence at all', () => {
    expect(() => assertClaimSupported(claim({ status: 'FACT' }), evidence))
      .toThrow(UnsupportedClaimError);
  });

  it('rejects fabricated citations outright', () => {
    const fabricated = claim({ evidenceIds: ['log-831', 'trace-does-not-exist'] });
    expect(danglingCitations(fabricated, evidence)).toEqual(['trace-does-not-exist']);
    expect(() => assertClaimSupported(fabricated, evidence)).toThrow(/does not exist/);
  });

  it('admits a hypothesis with no citations', () => {
    expect(() => assertClaimSupported(claim(), evidence)).not.toThrow();
  });

  it('refuses promotion on a single kind of evidence', () => {
    const single = claim({ evidenceIds: ['log-831'] });
    expect(() => promoteToFact(single, evidence)).toThrow(/distinct evidence kinds/);
  });

  it('refuses promotion when several citations share one kind', () => {
    const sameKind = [ev('log-1', 'DATADOG_LOG'), ev('log-2', 'DATADOG_LOG')];
    const c = claim({ evidenceIds: ['log-1', 'log-2'] });
    expect(() => promoteToFact(c, sameKind)).toThrow(/distinct evidence kinds/);
  });

  it('promotes on corroborating evidence of distinct kinds and drops confidence', () => {
    const c = claim({ evidenceIds: ['log-831', 'diff-31'] });
    const promoted = promoteToFact(c, evidence);
    expect(promoted.status).toBe('FACT');
    expect(promoted.confidence).toBeUndefined();
  });

  it('will not promote a claim that cites a fabricated id, even alongside real ones', () => {
    const c = claim({ evidenceIds: ['log-831', 'diff-31', 'invented-9'] });
    expect(() => promoteToFact(c, evidence)).toThrow(/does not exist/);
  });
});
