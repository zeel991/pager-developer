import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { Database } from './client.js';
import {
  agentRuns,
  auditLogs,
  deploymentCommits,
  deploymentFiles,
  deploymentPullRequests,
  deployments,
  evidence,
  fixCandidateFiles,
  fixCandidates,
  hypotheses,
  incidentEvents,
  incidents,
  investigations,
  reproductions,
  telemetrySnapshots,
  toolCalls,
  validationRuns,
} from './schema.js';

/**
 * Repositories.
 *
 * Deliberately thin: query construction lives here so the agents never hold a
 * database handle, but nothing here makes decisions. The one piece of judgement is
 * ordering — timelines read oldest-first because they are narratives, while
 * deployments read newest-first because you almost always want the last one.
 */

export type NewIncident = typeof incidents.$inferInsert;
export type IncidentRow = typeof incidents.$inferSelect;
export type IncidentEventRow = typeof incidentEvents.$inferSelect;
export type EvidenceRow = typeof evidence.$inferSelect;
export type DeploymentRow = typeof deployments.$inferSelect;
export type InvestigationRow = typeof investigations.$inferSelect;
export type FixCandidateRow = typeof fixCandidates.$inferSelect;
export type ValidationRunRow = typeof validationRuns.$inferSelect;
export type ReproductionRow = typeof reproductions.$inferSelect;

export class IncidentRepository {
  constructor(private readonly db: Database) {}

  async create(input: NewIncident): Promise<IncidentRow> {
    const [row] = await this.db.insert(incidents).values(input).returning();
    return row!;
  }

  async byId(id: string): Promise<IncidentRow | null> {
    const [row] = await this.db.select().from(incidents).where(eq(incidents.id, id)).limit(1);
    return row ?? null;
  }

  async byKey(organizationId: string, key: string): Promise<IncidentRow | null> {
    const [row] = await this.db
      .select()
      .from(incidents)
      .where(and(eq(incidents.organizationId, organizationId), eq(incidents.key, key)))
      .limit(1);
    return row ?? null;
  }

  async update(id: string, patch: Partial<NewIncident>): Promise<IncidentRow> {
    const [row] = await this.db.update(incidents).set(patch).where(eq(incidents.id, id)).returning();
    return row!;
  }

  async listOpen(organizationId: string): Promise<IncidentRow[]> {
    const rows = await this.db
      .select()
      .from(incidents)
      .where(eq(incidents.organizationId, organizationId))
      .orderBy(desc(incidents.openedAt));
    return rows.filter((r) => r.resolvedAt === null);
  }

  /** The next incident key for an organisation, e.g. INC-184. */
  async nextKey(organizationId: string, prefix = 'INC'): Promise<string> {
    const rows = await this.db
      .select({ key: incidents.key })
      .from(incidents)
      .where(eq(incidents.organizationId, organizationId));
    const highest = rows.reduce((max, r) => {
      const n = Number(/-(\d+)$/.exec(r.key)?.[1] ?? 0);
      return Number.isFinite(n) ? Math.max(max, n) : max;
    }, 0);
    return `${prefix}-${highest + 1}`;
  }
}

export class TimelineRepository {
  constructor(private readonly db: Database) {}

  async append(input: typeof incidentEvents.$inferInsert): Promise<IncidentEventRow> {
    const [row] = await this.db.insert(incidentEvents).values(input).returning();
    return row!;
  }

  /** Oldest first: a timeline is read as a narrative. */
  async forIncident(incidentId: string): Promise<IncidentEventRow[]> {
    return this.db
      .select()
      .from(incidentEvents)
      .where(eq(incidentEvents.incidentId, incidentId))
      .orderBy(asc(incidentEvents.at));
  }
}

export class EvidenceRepository {
  constructor(private readonly db: Database) {}

  /**
   * Record evidence. The `sourceToolCallId` FK means the database itself refuses
   * evidence that no tool call produced, so a fabricated citation fails here even
   * if it slipped past the application-level gate.
   */
  async record(input: typeof evidence.$inferInsert): Promise<EvidenceRow> {
    const [row] = await this.db.insert(evidence).values(input).returning();
    return row!;
  }

  async forIncident(incidentId: string): Promise<EvidenceRow[]> {
    return this.db
      .select()
      .from(evidence)
      .where(eq(evidence.incidentId, incidentId))
      .orderBy(asc(evidence.collectedAt));
  }
}

export class DeploymentRepository {
  constructor(private readonly db: Database) {}

