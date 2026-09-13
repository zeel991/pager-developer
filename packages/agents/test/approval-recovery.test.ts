import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { ToolDefinition } from '@pager/core';
import { AuditRepository, createDatabase, organizations, type DatabaseHandle } from '@pager/db';
import { AgentTracer, InMemorySink } from '@pager/observability';
import { PolicyEngine, formatApprovalRequest, type ApprovalRecord } from '../src/approval.js';
import { RecoveryVerifier, compareRecovery } from '../src/recovery.js';

const MIGRATIONS = join(import.meta.dirname, '..', '..', 'db', 'migrations');

let handle: DatabaseHandle;
let audit: AuditRepository;
let policy: PolicyEngine;
let orgId: string;

const NOW = new Date('2026-09-13T15:00:00Z');

beforeEach(async () => {
  handle = await createDatabase('pglite://memory');
  const file = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()[0]!;
  for (const stmt of readFileSync(join(MIGRATIONS, file), 'utf8').split('--> statement-breakpoint')) {
    if (stmt.trim()) await handle.pglite!.exec(stmt);
  }
  const [org] = await handle.db.insert(organizations).values({ name: 'Acme', slug: 'acme' }).returning();
  orgId = org!.id;
  audit = new AuditRepository(handle.db);
  policy = new PolicyEngine(audit, () => NOW);
});

const rollback: ToolDefinition = {
  name: 'deployment.rollback',
  description: 'Roll back a deployment',
  inputSchema: z.object({}),
  outputSchema: z.object({}),
  risk: 'PRODUCTION_WRITE',
  minAutonomy: 'L4',
  requiresApproval: true,
  timeoutMs: 60_000,
  maxRetries: 0,
  audit: true,
};

const openPr: ToolDefinition = {
  ...rollback,
  name: 'github.createPullRequest',
  risk: 'WRITE_NON_PRODUCTION',
  minAutonomy: 'L3',
  requiresApproval: false,
};

const approval = (over: Partial<ApprovalRecord> = {}): ApprovalRecord => ({
  id: 'apr-1',
  incidentId: 'inc-1',
  authorizedAction: 'deployment.rollback',
  decision: 'APPROVED',
  approverUserId: 'user-1',
  decidedAt: new Date('2026-09-13T14:55:00Z'),
  expiresAt: null,
  ...over,
});

const authorize = (tool: ToolDefinition, autonomy: Parameters<PolicyEngine['authorize']>[0]['autonomy'], appr?: ApprovalRecord | null) =>
  policy.authorize({ organizationId: orgId, incidentId: null, tool, autonomy, actor: 'agent:FixAgent', approval: appr ?? null });

describe('PolicyEngine', () => {
  it('permits opening a pull request at the default L3', async () => {
    expect((await authorize(openPr, 'L3')).allowed).toBe(true);
  });

  it('refuses a production write at L3 even with a valid approval', async () => {
    // An approval satisfies the approval requirement; it does not raise autonomy.
    const decision = await authorize(rollback, 'L3', approval());
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/requires autonomy L4/);
  });

  it('refuses a production write at L4 without an approval', async () => {
    const decision = await authorize(rollback, 'L4', null);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/recorded human approval/);
  });

  it('permits a production write at L4 with a matching approval', async () => {
    expect((await authorize(rollback, 'L4', approval())).allowed).toBe(true);
  });

  it('refuses an approval that authorises a different action', async () => {
    const decision = await authorize(rollback, 'L4', approval({ authorizedAction: 'github.createPullRequest' }));
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/authorises "github.createPullRequest", not "deployment.rollback"/);
  });

  it('refuses an expired approval rather than stretching it', async () => {
    const decision = await authorize(rollback, 'L4', approval({ expiresAt: new Date('2026-09-13T14:59:00Z') }));
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/expired/);
  });

  it('refuses a rejected decision', async () => {
    const decision = await authorize(rollback, 'L4', approval({ decision: 'REJECTED' }));
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/was REJECTED/);
  });

  it('audits refusals as well as permissions', async () => {
    await authorize(openPr, 'L3');
    await authorize(rollback, 'L3', approval());

    // Read the audit table directly: both decisions must be present.
    const written = await handle.pglite!.query<{ action: string; allowed: boolean }>(
      'select action, allowed from audit_logs order by at',
    );
    expect(written.rows).toHaveLength(2);
    expect(written.rows[0]).toMatchObject({ action: 'github.createPullRequest', allowed: true });
    expect(written.rows[1]).toMatchObject({ action: 'deployment.rollback', allowed: false });
  });
});

describe('approval request', () => {
  const base = {
    incidentKey: 'INC-184',
    action: 'deployment.rollback',
    rootCause: 'discountCode widened to optional',
    rootCauseConfidence: 0.91,
    checksPassed: 187,
    checksSkipped: [] as string[],
    pullRequestUrl: 'https://github.test/pull/382',
    risks: ['Touches a shared contract.'],
    rollbackPlan: 'Redeploy the previous release tag.',
  };

  it('gives the approver the evidence, not just the ask', () => {
    const text = formatApprovalRequest({ ...base, reproduced: true });
    expect(text).toContain('*Root cause confidence*  91%');
    expect(text).toContain('*Reproduction*  confirmed');
    expect(text).toContain('*Rollback plan*');
    expect(text).toContain('[Approve]');
  });

  it('warns explicitly when the failure was never reproduced', () => {
    const text = formatApprovalRequest({ ...base, reproduced: false });
    expect(text).toContain('NOT CONFIRMED');
    expect(text).toMatch(/effect has not been demonstrated/);
  });

  it('names checks that did not run', () => {
    const text = formatApprovalRequest({ ...base, reproduced: true, checksSkipped: ['lint', 'build'] });
    expect(text).toContain('*Checks not run*  lint, build');
  });
});

