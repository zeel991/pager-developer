import { describe, expect, it } from 'vitest';
import {
  INCIDENT_STATES,
  InvalidTransitionError,
  allowedTransitions,
  assertTransition,
  canTransition,
  isTerminal,
  type IncidentState,
} from '../src/domain/incident-state.js';

describe('incident state machine', () => {
  it('walks the full happy path from HEALTHY to RESOLVED', () => {
    const happyPath: IncidentState[] = [
      'HEALTHY', 'DEPLOYMENT_OBSERVED', 'OBSERVING', 'REGRESSION_DETECTED',
      'INCIDENT_OPEN', 'INVESTIGATING', 'ROOT_CAUSE_SUSPECTED', 'REPRODUCING',
      'ROOT_CAUSE_CONFIRMED', 'FIXING', 'VALIDATING', 'FIX_READY',
      'AWAITING_APPROVAL', 'APPROVED', 'DEPLOYING_FIX', 'VERIFYING_RECOVERY',
      'RESOLVED',
    ];
    for (let i = 0; i < happyPath.length - 1; i++) {
      expect(() => assertTransition(happyPath[i]!, happyPath[i + 1]!)).not.toThrow();
    }
  });

  it('refuses to resolve an incident from any state but VERIFYING_RECOVERY', () => {
    const resolvers = INCIDENT_STATES.filter((s) => canTransition(s, 'RESOLVED'));
    expect(resolvers).toEqual(['VERIFYING_RECOVERY']);
  });

  it('refuses to resolve directly from a merged fix', () => {
    expect(canTransition('DEPLOYING_FIX', 'RESOLVED')).toBe(false);
    expect(() => assertTransition('FIX_READY', 'RESOLVED')).toThrow(InvalidTransitionError);
  });

  it('only requests approval for validated work', () => {
    const approvers = INCIDENT_STATES.filter((s) => canTransition(s, 'AWAITING_APPROVAL'));
    expect(approvers).toEqual(['FIX_READY']);
  });

  it('only confirms root cause from a suspected root cause or a reproduction', () => {
    const confirmers = INCIDENT_STATES.filter((s) => canTransition(s, 'ROOT_CAUSE_CONFIRMED'));
    expect(confirmers.sort()).toEqual(['REPRODUCING', 'ROOT_CAUSE_SUSPECTED']);
  });

  it('never allows a write action to precede an open incident', () => {
    expect(canTransition('OBSERVING', 'FIXING')).toBe(false);
    expect(canTransition('REGRESSION_DETECTED', 'FIXING')).toBe(false);
  });

  it('treats terminal states as dead ends', () => {
    for (const state of INCIDENT_STATES) {
      if (isTerminal(state)) expect(allowedTransitions(state)).toHaveLength(0);
    }
  });

  it('routes a failed fix back to investigation rather than closing it', () => {
    expect(canTransition('FIX_FAILED', 'INVESTIGATING')).toBe(true);
    expect(canTransition('FIX_FAILED', 'RESOLVED')).toBe(false);
  });

  it('leaves every non-terminal state with somewhere to go', () => {
    for (const state of INCIDENT_STATES) {
      if (!isTerminal(state)) expect(allowedTransitions(state).length).toBeGreaterThan(0);
    }
  });
});
