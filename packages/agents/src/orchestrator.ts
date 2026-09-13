import type { IncidentState } from '@pager/core';
import type {
  DeploymentRecord,
  MessagingProvider,
  ObservabilityProvider,
  SourceControlProvider,
} from '@pager/providers';
import type { AgentTracer } from '@pager/observability';
import type {
  AgentRunRepository,
  DeploymentRepository,
  EvidenceRepository,
  IncidentRepository,
  IncidentRow,
  TelemetryRepository,
} from '@pager/db';
import { DeploymentObserver, type ReconstructedDeployment } from './deployment-observer.js';
import { collectWindows, type TelemetryCollection } from './telemetry-collector.js';
import { detectRegressions, worstRegression, type DetectionResult, type Regression } from './regression-detector.js';
import { IncidentEngine } from './incident-engine.js';
import { CommunicationAgent, formatOpening } from './communication.js';

/**
 * The incident pipeline.
 *
 * Deterministic orchestration around the agents, as the brief requires: application
 * code decides what happens next and what is permitted, while the model — when one
 * is configured — only ever supplies judgement inside a step.
 *
 * This runs from "a deployment happened" to "an incident is open, the team has been
 * told, and the evidence is recorded". It deliberately stops before attribution:
 * deciding whether the deployment is responsible needs the investigator, and
 * guessing here is exactly the failure this system is built to avoid.
 */

export interface PipelineDeps {
  sourceControl: SourceControlProvider;
  observability: ObservabilityProvider;
  messaging: MessagingProvider | null;
  tracer: AgentTracer;
  incidents: IncidentRepository;
  deployments: DeploymentRepository;
  evidence: EvidenceRepository;
  telemetry: TelemetryRepository;
  agentRuns: AgentRunRepository;
  engine: IncidentEngine;
}

export interface PipelineInput {
  organizationId: string;
  serviceId: string;
  repositoryId: string;
  deployment: DeploymentRecord;
  slackChannel?: string | null;
}

export interface PipelineOutcome {
  deploymentId: string;
  reconstruction: ReconstructedDeployment;
  detection: DetectionResult;
  worst: Regression | null;
  incident: IncidentRow | null;
  /** Why no incident was opened, when none was. */
  noIncidentReason: string | null;
  evidenceIds: string[];
  slackThreadTs: string | null;
  finalState: IncidentState | null;
}

export class IncidentPipeline {
  constructor(private readonly deps: PipelineDeps) {}

  async run(input: PipelineInput): Promise<PipelineOutcome> {
    const { deps } = this;

    // Runs made before an incident exists are collected so they can be linked to
    // it once it has an id.
    const preIncidentRuns: string[] = [];

    // ── Phase 1: what changed ────────────────────────────────────────────────
    const reconstruction = await new DeploymentObserver(deps.sourceControl, deps.tracer).observe(
      input.deployment,
      {},
      (runId) => preIncidentRuns.push(runId),
    );

    const deploymentRow = await deps.deployments.create(
      {
        organizationId: input.organizationId,
        serviceId: input.serviceId,
        repositoryId: input.repositoryId,
        externalId: input.deployment.id,
        environment: input.deployment.environment,
        status: input.deployment.status,
        commitSha: input.deployment.commitSha,
        previousCommitSha: input.deployment.previousCommitSha,
        authorName: input.deployment.author,
        startedAt: input.deployment.startedAt,
        deployedAt: input.deployment.deployedAt,
        completedAt: input.deployment.deployedAt,
        baselineFrom: reconstruction.baselineWindow.from,
        baselineTo: reconstruction.baselineWindow.to,
        observationFrom: reconstruction.observationWindow.from,
        observationTo: reconstruction.observationWindow.to,
      },
      {
        commits: reconstruction.commits.map((c) => ({
          sha: c.sha,
          message: c.message,
          authorName: c.authorName,
          authorEmail: c.authorEmail ?? null,
          committedAt: c.committedAt,
        })),
        files: reconstruction.changedFiles.map((f) => ({
          path: f.path,
          status: f.status,
          additions: f.additions,
          deletions: f.deletions,
          previousPath: f.previousPath ?? null,
        })),
        pullRequests: reconstruction.pullRequests.map((p) => ({
          number: p.number,
          title: p.title,
          url: p.url,
        })),
      },
    );

    // ── Phase 2: did production materially change ────────────────────────────
    const { detection, collection } = await deps.tracer.run(
      'RegressionDetector',
      { input: { deploymentId: deploymentRow.id } },
      async (ctx) => {
        preIncidentRuns.push(ctx.agentRunId);
        const collected = await collectWindows(
          ctx,
          deps.observability,
          input.deployment.service,
          reconstruction.baselineWindow,
          reconstruction.observationWindow,
        );
        return { detection: detectRegressions(collected.windows), collection: collected };
      },
    );

    const worst = worstRegression(detection);

    if (!worst) {
      // No incident. The reason is recorded so a later review can tell "we looked
      // and it was fine" from "we never looked".
      return {
        deploymentId: deploymentRow.id,
        reconstruction,
        detection,
        worst: null,
        incident: null,
        noIncidentReason:
          detection.inconclusive.length > 0
            ? `No regression detected, but ${detection.inconclusive.length} metric(s) were inconclusive: ` +
              detection.inconclusive.map((i) => i.metric).join(', ')
            : `No material change across ${detection.dismissed.length} metrics examined.`,
        evidenceIds: [],
        slackThreadTs: null,
        finalState: null,
      };
    }

    // ── Incident opened ──────────────────────────────────────────────────────
    const incident = await deps.engine.open({
      organizationId: input.organizationId,
      serviceId: input.serviceId,
      title: `${input.deployment.service} ${worst.metric} regression`,
      severity: worst.severity,
      suspectedDeploymentId: deploymentRow.id,
    });

    // The observer and detector runs belong to this incident: they are what opened it.
    await deps.agentRuns.attachToIncident(preIncidentRuns, incident.id);

    const evidenceIds = await this.recordTelemetryEvidence(
      incident.id,
      input.serviceId,
      deploymentRow.id,
      collection,
      detection,
    );

    // ── Phase 4: tell the team ───────────────────────────────────────────────
    let slackThreadTs: string | null = null;
    if (deps.messaging && input.slackChannel) {
      slackThreadTs = await this.notify(incident, input, worst, reconstruction);
    }

    // ── Phase 3 boundary ─────────────────────────────────────────────────────
    await deps.engine.transition(incident.id, {
      to: 'INVESTIGATING',
      summary: 'Investigation started.',
    });

    // Attribution is deliberately left unset. The pipeline has established that
    // production changed and that a deployment preceded it — which is correlation,
    // and correlation is not a verdict.
    await deps.engine.note(incident.id, {
      kind: 'attribution_pending',
      summary:
        'Deployment attribution not determined. Timing alone is correlation; a verdict ' +
        'requires evidence from the investigator.',
    });

    const current = await deps.incidents.byId(incident.id);
    return {
      deploymentId: deploymentRow.id,
      reconstruction,
      detection,
      worst,
      incident: current,
      noIncidentReason: null,
      evidenceIds,
      slackThreadTs,
      finalState: (current?.state ?? null) as IncidentState | null,
    };
  }

