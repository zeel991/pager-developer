import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { INCIDENT_STATES } from '@pager/core';

/**
 * Relational schema for the entities in §16.
 *
 * The rule followed throughout: anything the product queries, filters, joins or
 * audits on is a column. `jsonb` is reserved for genuinely opaque payloads — a
 * provider's raw response body, a tool call's arguments — where imposing a column
 * shape would be inventing structure the vendor does not guarantee.
 */

export const environmentEnum = pgEnum('environment', ['production', 'staging', 'development']);
export const deploymentStatusEnum = pgEnum('deployment_status', [
  'pending', 'in_progress', 'succeeded', 'failed', 'rolled_back',
]);
export const incidentStateEnum = pgEnum('incident_state', INCIDENT_STATES);
export const severityEnum = pgEnum('severity', ['SEV1', 'SEV2', 'SEV3', 'SEV4']);
export const claimStatusEnum = pgEnum('claim_status', ['HYPOTHESIS', 'OBSERVATION', 'FACT']);
export const provenanceEnum = pgEnum('provenance', ['OBSERVED', 'DERIVED']);
export const attributionEnum = pgEnum('deployment_attribution', [
  'DEPLOYMENT_LIKELY_RESPONSIBLE',
  'DEPLOYMENT_NOT_RESPONSIBLE',
  'INSUFFICIENT_EVIDENCE',
  'EXTERNAL_INCIDENT',
]);
export const riskEnum = pgEnum('risk_level', ['READ_ONLY', 'WRITE_NON_PRODUCTION', 'PRODUCTION_WRITE']);
export const runStatusEnum = pgEnum('run_status', ['RUNNING', 'OK', 'ERROR']);
export const toolStatusEnum = pgEnum('tool_status', ['OK', 'ERROR']);
export const approvalDecisionEnum = pgEnum('approval_decision', [
  'APPROVED', 'REJECTED', 'ROLLBACK_INSTEAD',
]);

