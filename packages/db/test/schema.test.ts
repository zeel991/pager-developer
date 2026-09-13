import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDatabase } from '../src/client.js';
import { deployments, evidence, incidents, organizations, repositories, services } from '../src/schema.js';

/**
 * These tests run against a real Postgres engine (PGlite), not a mock. A schema that
 * merely compiles has proved nothing; this proves the DDL is valid and that the
 * constraints we rely on for safety are actually enforced by the database.
 */

const MIGRATIONS = join(import.meta.dirname, '..', 'migrations');

async function freshDb() {
  const handle = await createDatabase('pglite://memory');
  const file = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()[0]!;
  const sql = readFileSync(join(MIGRATIONS, file), 'utf8');
  for (const stmt of sql.split('--> statement-breakpoint')) {
    if (stmt.trim()) await handle.pglite!.exec(stmt);
  }
  return handle;
}

describe('database schema', () => {
  it('applies cleanly to a real Postgres engine', async () => {
    const { pglite, close } = await freshDb();
    const res = await pglite!.query<{ count: number }>(
      `select count(*)::int as count from information_schema.tables where table_schema = 'public'`,
    );
    expect(res.rows[0]!.count).toBeGreaterThan(20);
    await close();
  });

  it('round-trips an organization, repository, service and deployment', async () => {
    const { db, close } = await freshDb();

    const [org] = await db.insert(organizations).values({ name: 'Acme', slug: 'acme' }).returning();
    const [repo] = await db
      .insert(repositories)
      .values({ organizationId: org!.id, fullName: 'acme/checkout-api' })
      .returning();
    const [svc] = await db
      .insert(services)
      .values({ organizationId: org!.id, repositoryId: repo!.id, name: 'checkout-api' })
      .returning();
    const [dep] = await db
      .insert(deployments)
      .values({
        organizationId: org!.id,
        serviceId: svc!.id,
        repositoryId: repo!.id,
        environment: 'production',
        status: 'succeeded',
        commitSha: 'b2c3d4',
        previousCommitSha: 'a1b2c3',
        startedAt: new Date('2026-09-13T14:29:00Z'),
        deployedAt: new Date('2026-09-13T14:31:00Z'),
      })
      .returning();

    expect(dep!.commitSha).toBe('b2c3d4');
    expect(dep!.previousCommitSha).toBe('a1b2c3');
    expect(dep!.environment).toBe('production');
    await close();
  });

  it('defaults an organization to L3 autonomy', async () => {
    const { db, close } = await freshDb();
    const [org] = await db.insert(organizations).values({ name: 'A', slug: 'a' }).returning();
    expect(org!.autonomyLevel).toBe('L3');
    await close();
  });

  it('refuses evidence that no tool call produced', async () => {
    // The evidence gate is enforced by the database too, not only in application
    // code: sourceToolCallId is NOT NULL and foreign-keyed to tool_calls.
    const { db, close } = await freshDb();
    const [org] = await db.insert(organizations).values({ name: 'A', slug: 'a' }).returning();
    const [repo] = await db.insert(repositories).values({ organizationId: org!.id, fullName: 'a/b' }).returning();
    const [svc] = await db
      .insert(services)
      .values({ organizationId: org!.id, repositoryId: repo!.id, name: 's' })
      .returning();
    const [inc] = await db
      .insert(incidents)
      .values({
        organizationId: org!.id,
        serviceId: svc!.id,
        key: 'INC-1',
        state: 'INCIDENT_OPEN',
        severity: 'SEV2',
        title: 't',
      })
      .returning();

    await expect(
      db.insert(evidence).values({
        incidentId: inc!.id,
        kind: 'DATADOG_LOG',
        provenance: 'OBSERVED',
        summary: 'invented',
        // A tool call id that was never issued.
        sourceToolCallId: '00000000-0000-0000-0000-000000000000',
      }),
    ).rejects.toThrow();

    await close();
  });

  it('rejects an incident state outside the state machine', async () => {
    const { db, close } = await freshDb();
    const [org] = await db.insert(organizations).values({ name: 'A', slug: 'a' }).returning();
    const [repo] = await db.insert(repositories).values({ organizationId: org!.id, fullName: 'a/b' }).returning();
    const [svc] = await db
      .insert(services)
      .values({ organizationId: org!.id, repositoryId: repo!.id, name: 's' })
      .returning();

    await expect(
      db.insert(incidents).values({
        organizationId: org!.id,
        serviceId: svc!.id,
        key: 'INC-2',
        // Not a member of INCIDENT_STATES.
        state: 'TOTALLY_FINE' as never,
        severity: 'SEV2',
        title: 't',
      }),
    ).rejects.toThrow();

    await close();
  });
});
