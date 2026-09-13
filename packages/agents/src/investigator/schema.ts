import { z } from 'zod';

/**
 * What an investigation is allowed to return.
 *
 * The model does not get to decide the shape of its own conclusion. Every field
 * here exists because omitting it would let the output sound more settled than the
 * evidence supports:
 *
 *  - `evidence` must cite tool calls the tracer actually issued. Validated against
 *    the issued set, not trusted.
 *  - `uncertainty` is required and non-empty. A diagnosis with nothing unknown about
 *    it is nearly always a diagnosis that stopped looking.
 *  - `attribution` is a separate judgement from the diagnosis, because "the deploy
 *    happened first" is correlation and must not be laundered into the root cause.
 *  - `decision` is REPAIR or ABSTAIN. Abstaining is a first-class outcome with its
 *    own reason, not an error path.
 */

/** The subset of {@link AttributionVerdict} an investigation may actually return. */
export const InvestigationAttribution = z.enum([
  'DEPLOYMENT_LIKELY_RESPONSIBLE',
  'DEPLOYMENT_NOT_RESPONSIBLE',
  'EXTERNAL_INCIDENT',
  'INSUFFICIENT_EVIDENCE',
]);
export type InvestigationAttribution = z.infer<typeof InvestigationAttribution>;

export const EvidenceCitation = z.object({
  /** An id minted by the tracer for a call that really executed. */
  toolCallId: z.string().min(1),
  /** What this specific observation shows. Not a restatement of the diagnosis. */
  shows: z.string().min(1),
});
export type EvidenceCitation = z.infer<typeof EvidenceCitation>;

export const InvestigationFindings = z.object({
  diagnosis: z.string().min(1),
  /** Repository path the failure originates from, when the evidence locates one. */
  rootCauseFile: z.string().nullable(),
  rootCauseLine: z.number().int().positive().nullable(),
  evidence: z.array(EvidenceCitation).min(1),
  uncertainty: z.string().min(1),
  attribution: z.object({
    verdict: InvestigationAttribution,
    rationale: z.string().min(1),
  }),
  decision: z.object({
    action: z.enum(['REPAIR', 'ABSTAIN']),
    reason: z.string().min(1),
  }),
  /** How the regression test should demonstrate the failure, in prose. */
  regressionTestPlan: z.string().nullable(),
  confidence: z.number().min(0).max(1),
});
export type InvestigationFindings = z.infer<typeof InvestigationFindings>;

export class InvestigationRejectedError extends Error {
  constructor(readonly reasons: string[]) {
    super(`Investigation output rejected: ${reasons.join('; ')}`);
    this.name = 'InvestigationRejectedError';
  }
}

/**
 * Reject an investigation whose citations name tool calls that were never made.
 *
 * This is the same property `danglingCitations` enforces for Evidence rows, applied
 * one layer earlier: a model cannot fabricate a tool call id because it never mints
 * one. Ids appear in its context only as the output of a call the tracer ran.
 */
export function unsupportedCitations(
  findings: InvestigationFindings,
  issuedToolCallIds: readonly string[],
): string[] {
  const issued = new Set(issuedToolCallIds);
  return findings.evidence.map((e) => e.toolCallId).filter((id) => !issued.has(id));
}

/** Every admissibility rule, in one place. Returns the reasons it failed. */
export function validateFindings(
  findings: InvestigationFindings,
  issuedToolCallIds: readonly string[],
): string[] {
  const reasons: string[] = [];

  const dangling = unsupportedCitations(findings, issuedToolCallIds);
  if (dangling.length > 0) {
    reasons.push(
      `cites ${dangling.length} tool call id(s) that were never issued: ${dangling.join(', ')}`,
    );
  }

  // A repair decision that rests on nothing observed is exactly the failure mode
  // this product exists to prevent.
  if (findings.decision.action === 'REPAIR' && findings.evidence.length === 0) {
    reasons.push('decided to REPAIR while citing no evidence');
  }
  if (findings.decision.action === 'REPAIR' && findings.attribution.verdict === 'INSUFFICIENT_EVIDENCE') {
    reasons.push('decided to REPAIR while reporting the evidence as insufficient to attribute');
  }
  if (findings.decision.action === 'REPAIR' && !findings.regressionTestPlan) {
    reasons.push('decided to REPAIR without a plan for demonstrating the failure');
  }

  return reasons;
}
