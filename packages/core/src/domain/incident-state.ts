/**
 * The incident state machine.
 *
 * Transitions are an explicit allow-list. A reasoning model may *propose* a
 * transition; only this module decides whether it is legal. Invalid transitions
 * throw, and callers are expected to audit the failure rather than swallow it.
 */

export const INCIDENT_STATES = [
  'HEALTHY',
  'DEPLOYMENT_OBSERVED',
  'OBSERVING',
  'REGRESSION_DETECTED',
  'INCIDENT_OPEN',
  'INVESTIGATING',
  'ROOT_CAUSE_SUSPECTED',
  'ROOT_CAUSE_CONFIRMED',
  'REPRODUCING',
  'FIXING',
  'VALIDATING',
  'FIX_READY',
  'AWAITING_APPROVAL',
  'APPROVED',
  'DEPLOYING_FIX',
  'VERIFYING_RECOVERY',
  'RESOLVED',
  // terminal / branching
  'FALSE_POSITIVE',
  'EXTERNAL_INCIDENT',
  'FIX_FAILED',
  'APPROVAL_REJECTED',
  'ROLLBACK_REQUESTED',
  'UNRESOLVED',
] as const;

export type IncidentState = (typeof INCIDENT_STATES)[number];

/** States from which no further transition is permitted. */
export const TERMINAL_STATES = new Set<IncidentState>([
  'RESOLVED',
  'FALSE_POSITIVE',
  'EXTERNAL_INCIDENT',
  'APPROVAL_REJECTED',
  'UNRESOLVED',
]);

/**
 * Legal transitions.
 *
 * Note the deliberate absences:
 *  - nothing reaches RESOLVED except VERIFYING_RECOVERY. An incident can never be
 *    closed on the strength of a fix being merged; recovery must be observed.
 *  - nothing reaches ROOT_CAUSE_CONFIRMED except from ROOT_CAUSE_SUSPECTED, and the
 *    evidence gate in `assertCanConfirmRootCause` guards that edge.
 *  - AWAITING_APPROVAL is reachable only from FIX_READY, so an approval can never be
 *    requested for work that has not been validated.
 */
const TRANSITIONS: Readonly<Record<IncidentState, readonly IncidentState[]>> = {
  HEALTHY: ['DEPLOYMENT_OBSERVED'],
  DEPLOYMENT_OBSERVED: ['OBSERVING'],
  OBSERVING: ['REGRESSION_DETECTED', 'HEALTHY'],
  REGRESSION_DETECTED: ['INCIDENT_OPEN', 'FALSE_POSITIVE'],
  INCIDENT_OPEN: ['INVESTIGATING'],
  INVESTIGATING: [
    'ROOT_CAUSE_SUSPECTED',
    'EXTERNAL_INCIDENT',
    'FALSE_POSITIVE',
    'UNRESOLVED',
  ],
  ROOT_CAUSE_SUSPECTED: ['REPRODUCING', 'ROOT_CAUSE_CONFIRMED', 'UNRESOLVED'],
  // Reproduction is the normal route to confirmation, but an incident may also be
  // confirmed on direct evidence when reproduction is not feasible.
  REPRODUCING: ['ROOT_CAUSE_CONFIRMED', 'UNRESOLVED', 'INVESTIGATING'],
  ROOT_CAUSE_CONFIRMED: ['FIXING', 'ROLLBACK_REQUESTED'],
  FIXING: ['VALIDATING', 'FIX_FAILED'],
  VALIDATING: ['FIX_READY', 'FIX_FAILED'],
  FIX_READY: ['AWAITING_APPROVAL'],
  AWAITING_APPROVAL: ['APPROVED', 'APPROVAL_REJECTED', 'ROLLBACK_REQUESTED'],
  APPROVED: ['DEPLOYING_FIX'],
  DEPLOYING_FIX: ['VERIFYING_RECOVERY', 'FIX_FAILED'],
  VERIFYING_RECOVERY: ['RESOLVED', 'UNRESOLVED', 'ROLLBACK_REQUESTED'],
  ROLLBACK_REQUESTED: ['VERIFYING_RECOVERY', 'UNRESOLVED'],
  // A failed fix returns to investigation rather than terminating: the root cause
  // may have been wrong.
  FIX_FAILED: ['INVESTIGATING', 'ROLLBACK_REQUESTED', 'UNRESOLVED'],
  RESOLVED: [],
  FALSE_POSITIVE: [],
  EXTERNAL_INCIDENT: [],
  APPROVAL_REJECTED: [],
  UNRESOLVED: [],
};

export class InvalidTransitionError extends Error {
  constructor(
    readonly from: IncidentState,
    readonly to: IncidentState,
  ) {
    super(`Illegal incident transition: ${from} -> ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

export function isTerminal(state: IncidentState): boolean {
  return TERMINAL_STATES.has(state);
}

export function allowedTransitions(from: IncidentState): readonly IncidentState[] {
  return TRANSITIONS[from];
}

export function canTransition(from: IncidentState, to: IncidentState): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Throws `InvalidTransitionError` unless the transition is on the allow-list. */
export function assertTransition(from: IncidentState, to: IncidentState): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}
