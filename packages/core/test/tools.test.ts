import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  PermissionDeniedError,
  ProhibitedActionError,
  assertToolAllowed,
  availableTools,
  validateToolDefinition,
  type ToolDefinition,
} from '../src/policy/tools.js';

const tool = (over: Partial<ToolDefinition> = {}): ToolDefinition => ({
  name: 'github.readDiff',
  description: 'Read a diff',
  inputSchema: z.object({}),
  outputSchema: z.object({}),
  risk: 'READ_ONLY',
  minAutonomy: 'L1',
  requiresApproval: false,
  timeoutMs: 10_000,
  maxRetries: 2,
  audit: false,
  ...over,
});

const rollback = tool({
  name: 'deployment.rollback',
  risk: 'PRODUCTION_WRITE',
  minAutonomy: 'L4',
  requiresApproval: true,
  audit: true,
});

describe('tool policy', () => {
  it('rejects a production write that does not require approval', () => {
    expect(() =>
      validateToolDefinition(tool({ risk: 'PRODUCTION_WRITE', minAutonomy: 'L4', audit: true })),
    ).toThrow(/must require approval/);
  });

  it('rejects a mutating tool that is not audited', () => {
    expect(() => validateToolDefinition(tool({ risk: 'WRITE_NON_PRODUCTION', audit: false })))
      .toThrow(/must be audited/);
  });

  it('rejects a production write reachable below L4', () => {
    expect(() =>
      validateToolDefinition(
        tool({ risk: 'PRODUCTION_WRITE', requiresApproval: true, audit: true, minAutonomy: 'L3' }),
      ),
    ).toThrow(/at least L4/);
  });

  it('refuses to register a prohibited capability', () => {
    expect(() => validateToolDefinition(tool({ name: 'modify_iam' }))).toThrow(ProhibitedActionError);
  });

  it('accepts a well-formed rollback declaration', () => {
    expect(() => validateToolDefinition(rollback)).not.toThrow();
  });

  it('denies a production write at the default L3 even with an approval in hand', () => {
    expect(() => assertToolAllowed(rollback, { autonomy: 'L3', approvalId: 'apr-1' }))
      .toThrow(PermissionDeniedError);
  });

  it('denies a production write at L4 without an approval', () => {
    expect(() => assertToolAllowed(rollback, { autonomy: 'L4' }))
      .toThrow(/requires a recorded human approval/);
  });

  it('allows a production write at L4 with an approval', () => {
    expect(() => assertToolAllowed(rollback, { autonomy: 'L4', approvalId: 'apr-1' })).not.toThrow();
  });

  it('never exposes a prohibited capability regardless of level or approval', () => {
    const bad = tool({ name: 'destroy_infrastructure', minAutonomy: 'L0' });
    expect(() => assertToolAllowed(bad, { autonomy: 'L5', approvalId: 'apr-1' }))
      .toThrow(ProhibitedActionError);
  });

  it('hides tools above the current autonomy level from the model', () => {
    const defs = [tool(), rollback];
    expect(availableTools(defs, 'L3').map((d) => d.name)).toEqual(['github.readDiff']);
    expect(availableTools(defs, 'L4').map((d) => d.name)).toEqual(['github.readDiff', 'deployment.rollback']);
  });

  it('offers no tools at L0 beyond observation', () => {
    expect(availableTools([tool({ minAutonomy: 'L1' }), rollback], 'L0')).toHaveLength(0);
  });
});