  async create(
    input: typeof deployments.$inferInsert,
    detail: {
      commits?: Omit<typeof deploymentCommits.$inferInsert, 'deploymentId'>[];
      files?: Omit<typeof deploymentFiles.$inferInsert, 'deploymentId'>[];
      pullRequests?: Omit<typeof deploymentPullRequests.$inferInsert, 'deploymentId'>[];
    } = {},
  ): Promise<DeploymentRow> {
    const [row] = await this.db.insert(deployments).values(input).returning();
    const deploymentId = row!.id;

    if (detail.commits?.length) {
      await this.db.insert(deploymentCommits).values(detail.commits.map((c) => ({ ...c, deploymentId })));
    }
    if (detail.files?.length) {
      await this.db.insert(deploymentFiles).values(detail.files.map((f) => ({ ...f, deploymentId })));
    }
    if (detail.pullRequests?.length) {
      await this.db
        .insert(deploymentPullRequests)
        .values(detail.pullRequests.map((p) => ({ ...p, deploymentId })));
    }
    return row!;
  }

  async byId(id: string): Promise<DeploymentRow | null> {
    const [row] = await this.db.select().from(deployments).where(eq(deployments.id, id)).limit(1);
    return row ?? null;
  }

  /** Newest first: the question is almost always "what shipped most recently". */
  async recentForService(serviceId: string, limit = 20): Promise<DeploymentRow[]> {
    return this.db
      .select()
      .from(deployments)
      .where(eq(deployments.serviceId, serviceId))
      .orderBy(desc(deployments.startedAt))
      .limit(limit);
  }

  async changedFiles(deploymentId: string): Promise<(typeof deploymentFiles.$inferSelect)[]> {
    return this.db.select().from(deploymentFiles).where(eq(deploymentFiles.deploymentId, deploymentId));
  }
}

export class TelemetryRepository {
  constructor(private readonly db: Database) {}

  async record(input: typeof telemetrySnapshots.$inferInsert): Promise<string> {
    const [row] = await this.db.insert(telemetrySnapshots).values(input).returning();
    return row!.id;
  }
}

export class AuditRepository {
  constructor(private readonly db: Database) {}

  /** Append-only. Denied actions are recorded as emphatically as allowed ones. */
  async record(input: typeof auditLogs.$inferInsert): Promise<void> {
    await this.db.insert(auditLogs).values(input);
  }

  async forIncident(incidentId: string): Promise<(typeof auditLogs.$inferSelect)[]> {
    return this.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.incidentId, incidentId))
      .orderBy(asc(auditLogs.at));
  }
}

export class AgentRunRepository {
  constructor(private readonly db: Database) {}

  /**
   * Attach already-finished runs to an incident.
   *
   * Detection necessarily happens before an incident exists, so the observer and
   * detector runs start with a null incident id. They are the runs that produced the
   * incident, and an incident page that omitted them would hide the evidence trail
   * that opened it — so they are linked once the incident has an id. Tool calls are
   * relinked too, since evidence cites them.
   */
  async attachToIncident(runIds: string[], incidentId: string): Promise<void> {
    if (runIds.length === 0) return;
    await this.db
      .update(agentRuns)
      .set({ incidentId })
      .where(and(inArray(agentRuns.id, runIds), isNull(agentRuns.incidentId)));
    await this.db
      .update(toolCalls)
      .set({ incidentId })
      .where(and(inArray(toolCalls.agentRunId, runIds), isNull(toolCalls.incidentId)));
  }

  async forIncident(incidentId: string): Promise<(typeof agentRuns.$inferSelect)[]> {
    return this.db
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.incidentId, incidentId))
      .orderBy(asc(agentRuns.startedAt));
  }

  async toolCallsForRun(agentRunId: string): Promise<(typeof toolCalls.$inferSelect)[]> {
    return this.db
      .select()
      .from(toolCalls)
      .where(eq(toolCalls.agentRunId, agentRunId))
      .orderBy(asc(toolCalls.startedAt));
  }
}


/**
 * What the reasoning step concluded, and what supported it.
 *
 * Separate from Evidence on purpose. Evidence is what was observed; an investigation
 * is what was inferred from it, and the incident page renders the two differently so
 * a reader can always tell a reading from a conclusion.
 */
export class InvestigationRepository {
  constructor(private readonly db: Database) {}

