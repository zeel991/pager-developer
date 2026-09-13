import {
  InvalidTransitionError,
  assertTransition,
  isTerminal,
  type IncidentState,
} from '@pager/core';
import type {
  AuditRepository,
  IncidentRepository,
  IncidentRow,
  TimelineRepository,
} from '@pager/db';

/**
 * The incident engine.
 *
 * Owns every state change. Agents propose transitions; this decides whether they are
 * legal and records what happened. Nothing else is permitted to write
 * `incidents.state`, which is what keeps the state machine from becoming decorative.
 *
 * Three things happen together on every transition, in this order:
 *   1. the transition is validated against the allow-list
 *   2. the incident row is updated
 *   3. the timeline gains an entry
 *
 * A rejected transition still produces an audit record. An agent repeatedly trying to
 * jump straight to RESOLVED is exactly the behaviour an operator needs to see, and
 * silently refusing would hide it.
 */

export interface TransitionInput {
  to: IncidentState;
  /** Human-readable reason. Appears on the incident timeline. */
  summary: string;
  agentRunId?: string | null;
  detail?: Record<string, unknown>;
  actor?: string;
}

export class IncidentEngine {
  constructor(
    private readonly incidents: IncidentRepository,
    private readonly timeline: TimelineRepository,
    private readonly audit: AuditRepository,
  ) {}

  async open(input: {
    organizationId: string;
    serviceId: string;
    title: string;
    severity: 'SEV1' | 'SEV2' | 'SEV3' | 'SEV4';
    suspectedDeploymentId?: string | null;
    keyPrefix?: string;
  }): Promise<IncidentRow> {
    const key = await this.incidents.nextKey(input.organizationId, input.keyPrefix);
    const incident = await this.incidents.create({
      organizationId: input.organizationId,
      serviceId: input.serviceId,
      key,
      title: input.title,
      severity: input.severity,
      state: 'INCIDENT_OPEN',
      suspectedDeploymentId: input.suspectedDeploymentId ?? null,
      // Deliberately null. A deployment being suspected is not an attribution, and
      // leaving this unset until Phase 3 produces evidence is the whole point.
      deploymentAttribution: null,
    });

    await this.timeline.append({
      incidentId: incident.id,
      kind: 'incident_opened',
      summary: input.title,
      toState: 'INCIDENT_OPEN',
      detail: { severity: input.severity },
    });

    return incident;
  }

  /** Apply a state transition, or throw and audit the refusal. */
  async transition(incidentId: string, input: TransitionInput): Promise<IncidentRow> {
    const incident = await this.incidents.byId(incidentId);
    if (!incident) throw new Error(`Unknown incident ${incidentId}`);

    const from = incident.state as IncidentState;
    try {
      assertTransition(from, input.to);
    } catch (err) {
      if (err instanceof InvalidTransitionError) {
        await this.audit.record({
          organizationId: incident.organizationId,
          incidentId,
          actor: input.actor ?? 'system',
          action: `incident.transition:${from}->${input.to}`,
          allowed: false,
          denialReason: err.message,
          detail: { summary: input.summary },
        });
      }
      throw err;
    }

    const patch: Parameters<IncidentRepository['update']>[1] = { state: input.to };
    // Only VERIFYING_RECOVERY reaches RESOLVED, so this is the one place a
    // resolution timestamp can be set.
    if (input.to === 'RESOLVED') patch.resolvedAt = new Date();

    const updated = await this.incidents.update(incidentId, patch);

    await this.timeline.append({
      incidentId,
      kind: 'state_changed',
      summary: input.summary,
      fromState: from,
      toState: input.to,
      agentRunId: input.agentRunId ?? null,
      detail: input.detail ?? null,
    });

    await this.audit.record({
      organizationId: incident.organizationId,
      incidentId,
      actor: input.actor ?? 'system',
      action: `incident.transition:${from}->${input.to}`,
      allowed: true,
      detail: { summary: input.summary },
    });

    return updated;
  }

  /** Record something that happened without changing state. */
  async note(
    incidentId: string,
    input: { kind: string; summary: string; agentRunId?: string | null; detail?: Record<string, unknown> },
  ): Promise<void> {
    await this.timeline.append({
      incidentId,
      kind: input.kind,
      summary: input.summary,
      agentRunId: input.agentRunId ?? null,
      detail: input.detail ?? null,
    });
  }

  /**
   * Record a deployment attribution verdict.
   *
   * Separate from `transition` because attribution and state are independent: an
   * incident can be INVESTIGATING with attribution still unknown, and concluding
   * EXTERNAL_INCIDENT is a verdict before it is a state change.
   */
  async recordAttribution(
    incidentId: string,
    verdict: 'DEPLOYMENT_LIKELY_RESPONSIBLE' | 'DEPLOYMENT_NOT_RESPONSIBLE' | 'INSUFFICIENT_EVIDENCE' | 'EXTERNAL_INCIDENT',
    confidence: number,
    rationale: string,
  ): Promise<void> {
    await this.incidents.update(incidentId, {
      deploymentAttribution: verdict,
      attributionConfidence: confidence,
    });
    await this.timeline.append({
      incidentId,
      kind: 'attribution_recorded',
      summary: rationale,
      detail: { verdict, confidence },
    });
  }

  async isTerminal(incidentId: string): Promise<boolean> {
    const incident = await this.incidents.byId(incidentId);
    return incident ? isTerminal(incident.state as IncidentState) : false;
  }
}
