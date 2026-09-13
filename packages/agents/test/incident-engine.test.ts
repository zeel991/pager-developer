import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { InvalidTransitionError } from '@pager/core';
import {
  AuditRepository,
  IncidentRepository,
  TimelineRepository,
  createDatabase,
  organizations,
  repositories as reposTable,
  services,
  type DatabaseHandle,
} from '@pager/db';
import { IncidentEngine } from '../src/incident-engine.js';

/**
 * Runs against a real Postgres engine. The state machine's guarantees only matter if
 * they hold against the actual store, including the enum constraint on the column.
 */
const MIGRATIONS = join(import.meta.dirname, '..', '..', 'db', 'migrations');

let handle: DatabaseHandle;
let engine: IncidentEngine;
let incidents: IncidentRepository;
let timeline: TimelineRepository;
let audit: AuditRepository;
let orgId: string;
let serviceId: string;

beforeEach(async () => {
  handle = await createDatabase('pglite://memory');
  const file = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()[0]!;
  for (const stmt of readFileSync(join(MIGRATIONS, file), 'utf8').split('--> statement-breakpoint')) {
    if (stmt.trim()) await handle.pglite!.exec(stmt);
  }

  const [org] = await handle.db.insert(organizations).values({ name: 'Acme', slug: 'acme' }).returning();
  orgId = org!.id;
  const [repo] = await handle.db
    .insert(reposTable)
    .values({ organizationId: orgId, fullName: 'acme/checkout-api' })
    .returning();
  const [svc] = await handle.db
    .insert(services)
    .values({ organizationId: orgId, repositoryId: repo!.id, name: 'checkout-api' })
    .returning();
  serviceId = svc!.id;

  incidents = new IncidentRepository(handle.db);
  timeline = new TimelineRepository(handle.db);
  audit = new AuditRepository(handle.db);
  engine = new IncidentEngine(incidents, timeline, audit);
});

async function openIncident() {
  return engine.open({
    organizationId: orgId,
    serviceId,
    title: 'checkout-api error rate 0.4% -> 17.8%',
    severity: 'SEV1',
  });
}

describe('IncidentEngine', () => {
  it('allocates sequential incident keys', async () => {
    expect((await openIncident()).key).toBe('INC-1');
    expect((await openIncident()).key).toBe('INC-2');
  });

  it('opens with attribution unset, because suspicion is not attribution', async () => {
    const incident = await openIncident();
    expect(incident.state).toBe('INCIDENT_OPEN');
    expect(incident.deploymentAttribution).toBeNull();
    expect(incident.attributionConfidence).toBeNull();
  });

  it('records the opening on the timeline', async () => {
    const incident = await openIncident();
    const events = await timeline.forIncident(incident.id);
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe('incident_opened');
    expect(events[0]!.toState).toBe('INCIDENT_OPEN');
  });

  it('applies a legal transition and appends to the timeline', async () => {
    const incident = await openIncident();
    const updated = await engine.transition(incident.id, {
      to: 'INVESTIGATING',
      summary: 'Investigation started',
    });
    expect(updated.state).toBe('INVESTIGATING');

    const events = await timeline.forIncident(incident.id);
    expect(events.map((e) => e.kind)).toEqual(['incident_opened', 'state_changed']);
    expect(events[1]!.fromState).toBe('INCIDENT_OPEN');
    expect(events[1]!.toState).toBe('INVESTIGATING');
  });

  it('refuses an illegal transition and leaves the state untouched', async () => {
    const incident = await openIncident();
    await expect(
      engine.transition(incident.id, { to: 'RESOLVED', summary: 'all good now' }),
    ).rejects.toThrow(InvalidTransitionError);

    expect((await incidents.byId(incident.id))!.state).toBe('INCIDENT_OPEN');
  });

  it('audits a refused transition rather than silently dropping it', async () => {
    // An agent repeatedly trying to jump to RESOLVED is exactly what an operator
    // needs to see.
    const incident = await openIncident();
    await expect(
      engine.transition(incident.id, { to: 'RESOLVED', summary: 'x', actor: 'agent:FixAgent' }),
    ).rejects.toThrow();

    const log = await audit.forIncident(incident.id);
    const denied = log.filter((l) => !l.allowed);
    expect(denied).toHaveLength(1);
    expect(denied[0]!.actor).toBe('agent:FixAgent');
    expect(denied[0]!.denialReason).toMatch(/INCIDENT_OPEN -> RESOLVED/);
  });

  it('only stamps resolvedAt when recovery has been verified', async () => {
    const incident = await openIncident();
    const path = [
      'INVESTIGATING', 'ROOT_CAUSE_SUSPECTED', 'REPRODUCING', 'ROOT_CAUSE_CONFIRMED',
      'FIXING', 'VALIDATING', 'FIX_READY', 'AWAITING_APPROVAL', 'APPROVED',
      'DEPLOYING_FIX', 'VERIFYING_RECOVERY',
    ] as const;
    for (const to of path) {
      await engine.transition(incident.id, { to, summary: to });
    }
    expect((await incidents.byId(incident.id))!.resolvedAt).toBeNull();

    await engine.transition(incident.id, { to: 'RESOLVED', summary: 'recovered' });
    const resolved = await incidents.byId(incident.id);
    expect(resolved!.resolvedAt).not.toBeNull();
    expect(await engine.isTerminal(incident.id)).toBe(true);
  });

  it('records an attribution verdict independently of state', async () => {
    const incident = await openIncident();
    await engine.transition(incident.id, { to: 'INVESTIGATING', summary: 'start' });
    await engine.recordAttribution(
      incident.id,
      'EXTERNAL_INCIDENT',
      0.88,
      'Errors began 21 minutes after deploy and originate in the payments SDK.',
    );

    const updated = await incidents.byId(incident.id);
    expect(updated!.deploymentAttribution).toBe('EXTERNAL_INCIDENT');
    expect(updated!.attributionConfidence).toBeCloseTo(0.88);
    // State is unchanged: a verdict is not a state change.
    expect(updated!.state).toBe('INVESTIGATING');

    const events = await timeline.forIncident(incident.id);
    expect(events.at(-1)!.kind).toBe('attribution_recorded');
  });

  it('lists open incidents and excludes resolved ones', async () => {
    const a = await openIncident();
    await openIncident();
    const path = [
      'INVESTIGATING', 'ROOT_CAUSE_SUSPECTED', 'ROOT_CAUSE_CONFIRMED', 'FIXING',
      'VALIDATING', 'FIX_READY', 'AWAITING_APPROVAL', 'APPROVED', 'DEPLOYING_FIX',
      'VERIFYING_RECOVERY', 'RESOLVED',
    ] as const;
    for (const to of path) await engine.transition(a.id, { to, summary: to });

    const open = await incidents.listOpen(orgId);
    expect(open.map((i) => i.key)).toEqual(['INC-2']);
  });

  it('appends a note without changing state', async () => {
    const incident = await openIncident();
    await engine.note(incident.id, { kind: 'slack_posted', summary: 'Notified #incidents' });

    expect((await incidents.byId(incident.id))!.state).toBe('INCIDENT_OPEN');
    const events = await timeline.forIncident(incident.id);
    expect(events.at(-1)!.kind).toBe('slack_posted');
    expect(events.at(-1)!.toState).toBeNull();
  });
});