  /**
   * Persist telemetry and record it as evidence.
   *
   * Every snapshot cites the tool call that fetched it, and the derived regression
   * is marked DERIVED rather than OBSERVED — a computed percentage change is not a
   * thing anyone saw.
   */
  private async recordTelemetryEvidence(
    incidentId: string,
    serviceId: string,
    deploymentId: string,
    collection: TelemetryCollection,
    detection: DetectionResult,
  ): Promise<string[]> {
    const ids: string[] = [];

    for (const window of collection.windows) {
      for (const [series, toolCallId, kind] of [
        [window.baseline, window.baselineToolCallId, 'baseline'],
        [window.observed, window.observedToolCallId, 'observation'],
      ] as const) {
        const values = series.points.map((p) => p.value);
        await this.deps.telemetry.record({
          serviceId,
          deploymentId,
          metric: series.metric,
          windowKind: kind,
          windowFrom: series.points[0]?.at ?? new Date(),
          windowTo: series.points.at(-1)?.at ?? new Date(),
          unit: series.unit,
          sampleCount: values.length,
          mean: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null,
          min: values.length ? Math.min(...values) : null,
          max: values.length ? Math.max(...values) : null,
          points: series.points.map((p) => ({ at: p.at.toISOString(), value: p.value })),
          sourceToolCallId: toolCallId,
        });
      }
    }

    for (const regression of detection.regressions) {
      const window = collection.windows.find((w) => w.baseline.metric === regression.metric);
      if (!window) continue;
      const row = await this.deps.evidence.record({
        incidentId,
        kind: 'DATADOG_METRIC',
        provenance: 'DERIVED',
        summary: regression.rationale,
        sourceToolCallId: window.observedToolCallId,
        sourceRef: `metric:${regression.metric}`,
        payload: {
          metric: regression.metric,
          baseline: regression.baseline,
          observed: regression.observed,
          severity: regression.severity,
          confidence: regression.confidence,
        },
      });
      ids.push(row.id);
    }

    return ids;
  }

  private async notify(
    incident: IncidentRow,
    input: PipelineInput,
    worst: Regression,
    reconstruction: ReconstructedDeployment,
  ): Promise<string | null> {
    const comms = new CommunicationAgent(this.deps.messaging!);
    const isRate = !worst.metric.startsWith('latency') && worst.metric !== 'request_throughput';
    const label = (n: number) => (isRate ? `${(n * 100).toFixed(2)}%` : n.toFixed(1));

    const text = formatOpening(
      { key: incident.key, service: input.deployment.service, severity: incident.severity, title: incident.title },
      {
        metric: worst.metric,
        baselineLabel: label(worst.baseline),
        observedLabel: label(worst.observed),
        severity: worst.severity,
      },
      {
        shortSha: input.deployment.commitSha.slice(0, 8),
        author: input.deployment.author,
        deployedAt: input.deployment.deployedAt ?? input.deployment.startedAt,
        pullRequest: reconstruction.pullRequests[0] ? `#${reconstruction.pullRequests[0].number}` : null,
      },
      'UNDER_INVESTIGATION',
    );

    return this.deps.tracer.run(
      'CommunicationAgent',
      { incidentId: incident.id },
      async (ctx) => {
        const thread = await comms.openThread(ctx, input.slackChannel!, text);
        await this.deps.engine.note(incident.id, {
          kind: 'slack_posted',
          summary: `Incident posted to ${input.slackChannel}`,
          detail: { threadTs: thread.id },
        });
        await this.deps.incidents.update(incident.id, {
          slackChannel: thread.channel,
          slackThreadTs: thread.id,
        });
        return thread.id;
      },
    ).catch(async (err) => {
      // A failed notification must not abort the incident, but it must be visible:
      // an incident nobody was told about is a worse outcome than a noisy one.
      await this.deps.engine.note(incident.id, {
        kind: 'slack_failed',
        summary: `Could not notify ${input.slackChannel}: ${err instanceof Error ? err.message : String(err)}`,
      });
      return null;
    });
  }
}
