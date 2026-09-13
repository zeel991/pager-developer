import {
  assertToolAllowed,
  type AutonomyLevel,
  type ToolDefinition,
} from '@pager/core';
import type { AuditRepository } from '@pager/db';

/**
 * Policy and approval.
 *
 * The autonomy level is the operator's standing decision about what Pager may do at
 * all. An approval is a human's decision about one specific action. They compose
 * rather than substitute: an approval never raises the autonomy level, so a
 * production write at L3 stays refused even with an approval in hand.
 *
 * Every decision — allowed or refused — is audited. A system that only records what
 * it did, and not what it was stopped from doing, cannot be reviewed after an
 * incident.
 */

export interface ApprovalRecord {
  id: string;
  incidentId: string;
  /** The exact action authorised. An approval is never a blanket grant. */
  authorizedAction: string;
  decision: 'APPROVED' | 'REJECTED' | 'ROLLBACK_INSTEAD';
  approverUserId: string | null;
  decidedAt: Date;
  expiresAt: Date | null;
}

export class ApprovalRequiredError extends Error {
  constructor(readonly action: string) {
    super(`${action} requires a recorded human approval and none is present.`);
    this.name = 'ApprovalRequiredError';
  }
}

export class ApprovalExpiredError extends Error {
  constructor(readonly action: string, readonly expiredAt: Date) {
    super(`Approval for ${action} expired at ${expiredAt.toISOString()}.`);
    this.name = 'ApprovalExpiredError';
  }
}

export class ApprovalMismatchError extends Error {
  constructor(readonly requested: string, readonly authorized: string) {
    super(`Approval authorises "${authorized}", not "${requested}".`);
    this.name = 'ApprovalMismatchError';
  }
}

export interface PolicyDecision {
  allowed: boolean;
  reason: string;
}

export class PolicyEngine {
  constructor(
    private readonly audit: AuditRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Decide whether an action may proceed, and record the decision.
   *
   * `approval` must authorise this exact action. A stale or mismatched approval is
   * refused rather than stretched to cover something adjacent — the whole value of
   * an approval is that a human agreed to a specific thing.
   */
  async authorize(input: {
    organizationId: string;
    incidentId: string | null;
    tool: ToolDefinition;
    autonomy: AutonomyLevel;
    actor: string;
    approval?: ApprovalRecord | null;
  }): Promise<PolicyDecision> {
    const { tool, approval } = input;
    const action = tool.name;

    const record = async (allowed: boolean, reason: string): Promise<PolicyDecision> => {
      await this.audit.record({
        organizationId: input.organizationId,
        incidentId: input.incidentId,
        actor: input.actor,
        action,
        risk: tool.risk,
        allowed,
        denialReason: allowed ? null : reason,
        detail: { autonomy: input.autonomy, approvalId: approval?.id ?? null },
      });
      return { allowed, reason };
    };

    if (approval) {
      if (approval.decision !== 'APPROVED') {
        return record(false, `Approval decision was ${approval.decision}, not APPROVED.`);
      }
      if (approval.authorizedAction !== action) {
        return record(
          false,
          new ApprovalMismatchError(action, approval.authorizedAction).message,
        );
      }
      if (approval.expiresAt && approval.expiresAt.getTime() <= this.now().getTime()) {
        return record(false, new ApprovalExpiredError(action, approval.expiresAt).message);
      }
    }

    try {
      assertToolAllowed(tool, {
        autonomy: input.autonomy,
        ...(approval && approval.decision === 'APPROVED' ? { approvalId: approval.id } : {}),
      });
    } catch (err) {
      return record(false, err instanceof Error ? err.message : String(err));
    }

    return record(true, 'Permitted');
  }
}

/**
 * The human-facing approval request.
 *
 * Deliberately includes the evidence for the decision, not just the ask. An approval
 * prompt that only says "approve?" pushes the judgement back onto someone with less
 * context than the system has.
 */
export interface ApprovalRequest {
  incidentKey: string;
  action: string;
  rootCause: string;
  rootCauseConfidence: number;
  reproduced: boolean;
  checksPassed: number;
  checksSkipped: string[];
  pullRequestUrl: string | null;
  risks: string[];
  rollbackPlan: string;
}

export function formatApprovalRequest(request: ApprovalRequest): string {
  const lines = [
    `*Approval required* — ${request.incidentKey}`,
    '',
    `*Action*  ${request.action}`,
    `*Root cause*  ${request.rootCause}`,
    `*Root cause confidence*  ${(request.rootCauseConfidence * 100).toFixed(0)}%`,
    `*Reproduction*  ${request.reproduced ? 'confirmed' : 'NOT CONFIRMED'}`,
    `*Checks passed*  ${request.checksPassed}`,
  ];
  if (request.checksSkipped.length > 0) {
    lines.push(`*Checks not run*  ${request.checksSkipped.join(', ')}`);
  }
  if (request.pullRequestUrl) lines.push(`*Pull request*  ${request.pullRequestUrl}`);
  if (request.risks.length > 0) {
    lines.push('', '*Risks*');
    for (const r of request.risks) lines.push(`• ${r}`);
  }
  lines.push('', `*Rollback plan*  ${request.rollbackPlan}`);

  // Stated explicitly so an approver is never misled about how settled this is.
  if (!request.reproduced) {
    lines.push(
      '',
      ':warning: The failure was not reproduced, so this fix is unverified. ' +
        'Approving applies a change whose effect has not been demonstrated.',
    );
  }
  lines.push('', '[Approve]  [Rollback instead]  [Reject]');
  return lines.join('\n');
}