export const organizations = pgTable('organizations', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  /** Autonomy ceiling for this org. Raising it is an explicit operator act. */
  autonomyLevel: text('autonomy_level').notNull().default('L3'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id),
  email: text('email').notNull(),
  name: text('name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex('users_org_email_idx').on(t.organizationId, t.email)]);

export const integrations = pgTable('integrations', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id),
  /** 'github' | 'datadog' | 'slack' | ... */
  provider: text('provider').notNull(),
  /** 'arga' | 'real' | 'local' — which backend this integration resolves to. */
  backend: text('backend').notNull(),
  /** Arga twin run id, when backend is 'arga'. */
  twinRunId: text('twin_run_id'),
  baseUrl: text('base_url'),
  /** Never a secret. Credentials live in the process environment or the twin. */
  config: jsonb('config').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const repositories = pgTable('repositories', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id),
  fullName: text('full_name').notNull(),
  defaultBranch: text('default_branch').notNull().default('main'),
  /** Cached repository understanding (§13), refreshed rather than rediscovered. */
  language: text('language'),
  packageManager: text('package_manager'),
  testCommand: text('test_command'),
  buildCommand: text('build_command'),
  lintCommand: text('lint_command'),
  typecheckCommand: text('typecheck_command'),
  entryPoint: text('entry_point'),
  profileRefreshedAt: timestamp('profile_refreshed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex('repos_org_name_idx').on(t.organizationId, t.fullName)]);

export const services = pgTable('services', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id),
  repositoryId: uuid('repository_id').references(() => repositories.id),
  name: text('name').notNull(),
  environment: environmentEnum('environment').notNull().default('production'),
  ownerTeam: text('owner_team'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex('services_org_name_env_idx').on(t.organizationId, t.name, t.environment)]);

export const deployments = pgTable('deployments', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id),
  serviceId: uuid('service_id').notNull().references(() => services.id),
  repositoryId: uuid('repository_id').notNull().references(() => repositories.id),
  /** Provider's own deployment id, for reconciliation. */
  externalId: text('external_id'),
  environment: environmentEnum('environment').notNull(),
  status: deploymentStatusEnum('status').notNull(),
  commitSha: text('commit_sha').notNull(),
  previousCommitSha: text('previous_commit_sha'),
  authorName: text('author_name'),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
  deployedAt: timestamp('deployed_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  baselineFrom: timestamp('baseline_from', { withTimezone: true }),
  baselineTo: timestamp('baseline_to', { withTimezone: true }),
  observationFrom: timestamp('observation_from', { withTimezone: true }),
  observationTo: timestamp('observation_to', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('deployments_service_time_idx').on(t.serviceId, t.deployedAt),
  uniqueIndex('deployments_service_sha_idx').on(t.serviceId, t.commitSha, t.startedAt),
]);

export const deploymentCommits = pgTable('deployment_commits', {
  id: uuid('id').primaryKey().defaultRandom(),
  deploymentId: uuid('deployment_id').notNull().references(() => deployments.id, { onDelete: 'cascade' }),
  sha: text('sha').notNull(),
  message: text('message').notNull(),
  authorName: text('author_name').notNull(),
  authorEmail: text('author_email'),
  committedAt: timestamp('committed_at', { withTimezone: true }).notNull(),
}, (t) => [uniqueIndex('deployment_commits_idx').on(t.deploymentId, t.sha)]);

export const deploymentFiles = pgTable('deployment_files', {
  id: uuid('id').primaryKey().defaultRandom(),
  deploymentId: uuid('deployment_id').notNull().references(() => deployments.id, { onDelete: 'cascade' }),
  path: text('path').notNull(),
  status: text('status').notNull(),
  additions: integer('additions').notNull().default(0),
  deletions: integer('deletions').notNull().default(0),
  previousPath: text('previous_path'),
}, (t) => [index('deployment_files_path_idx').on(t.deploymentId, t.path)]);

export const deploymentPullRequests = pgTable('deployment_pull_requests', {
  id: uuid('id').primaryKey().defaultRandom(),
  deploymentId: uuid('deployment_id').notNull().references(() => deployments.id, { onDelete: 'cascade' }),
  number: integer('number').notNull(),
  title: text('title').notNull(),
  url: text('url').notNull(),
}, (t) => [uniqueIndex('deployment_prs_idx').on(t.deploymentId, t.number)]);

/** Raw telemetry, stored so a regression can always be re-derived rather than trusted. */
export const telemetrySnapshots = pgTable('telemetry_snapshots', {
  id: uuid('id').primaryKey().defaultRandom(),
  serviceId: uuid('service_id').notNull().references(() => services.id),
  deploymentId: uuid('deployment_id').references(() => deployments.id),
  metric: text('metric').notNull(),
  windowKind: text('window_kind').notNull(), // 'baseline' | 'observation' | 'post_remediation'
  windowFrom: timestamp('window_from', { withTimezone: true }).notNull(),
  windowTo: timestamp('window_to', { withTimezone: true }).notNull(),
  unit: text('unit').notNull(),
  sampleCount: integer('sample_count').notNull(),
  mean: doublePrecision('mean'),
  p95: doublePrecision('p95'),
  min: doublePrecision('min'),
  max: doublePrecision('max'),
  /** The raw point list, for re-derivation and for charting. */
  points: jsonb('points').$type<{ at: string; value: number }[]>().notNull(),
  collectedAt: timestamp('collected_at', { withTimezone: true }).notNull().defaultNow(),
  sourceToolCallId: uuid('source_tool_call_id'),
}, (t) => [index('telemetry_service_metric_idx').on(t.serviceId, t.metric, t.windowFrom)]);

export const regressions = pgTable('regressions', {
  id: uuid('id').primaryKey().defaultRandom(),
  deploymentId: uuid('deployment_id').references(() => deployments.id),
  serviceId: uuid('service_id').notNull().references(() => services.id),
  metric: text('metric').notNull(),
  baseline: doublePrecision('baseline').notNull(),
  observed: doublePrecision('observed').notNull(),
  absoluteChange: doublePrecision('absolute_change').notNull(),
  percentageChange: doublePrecision('percentage_change'),
  severity: severityEnum('severity').notNull(),
  confidence: doublePrecision('confidence').notNull(),
  baselineSnapshotId: uuid('baseline_snapshot_id').references(() => telemetrySnapshots.id),
  observedSnapshotId: uuid('observed_snapshot_id').references(() => telemetrySnapshots.id),
  detectedAt: timestamp('detected_at', { withTimezone: true }).notNull().defaultNow(),
});

export const incidents = pgTable('incidents', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id),
  serviceId: uuid('service_id').notNull().references(() => services.id),
  /** Human-facing key, e.g. INC-184. */
  key: text('key').notNull(),
  state: incidentStateEnum('state').notNull(),
  severity: severityEnum('severity').notNull(),
  title: text('title').notNull(),
  suspectedDeploymentId: uuid('suspected_deployment_id').references(() => deployments.id),
  deploymentAttribution: attributionEnum('deployment_attribution'),
  attributionConfidence: doublePrecision('attribution_confidence'),
  slackChannel: text('slack_channel'),
  slackThreadTs: text('slack_thread_ts'),
  openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
}, (t) => [uniqueIndex('incidents_org_key_idx').on(t.organizationId, t.key)]);