  async record(input: {
    incidentId: string;
    agentRunId?: string | null;
    suspectedRootCause: string | null;
    deploymentAttribution: InvestigationRow['deploymentAttribution'];
    attributionRationale: string | null;
    confidence: number;
    nextActions: string[];
    /** Ranked statements, with the uncertainty carried as one of them. */
    hypotheses?: { description: string; confidence: number | null; status: 'HYPOTHESIS' | 'OBSERVATION' | 'FACT' }[];
  }): Promise<InvestigationRow> {
    const [row] = await this.db
      .insert(investigations)
      .values({
        incidentId: input.incidentId,
        // Only set when the run is one this database actually holds, so a foreign
        // key never fails on a run the tracer wrote elsewhere.
        ...(input.agentRunId ? { agentRunId: input.agentRunId } : {}),
        suspectedRootCause: input.suspectedRootCause,
        deploymentAttribution: input.deploymentAttribution,
        attributionRationale: input.attributionRationale,
        confidence: input.confidence,
        nextActions: input.nextActions,
      })
      .returning();

    for (const [index, h] of (input.hypotheses ?? []).entries()) {
      await this.db.insert(hypotheses).values({
        investigationId: row!.id,
        incidentId: input.incidentId,
        status: h.status,
        description: h.description,
        confidence: h.confidence,
        rank: index,
      });
    }
    return row!;
  }

  async forIncident(incidentId: string): Promise<InvestigationRow[]> {
    return this.db
      .select()
      .from(investigations)
      .where(eq(investigations.incidentId, incidentId))
      .orderBy(asc(investigations.createdAt));
  }

  async hypothesesForIncident(incidentId: string): Promise<(typeof hypotheses.$inferSelect)[]> {
    return this.db
      .select()
      .from(hypotheses)
      .where(eq(hypotheses.incidentId, incidentId))
      .orderBy(asc(hypotheses.rank));
  }
}

/**
 * The proposed fix, its reproduction, and every check that really ran.
 *
 * `validationRuns` carries an exit code from a real process. This table is the
 * answer to "did the agent actually run the checks it claims", and it is the reason
 * the incident page can show before-and-after rather than an assertion.
 */
export class FixRepository {
  constructor(private readonly db: Database) {}

  async record(input: {
    incidentId: string;
    repositoryId: string;
    branch: string;
    commitSha: string | null;
    rootCause: string;
    explanation: string;
    risks: string[];
    rollbackPlan: string;
    confidence: number;
    pullRequestNumber: number | null;
    pullRequestUrl: string | null;
    files: { path: string }[];
    reproduction: {
      command: string;
      environmentDescription: string;
      beforeFixExitCode: number | null;
      beforeFixPassed: boolean | null;
      afterFixExitCode: number | null;
      afterFixPassed: boolean | null;
      beforeFixOutput: string | null;
      afterFixOutput: string | null;
    } | null;
    /** Only checks that RAN. A skipped check is not recorded as a run. */
    validation: {
      kind: string;
      command: string;
      exitCode: number;
      passed: boolean;
      testsPassed: number | null;
      testsFailed: number | null;
      durationMs: number;
      output: string;
    }[];
  }): Promise<FixCandidateRow> {
    let reproductionId: string | null = null;
    if (input.reproduction) {
      const [row] = await this.db.insert(reproductions).values({
        incidentId: input.incidentId,
        ...input.reproduction,
      }).returning();
      reproductionId = row!.id;
    }

    const [fix] = await this.db
      .insert(fixCandidates)
      .values({
        incidentId: input.incidentId,
        repositoryId: input.repositoryId,
        branch: input.branch,
        commitSha: input.commitSha,
        rootCause: input.rootCause,
        explanation: input.explanation,
        risks: input.risks,
        rollbackPlan: input.rollbackPlan,
        confidence: input.confidence,
        pullRequestNumber: input.pullRequestNumber,
        pullRequestUrl: input.pullRequestUrl,
        ...(reproductionId ? { reproductionId } : {}),
      })
      .returning();

    for (const file of input.files) {
      await this.db.insert(fixCandidateFiles).values({ fixCandidateId: fix!.id, path: file.path });
    }
    for (const run of input.validation) {
      await this.db.insert(validationRuns).values({ fixCandidateId: fix!.id, ...run });
    }
    return fix!;
  }

  async forIncident(incidentId: string): Promise<
    (FixCandidateRow & {
      files: (typeof fixCandidateFiles.$inferSelect)[];
      validation: ValidationRunRow[];
      reproduction: ReproductionRow | null;
    })[]
  > {
    const rows = await this.db
      .select()
      .from(fixCandidates)
      .where(eq(fixCandidates.incidentId, incidentId))
      .orderBy(asc(fixCandidates.createdAt));

    return Promise.all(
      rows.map(async (row) => {
        const [files, validation, repro] = await Promise.all([
          this.db.select().from(fixCandidateFiles).where(eq(fixCandidateFiles.fixCandidateId, row.id)),
          this.db.select().from(validationRuns).where(eq(validationRuns.fixCandidateId, row.id)),
          row.reproductionId
            ? this.db.select().from(reproductions).where(eq(reproductions.id, row.reproductionId)).limit(1)
            : Promise.resolve([]),
        ]);
        return { ...row, files, validation, reproduction: repro[0] ?? null };
      }),
    );
  }
}
