import { z } from 'zod';

/**
 * Tool contract and permission model.
 *
 * Every tool the agent can reach is declared here with an explicit risk level. The
 * reasoning model never sees a tool it is not permitted to call at the current
 * autonomy level — capability is removed, not merely discouraged by a prompt.
 */

export const RiskLevel = z.enum([
  /** Cannot change anything anywhere. */
  'READ_ONLY',
  /** Writes, but only to sandboxes, fix branches, PRs, chat threads, tickets. */
  'WRITE_NON_PRODUCTION',
  /** Touches production. Always requires a recorded human approval. */
  'PRODUCTION_WRITE',
]);
export type RiskLevel = z.infer<typeof RiskLevel>;

export const AUTONOMY_LEVELS = ['L0', 'L1', 'L2', 'L3', 'L4', 'L5'] as const;
export type AutonomyLevel = (typeof AUTONOMY_LEVELS)[number];

export const AUTONOMY_DESCRIPTIONS: Record<AutonomyLevel, string> = {
  L0: 'Observe only',
  L1: 'Investigate',
  L2: 'Prepare remediation in a sandbox',
  L3: 'Create a pull request (default)',
  L4: 'Execute human-approved remediation',
  L5: 'Execute explicitly pre-authorized safe remediation',
};

export const DEFAULT_AUTONOMY_LEVEL: AutonomyLevel = 'L3';

export interface ToolDefinition<I = unknown, O = unknown> {
  name: string;
  description: string;
  inputSchema: z.ZodType<I>;
  outputSchema: z.ZodType<O>;
  risk: RiskLevel;
  /** Minimum autonomy level at which this tool may be offered at all. */
  minAutonomy: AutonomyLevel;
  /** True when a recorded Approval row must exist before execution. */
  requiresApproval: boolean;
  timeoutMs: number;
  maxRetries: number;
  /** Tools that mutate anything must be audited; enforced by `validateToolDefinition`. */
  audit: boolean;
}

function levelIndex(level: AutonomyLevel): number {
  return AUTONOMY_LEVELS.indexOf(level);
}

/**
 * Actions that are prohibited outright, at every autonomy level, with no approval
 * path. These are not "high risk" — they are outside the product's remit, and a
 * request to register one is a programming error rather than a policy decision.
 */
export const PROHIBITED_CAPABILITIES = [
  'push_to_default_branch',
  'delete_production_data',
  'modify_production_database',
  'modify_iam',
  'rotate_credentials',
  'destroy_infrastructure',
  'execute_arbitrary_production_command',
  'deploy_arbitrary_code',
  'disable_security_control',
] as const;
export type ProhibitedCapability = (typeof PROHIBITED_CAPABILITIES)[number];

export class ProhibitedActionError extends Error {
  constructor(readonly capability: string) {
    super(`Prohibited capability, refused at every autonomy level: ${capability}`);
    this.name = 'ProhibitedActionError';
  }
}

export class PermissionDeniedError extends Error {
  constructor(
    readonly tool: string,
    readonly reason: string,
  ) {
    super(`Permission denied for ${tool}: ${reason}`);
    this.name = 'PermissionDeniedError';
  }
}

/** Structural invariants a tool declaration must satisfy to be registered. */
export function validateToolDefinition(def: ToolDefinition): void {
  if ((PROHIBITED_CAPABILITIES as readonly string[]).includes(def.name)) {
    throw new ProhibitedActionError(def.name);
  }
  if (def.risk === 'PRODUCTION_WRITE' && !def.requiresApproval) {
    throw new Error(`${def.name}: PRODUCTION_WRITE tools must require approval`);
  }
  if (def.risk !== 'READ_ONLY' && !def.audit) {
    throw new Error(`${def.name}: mutating tools must be audited`);
  }
  if (def.risk === 'PRODUCTION_WRITE' && levelIndex(def.minAutonomy) < levelIndex('L4')) {
    throw new Error(`${def.name}: PRODUCTION_WRITE requires minAutonomy of at least L4`);
  }
}

export interface PermissionContext {
  autonomy: AutonomyLevel;
  /** Id of a recorded, un-expired Approval covering this exact action, if any. */
  approvalId?: string;
}

/**
 * The single decision point for "may this tool run right now".
 *
 * Deliberately conservative: an approval does not raise the autonomy level, it only
 * satisfies the approval requirement. A PRODUCTION_WRITE at L3 stays denied even with
 * an approval in hand, because L3 means the operator has not granted execution rights
 * at all.
 */
export function assertToolAllowed(def: ToolDefinition, ctx: PermissionContext): void {
  if ((PROHIBITED_CAPABILITIES as readonly string[]).includes(def.name)) {
    throw new ProhibitedActionError(def.name);
  }
  if (levelIndex(ctx.autonomy) < levelIndex(def.minAutonomy)) {
    throw new PermissionDeniedError(
      def.name,
      `requires autonomy ${def.minAutonomy}, current level is ${ctx.autonomy}`,
    );
  }
  if (def.requiresApproval && !ctx.approvalId) {
    throw new PermissionDeniedError(def.name, 'requires a recorded human approval');
  }
}

/** The tools offered to the model at a given autonomy level. */
export function availableTools(
  defs: readonly ToolDefinition[],
  autonomy: AutonomyLevel,
): ToolDefinition[] {
  return defs.filter((d) => levelIndex(autonomy) >= levelIndex(d.minAutonomy));
}