/** Append-only incident timeline. Drives the UX requirement in §18. */
export const incidentEvents = pgTable('incident_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  incidentId: uuid('incident_id').notNull().references(() => incidents.id, { onDelete: 'cascade' }),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  kind: text('kind').notNull(),
  summary: text('summary').notNull(),
  fromState: incidentStateEnum('from_state'),
  toState: incidentStateEnum('to_state'),
  agentRunId: uuid('agent_run_id'),
  detail: jsonb('detail').$type<Record<string, unknown>>(),
}, (t) => [index('incident_events_time_idx').on(t.incidentId, t.at)]);

export const agentRuns = pgTable('agent_runs', {
  id: uuid('id').primaryKey(),
  incidentId: uuid('incident_id').references(() => incidents.id, { onDelete: 'cascade' }),
  agentName: text('agent_name').notNull(),
  status: runStatusEnum('status').notNull(),
  input: jsonb('input'),
  output: jsonb('output'),
  error: text('error'),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
  endedAt: timestamp('ended_at', { withTimezone: true }),
  /** Lemma trace id, so a local run row opens in Lemma. */
  traceId: text('trace_id'),
}, (t) => [index('agent_runs_incident_idx').on(t.incidentId, t.startedAt)]);

export const toolCalls = pgTable('tool_calls', {
  id: uuid('id').primaryKey(),
  agentRunId: uuid('agent_run_id').notNull().references(() => agentRuns.id, { onDelete: 'cascade' }),
  incidentId: uuid('incident_id').references(() => incidents.id, { onDelete: 'cascade' }),
  toolName: text('tool_name').notNull(),
  risk: riskEnum('risk'),
  status: toolStatusEnum('status').notNull(),
  input: jsonb('input'),
  output: jsonb('output'),
  error: text('error'),
  attempt: integer('attempt').notNull().default(1),
  durationMs: integer('duration_ms').notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
}, (t) => [
  index('tool_calls_run_idx').on(t.agentRunId, t.startedAt),
  index('tool_calls_name_idx').on(t.toolName, t.status),
]);

/**
 * Evidence. `sourceToolCallId` is NOT NULL and foreign-keyed on purpose: the database
 * itself refuses evidence that no tool call produced.
 */
