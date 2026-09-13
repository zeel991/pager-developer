import { z } from 'zod';

/**
 * Evidence and claim epistemics.
 *
 * The single most important safety property of Pager Developer is that it does not
 * say things it cannot support. That property is enforced here, in application code,
 * rather than requested of the model in a prompt.
 *
 * The rules:
 *  - A FACT must cite at least one piece of evidence that was actually collected.
 *  - A HYPOTHESIS may be uncited, but is never rendered as settled.
 *  - Nothing is promoted from HYPOTHESIS to FACT except through `promoteToFact`,
 *    which requires corroborating evidence.
 *  - Evidence is only ever created by a tool call that really ran. There is no code
 *    path by which a model can mint an Evidence row from its own output.
 */

export const EvidenceKind = z.enum([
  'DATADOG_METRIC',
  'DATADOG_LOG',
  'DATADOG_MONITOR',
  'STACK_TRACE',
  'CODE_DIFF',
  'COMMIT',
  'PULL_REQUEST',
  'DEPLOYMENT_RECORD',
  'REPRODUCTION_RESULT',
  'TEST_RESULT',
  'BUILD_RESULT',
  'REPOSITORY_FILE',
  'RUNBOOK',
  'PRIOR_INCIDENT',
]);
export type EvidenceKind = z.infer<typeof EvidenceKind>;

/**
 * How the evidence entered the system. `DERIVED` exists so that a computed value
 * (a percentage change, say) is never mistaken for a direct observation.
 */
export const EvidenceProvenance = z.enum(['OBSERVED', 'DERIVED']);
export type EvidenceProvenance = z.infer<typeof EvidenceProvenance>;

export const Evidence = z.object({
  id: z.string(),
  incidentId: z.string(),
  kind: EvidenceKind,
  provenance: EvidenceProvenance,
  /** Short human-readable statement of what this evidence shows. */
  summary: z.string().min(1),
  /** The provider tool call that produced it. Required: no tool call, no evidence. */
  sourceToolCallId: z.string().min(1),
  /** Where it came from in the external world, for audit. */
  sourceRef: z.string().optional(),
  collectedAt: z.date(),
  /** Structured payload; shape depends on `kind`. */
  payload: z.unknown(),
});
export type Evidence = z.infer<typeof Evidence>;

export const ClaimStatus = z.enum(['HYPOTHESIS', 'OBSERVATION', 'FACT']);
export type ClaimStatus = z.infer<typeof ClaimStatus>;

export const Claim = z.object({
  id: z.string(),
  incidentId: z.string(),
  status: ClaimStatus,
  statement: z.string().min(1),
  evidenceIds: z.array(z.string()),
  /** 0..1. Only meaningful for HYPOTHESIS; a FACT is not probabilistic. */
  confidence: z.number().min(0).max(1).optional(),
});
export type Claim = z.infer<typeof Claim>;

export class UnsupportedClaimError extends Error {
  constructor(
    readonly statement: string,
    readonly reason: string,
  ) {
    super(`Unsupported claim (${reason}): ${statement}`);
    this.name = 'UnsupportedClaimError';
  }
}

/**
 * Returns the evidence ids cited by a claim that do not correspond to real,
 * collected evidence. A non-empty result means the model invented a citation.
 */
export function danglingCitations(claim: Claim, evidence: readonly Evidence[]): string[] {
  const known = new Set(evidence.map((e) => e.id));
  return claim.evidenceIds.filter((id) => !known.has(id));
}

/**
 * The gate every outbound statement passes through.
 *
 * A claim is admissible when it cites only real evidence, and — if it asserts fact —
 * cites at least one piece. Fabricated citations are rejected outright rather than
 * downgraded, because a fabricated citation is a different and more serious failure
 * than an under-evidenced guess.
 */
export function assertClaimSupported(claim: Claim, evidence: readonly Evidence[]): void {
  const dangling = danglingCitations(claim, evidence);
  if (dangling.length > 0) {
    throw new UnsupportedClaimError(
      claim.statement,
      `cites evidence that does not exist: ${dangling.join(', ')}`,
    );
  }
  if (claim.status === 'FACT' && claim.evidenceIds.length === 0) {
    throw new UnsupportedClaimError(claim.statement, 'asserted as fact with no evidence');
  }
}

/**
 * Promote a hypothesis to a fact. This is the only route to FACT status.
 *
 * `corroborating` must name evidence of at least `minDistinctKinds` different kinds:
 * three log lines from the same query are one observation, not three. Reproduction
 * evidence is what usually carries a hypothesis over this line.
 */
export function promoteToFact(
  claim: Claim,
  evidence: readonly Evidence[],
  opts: { minDistinctKinds?: number } = {},
): Claim {
  const minDistinctKinds = opts.minDistinctKinds ?? 2;
  assertClaimSupported(claim, evidence);

  const cited = evidence.filter((e) => claim.evidenceIds.includes(e.id));
  const kinds = new Set(cited.map((e) => e.kind));
  if (kinds.size < minDistinctKinds) {
    throw new UnsupportedClaimError(
      claim.statement,
      `promotion requires >= ${minDistinctKinds} distinct evidence kinds, got ${kinds.size}`,
    );
  }
  return { ...claim, status: 'FACT', confidence: undefined };
}