describe('recovery comparison', () => {
  it('confirms recovery when the signal returns to baseline', () => {
    const c = compareRecovery('error_rate', 0.004, 0.178, 0.005);
    expect(c.recovered).toBe(true);
    expect(c.reason).toMatch(/Within .* of baseline/);
  });

  it('refuses recovery while the signal is still elevated', () => {
    const c = compareRecovery('error_rate', 0.004, 0.178, 0.121);
    expect(c.recovered).toBe(false);
    expect(c.recoveryFraction).toBeLessThan(0.85);
    expect(c.reason).toMatch(/of the excursion has cleared/);
  });

  it('refuses a partial recovery just below the threshold', () => {
    // 80% back is progress, not recovery.
    const c = compareRecovery('latency_p95', 180, 900, 324);
    expect(c.recoveryFraction).toBeCloseTo(0.8, 2);
    expect(c.recovered).toBe(false);
  });

  it('cannot evidence recovery from a metric that never moved', () => {
    const c = compareRecovery('request_throughput', 240, 240, 240);
    expect(c.recovered).toBe(false);
    expect(c.reason).toMatch(/did not move during the incident/);
  });

  it('treats an overshoot below baseline as recovered', () => {
    const c = compareRecovery('error_rate', 0.004, 0.178, 0.001);
    expect(c.recovered).toBe(true);
  });
});

/**
 * A signal that stayed bad and a signal nobody could read are different things.
 *
 * They were collapsed into one boolean, which made the system state "signals have
 * not returned to baseline" about a service whose signals were never measured —
 * a false claim about production, and the exact conflation this project exists to
 * avoid. Absent data is not contrary data.
 */
describe('recovery verdict', () => {
  const windows = {
    baselineWindow: { from: new Date('2026-09-14T10:00:00Z'), to: new Date('2026-09-14T10:30:00Z') },
    incidentWindow: { from: new Date('2026-09-14T10:30:00Z'), to: new Date('2026-09-14T11:00:00Z') },
    postRemediationWindow: { from: new Date('2026-09-14T11:00:00Z'), to: new Date('2026-09-14T11:30:00Z') },
  };

  function verifierOver(points: Record<string, number[] | null>) {
    const observability = {
      kind: 'observability' as const,
      async queryMetric(_s: string, metric: string, range: { from: Date }) {
        const key = range.from.getTime() === windows.baselineWindow.from.getTime()
          ? 'baseline'
          : range.from.getTime() === windows.incidentWindow.from.getTime()
            ? 'incident'
            : 'post';
        const values = points[`${metric}:${key}`];
        return {
          metric, service: 's', environment: 'production' as const, unit: 'ratio',
          points: (values ?? []).map((value, i) => ({ at: new Date(Date.now() + i), value })),
        };
      },
      async queryLogs() { return []; },
      async listMonitors() { return []; },
    };
    return new RecoveryVerifier(observability as never);
  }

  const run = async (v: RecoveryVerifier) => {
    const sink = new InMemorySink();
    return new AgentTracer({ sink, lemma: null }).run('r', {}, (ctx) =>
      v.verify(ctx, { service: 's', metrics: ['error_rate'], ...windows }),
    );
  };

  it('reports UNVERIFIABLE when no metric could be compared', async () => {
    // The dangerous case: this used to read as "not recovered", which asserts
    // something about production that was never observed.
    const r = await run(verifierOver({}));
    expect(r.verdict).toBe('UNVERIFIABLE');
    expect(r.recovered).toBe(false);
    expect(r.summary).toMatch(/gap in instrumentation, not evidence that the fix failed/);
  });

  it('reports NOT_RECOVERED when a metric was compared and is still elevated', async () => {
    const r = await run(verifierOver({
      'error_rate:baseline': [0.004], 'error_rate:incident': [0.18], 'error_rate:post': [0.17],
    }));
    expect(r.verdict).toBe('NOT_RECOVERED');
    expect(r.summary).toMatch(/Still elevated/);
  });

  it('reports RECOVERED when the signal returned', async () => {
    const r = await run(verifierOver({
      'error_rate:baseline': [0.004], 'error_rate:incident': [0.18], 'error_rate:post': [0.005],
    }));
    expect(r.verdict).toBe('RECOVERED');
    expect(r.recovered).toBe(true);
  });

  it('never claims recovery from an unmeasured signal', async () => {
    for (const verdict of ['UNVERIFIABLE'] as const) {
      const r = await run(verifierOver({}));
      expect(r.verdict).toBe(verdict);
      expect(r.recovered).toBe(false);
    }
  });
});