export const evidence = pgTable('evidence', {
  id: uuid('id').primaryKey().defaultRandom(),
  incidentId: uuid('incident_id').notNull().references(() => incidents.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(),
  provenance: provenanceEnum('provenance').notNull(),
  summary: text('summary').notNull(),
  sourceToolCallId: uuid('source_tool_call_id').notNull().references(() => toolCalls.id),
  sourceRef: text('source_ref'),
  payload: jsonb('payload'),
  collectedAt: timestamp('collected_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('evidence_incident_idx').on(t.incidentId, t.kind)]);

export const investigations = pgTable('investigations', {
  id: uuid('id').primaryKey().defaultRandom(),
  incidentId: uuid('incident_id').notNull().references(() => incidents.id, { onDelete: 'cascade' }),
  agentRunId: uuid('agent_run_id').references(() => agentRuns.id),
  suspectedRootCause: text('suspected_root_cause'),
  deploymentAttribution: attributionEnum('deployment_attribution').notNull(),
  attributionRationale: text('attribution_rationale'),
  confidence: doublePrecision('confidence').notNull(),
  nextActions: jsonb('next_actions').$type<string[]>().notNull().default([]),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const hypotheses = pgTable('hypotheses', {
  id: uuid('id').primaryKey().defaultRandom(),
  investigationId: uuid('investigation_id').notNull().references(() => investigations.id, { onDelete: 'cascade' }),
  incidentId: uuid('incident_id').notNull().references(() => incidents.id, { onDelete: 'cascade' }),
  status: claimStatusEnum('status').notNull(),
  description: text('description').notNull(),
  confidence: doublePrecision('confidence'),
  rank: integer('rank').notNull().default(0),
  /** Contradicting evidence is recorded, not discarded. */
  contradictedBy: jsonb('contradicted_by').$type<string[]>().notNull().default([]),
});

/** Join table: which evidence supports which hypothesis. */
export const hypothesisEvidence = pgTable('hypothesis_evidence', {
  hypothesisId: uuid('hypothesis_id').notNull().references(() => hypotheses.id, { onDelete: 'cascade' }),
  evidenceId: uuid('evidence_id').notNull().references(() => evidence.id, { onDelete: 'cascade' }),
}, (t) => [uniqueIndex('hypothesis_evidence_idx').on(t.hypothesisId, t.evidenceId)]);

export const reproductions = pgTable('reproductions', {
  id: uuid('id').primaryKey().defaultRandom(),
  incidentId: uuid('incident_id').notNull().references(() => incidents.id, { onDelete: 'cascade' }),
  command: text('command').notNull(),
  environmentDescription: text('environment_description').notNull(),
  /** The FAIL-before / PASS-after invariant, recorded as observed exit codes. */
  beforeFixExitCode: integer('before_fix_exit_code'),
  beforeFixPassed: boolean('before_fix_passed'),
  afterFixExitCode: integer('after_fix_exit_code'),
  afterFixPassed: boolean('after_fix_passed'),
  beforeFixOutput: text('before_fix_output'),
  afterFixOutput: text('after_fix_output'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const fixCandidates = pgTable('fix_candidates', {
  id: uuid('id').primaryKey().defaultRandom(),
  incidentId: uuid('incident_id').notNull().references(() => incidents.id, { onDelete: 'cascade' }),
  repositoryId: uuid('repository_id').notNull().references(() => repositories.id),
  branch: text('branch').notNull(),
  commitSha: text('commit_sha'),
  explanation: text('explanation').notNull(),
  rootCause: text('root_cause').notNull(),
  reproductionId: uuid('reproduction_id').references(() => reproductions.id),
  risks: jsonb('risks').$type<string[]>().notNull().default([]),
  rollbackPlan: text('rollback_plan').notNull(),
  confidence: doublePrecision('confidence').notNull(),
  pullRequestNumber: integer('pull_request_number'),
  pullRequestUrl: text('pull_request_url'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const fixCandidateFiles = pgTable('fix_candidate_files', {
  id: uuid('id').primaryKey().defaultRandom(),
  fixCandidateId: uuid('fix_candidate_id').notNull().references(() => fixCandidates.id, { onDelete: 'cascade' }),
  path: text('path').notNull(),
  additions: integer('additions').notNull().default(0),
  deletions: integer('deletions').notNull().default(0),
});

/**
 * A deterministic verification run. `exitCode` is recorded from a real process:
 * this table is the answer to "did the agent actually run the checks it claims".
 */
export const validationRuns = pgTable('validation_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  fixCandidateId: uuid('fix_candidate_id').notNull().references(() => fixCandidates.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(), // test | lint | typecheck | build | reproduction
  command: text('command').notNull(),
  exitCode: integer('exit_code').notNull(),
  passed: boolean('passed').notNull(),
  testsPassed: integer('tests_passed'),
  testsFailed: integer('tests_failed'),
  durationMs: integer('duration_ms').notNull(),
  output: text('output').notNull(),
  ranAt: timestamp('ran_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('validation_fix_idx').on(t.fixCandidateId, t.kind)]);

export const policies = pgTable('policies', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id),
  name: text('name').notNull(),
  description: text('description').notNull(),
  minAutonomy: text('min_autonomy').notNull(),
  requiresApproval: boolean('requires_approval').notNull().default(true),
  appliesToRisk: riskEnum('applies_to_risk').notNull(),
  enabled: boolean('enabled').notNull().default(true),
});

export const approvals = pgTable('approvals', {
  id: uuid('id').primaryKey().defaultRandom(),
  incidentId: uuid('incident_id').notNull().references(() => incidents.id, { onDelete: 'cascade' }),
  fixCandidateId: uuid('fix_candidate_id').references(() => fixCandidates.id),
  policyId: uuid('policy_id').references(() => policies.id),
  approverUserId: uuid('approver_user_id').references(() => users.id),
  decision: approvalDecisionEnum('decision').notNull(),
  /** The exact action authorised. An approval is never a blanket grant. */
  authorizedAction: text('authorized_action').notNull(),
  rationale: text('rationale'),
  decidedAt: timestamp('decided_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
});

export const recoveryVerifications = pgTable('recovery_verifications', {
  id: uuid('id').primaryKey().defaultRandom(),
  incidentId: uuid('incident_id').notNull().references(() => incidents.id, { onDelete: 'cascade' }),
  metric: text('metric').notNull(),
  baselineValue: doublePrecision('baseline_value').notNull(),
  incidentValue: doublePrecision('incident_value').notNull(),
  postRemediationValue: doublePrecision('post_remediation_value').notNull(),
  recovered: boolean('recovered').notNull(),
  monitorsRecovered: boolean('monitors_recovered'),
  verifiedAt: timestamp('verified_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Append-only audit log. Every mutating action lands here, allowed or denied. */
export const auditLogs = pgTable('audit_logs', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id),
  incidentId: uuid('incident_id').references(() => incidents.id),
  actor: text('actor').notNull(), // 'agent:FixAgent' | 'user:<id>' | 'system'
  action: text('action').notNull(),
  risk: riskEnum('risk'),
  allowed: boolean('allowed').notNull(),
  denialReason: text('denial_reason'),
  detail: jsonb('detail').$type<Record<string, unknown>>(),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('audit_org_time_idx').on(t.organizationId, t.at)]);
