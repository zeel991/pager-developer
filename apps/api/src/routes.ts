import type { FastifyInstance } from 'fastify';
import {
  asc,
  desc,
  eq,
  sql,
  AgentRunRepository,
  AuditRepository,
  DeploymentRepository,
  EvidenceRepository,
  FixRepository,
  IncidentRepository,
  InvestigationRepository,
  TimelineRepository,
  deploymentCommits,
  deploymentFiles,
  deploymentPullRequests,
  deployments,
  incidents,
  organizations,
  services,
  telemetrySnapshots,
  type Database,
} from '@pager/db';

/**
 * Read API for the dashboard.
 *
 * Read-only by design at this stage. The only actions Pager can take that affect
 * anything are gated by the policy engine and require an approval, and exposing an
 * unauthenticated HTTP surface that could trigger them would defeat that. Approval
 * endpoints arrive with authentication, not before it.
 */

export interface RouteDeps {
  db: Database;
}

export async function registerRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  const { db } = deps;
  const incidentRepo = new IncidentRepository(db);
  const timeline = new TimelineRepository(db);
  const evidence = new EvidenceRepository(db);
  const agentRuns = new AgentRunRepository(db);
  const audit = new AuditRepository(db);
  const deploymentRepo = new DeploymentRepository(db);
  const investigations = new InvestigationRepository(db);
  const fixes = new FixRepository(db);

  app.get('/health', async () => ({ status: 'ok', at: new Date().toISOString() }));

  /** Overview: production health at a glance. */
  app.get('/api/overview', async () => {
    const [org] = await db.select().from(organizations).limit(1);
    if (!org) {
      return { organization: null, incidents: [], deployments: [], counts: emptyCounts() };
    }

    const allIncidents = await db
      .select()
      .from(incidents)
      .where(eq(incidents.organizationId, org.id))
      .orderBy(desc(incidents.openedAt));

    const recentDeployments = await db
      .select()
      .from(deployments)
      .where(eq(deployments.organizationId, org.id))
      .orderBy(desc(deployments.startedAt))
      .limit(10);

    const open = allIncidents.filter((i) => i.resolvedAt === null);
    return {
      organization: { id: org.id, name: org.name, autonomyLevel: org.autonomyLevel },
      incidents: allIncidents.slice(0, 20),
      deployments: recentDeployments,
      counts: {
        activeIncidents: open.length,
        investigating: open.filter((i) => i.state === 'INVESTIGATING').length,
        awaitingApproval: open.filter((i) => i.state === 'AWAITING_APPROVAL').length,
        resolved: allIncidents.filter((i) => i.resolvedAt !== null).length,
        deploymentsTracked: recentDeployments.length,
        // An incident with no attribution yet is the honest default, and worth
        // surfacing: it is the queue of things still genuinely unknown.
        unattributed: open.filter((i) => i.deploymentAttribution === null).length,
      },
    };
  });

  app.get('/api/incidents', async () => {
    const rows = await db.select().from(incidents).orderBy(desc(incidents.openedAt));
    return { incidents: rows };
  });

  /** The incident page: everything known about one incident, in one payload. */
  app.get<{ Params: { id: string } }>('/api/incidents/:id', async (request, reply) => {
    const incident = await incidentRepo.byId(request.params.id);
    if (!incident) return reply.code(404).send({ error: 'Incident not found' });

    const [service] = await db.select().from(services).where(eq(services.id, incident.serviceId)).limit(1);

    const deployment = incident.suspectedDeploymentId
      ? await deploymentRepo.byId(incident.suspectedDeploymentId)
      : null;

    const [files, commits, prs] = deployment
      ? await Promise.all([
          db.select().from(deploymentFiles).where(eq(deploymentFiles.deploymentId, deployment.id)),
          db.select().from(deploymentCommits).where(eq(deploymentCommits.deploymentId, deployment.id)),
          db.select().from(deploymentPullRequests).where(eq(deploymentPullRequests.deploymentId, deployment.id)),
        ])
      : [[], [], []];

    const runs = await agentRuns.forIncident(incident.id);
    const runsWithCalls = await Promise.all(
      runs.map(async (run) => ({ ...run, toolCalls: await agentRuns.toolCallsForRun(run.id) })),
    );

    // Joined on the service, not the deployment: an alert-driven incident has
    // telemetry but may have no deployment associated with it at all.
    const snapshots = await db
      .select()
      .from(telemetrySnapshots)
      .where(eq(telemetrySnapshots.serviceId, incident.serviceId))
      .orderBy(asc(telemetrySnapshots.metric));

    return {
      incident,
      service: service ?? null,
      deployment: deployment ? { ...deployment, files, commits, pullRequests: prs } : null,
      timeline: await timeline.forIncident(incident.id),
      evidence: await evidence.forIncident(incident.id),
      agentRuns: runsWithCalls,
      auditLog: await audit.forIncident(incident.id),
      telemetry: snapshots,
      // What was inferred, kept separate from what was observed. The incident page
      // renders them differently, so a reader can always tell a model's conclusion
      // from a reading.
      investigations: await investigations.forIncident(incident.id),
      hypotheses: await investigations.hypothesesForIncident(incident.id),
      // The proposed fix, with the exit codes of every check that really ran.
      fixes: await fixes.forIncident(incident.id),
    };
  });

  app.get('/api/deployments', async () => {
    const rows = await db.select().from(deployments).orderBy(desc(deployments.startedAt)).limit(50);
    return { deployments: rows };
  });

  app.get<{ Params: { id: string } }>('/api/deployments/:id', async (request, reply) => {
    const deployment = await deploymentRepo.byId(request.params.id);
    if (!deployment) return reply.code(404).send({ error: 'Deployment not found' });
    const [files, commits, prs] = await Promise.all([
      db.select().from(deploymentFiles).where(eq(deploymentFiles.deploymentId, deployment.id)),
      db.select().from(deploymentCommits).where(eq(deploymentCommits.deploymentId, deployment.id)),
      db.select().from(deploymentPullRequests).where(eq(deploymentPullRequests.deploymentId, deployment.id)),
    ]);
    return { deployment, files, commits, pullRequests: prs };
  });

  app.get('/api/services', async () => {
    const rows = await db.select().from(services);
    return { services: rows };
  });

  /** Agent observability: every run, and how its tool calls went. */
  app.get('/api/agent-runs', async () => {
    const rows = await db.execute(
      sql`select agent_name, status, count(*)::int as runs,
                 avg(extract(epoch from (ended_at - started_at)) * 1000)::int as avg_ms
          from agent_runs group by agent_name, status order by agent_name`,
    );
    const toolStats = await db.execute(
      sql`select tool_name, status, count(*)::int as calls,
                 avg(duration_ms)::int as avg_ms
          from tool_calls group by tool_name, status order by calls desc`,
    );
    return { agents: rowsOf(rows), tools: rowsOf(toolStats) };
  });
}

function rowsOf(result: unknown): unknown[] {
  if (Array.isArray(result)) return result;
  const withRows = result as { rows?: unknown[] };
  return withRows.rows ?? [];
}

function emptyCounts() {
  return {
    activeIncidents: 0,
    investigating: 0,
    awaitingApproval: 0,
    resolved: 0,
    deploymentsTracked: 0,
    unattributed: 0,
  };
}
