CREATE TYPE "public"."approval_decision" AS ENUM('APPROVED', 'REJECTED', 'ROLLBACK_INSTEAD');--> statement-breakpoint
CREATE TYPE "public"."deployment_attribution" AS ENUM('DEPLOYMENT_LIKELY_RESPONSIBLE', 'DEPLOYMENT_NOT_RESPONSIBLE', 'INSUFFICIENT_EVIDENCE', 'EXTERNAL_INCIDENT');--> statement-breakpoint
CREATE TYPE "public"."claim_status" AS ENUM('HYPOTHESIS', 'OBSERVATION', 'FACT');--> statement-breakpoint
CREATE TYPE "public"."deployment_status" AS ENUM('pending', 'in_progress', 'succeeded', 'failed', 'rolled_back');--> statement-breakpoint
CREATE TYPE "public"."environment" AS ENUM('production', 'staging', 'development');--> statement-breakpoint
CREATE TYPE "public"."incident_state" AS ENUM('HEALTHY', 'DEPLOYMENT_OBSERVED', 'OBSERVING', 'REGRESSION_DETECTED', 'INCIDENT_OPEN', 'INVESTIGATING', 'ROOT_CAUSE_SUSPECTED', 'ROOT_CAUSE_CONFIRMED', 'REPRODUCING', 'FIXING', 'VALIDATING', 'FIX_READY', 'AWAITING_APPROVAL', 'APPROVED', 'DEPLOYING_FIX', 'VERIFYING_RECOVERY', 'RESOLVED', 'FALSE_POSITIVE', 'EXTERNAL_INCIDENT', 'FIX_FAILED', 'APPROVAL_REJECTED', 'ROLLBACK_REQUESTED', 'UNRESOLVED');--> statement-breakpoint
CREATE TYPE "public"."provenance" AS ENUM('OBSERVED', 'DERIVED');--> statement-breakpoint
CREATE TYPE "public"."risk_level" AS ENUM('READ_ONLY', 'WRITE_NON_PRODUCTION', 'PRODUCTION_WRITE');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('RUNNING', 'OK', 'ERROR');--> statement-breakpoint
CREATE TYPE "public"."severity" AS ENUM('SEV1', 'SEV2', 'SEV3', 'SEV4');--> statement-breakpoint
CREATE TYPE "public"."tool_status" AS ENUM('OK', 'ERROR');--> statement-breakpoint
CREATE TABLE "agent_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"incident_id" uuid,
	"agent_name" text NOT NULL,
	"status" "run_status" NOT NULL,
	"input" jsonb,
	"output" jsonb,
	"error" text,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"trace_id" text
);
--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"incident_id" uuid NOT NULL,
	"fix_candidate_id" uuid,
	"policy_id" uuid,
	"approver_user_id" uuid,
	"decision" "approval_decision" NOT NULL,
	"authorized_action" text NOT NULL,
	"rationale" text,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"incident_id" uuid,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"risk" "risk_level",
	"allowed" boolean NOT NULL,
	"denial_reason" text,
	"detail" jsonb,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deployment_commits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deployment_id" uuid NOT NULL,
	"sha" text NOT NULL,
	"message" text NOT NULL,
	"author_name" text NOT NULL,
	"author_email" text,
	"committed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deployment_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deployment_id" uuid NOT NULL,
	"path" text NOT NULL,
	"status" text NOT NULL,
	"additions" integer DEFAULT 0 NOT NULL,
	"deletions" integer DEFAULT 0 NOT NULL,
	"previous_path" text
);
--> statement-breakpoint
CREATE TABLE "deployment_pull_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deployment_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"title" text NOT NULL,
	"url" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deployments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"repository_id" uuid NOT NULL,
	"external_id" text,
	"environment" "environment" NOT NULL,
	"status" "deployment_status" NOT NULL,
	"commit_sha" text NOT NULL,
	"previous_commit_sha" text,
	"author_name" text,
	"started_at" timestamp with time zone NOT NULL,
	"deployed_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"baseline_from" timestamp with time zone,
	"baseline_to" timestamp with time zone,
	"observation_from" timestamp with time zone,
	"observation_to" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"incident_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"provenance" "provenance" NOT NULL,
	"summary" text NOT NULL,
	"source_tool_call_id" uuid NOT NULL,
	"source_ref" text,
	"payload" jsonb,
	"collected_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fix_candidate_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fix_candidate_id" uuid NOT NULL,
	"path" text NOT NULL,
	"additions" integer DEFAULT 0 NOT NULL,
	"deletions" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fix_candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"incident_id" uuid NOT NULL,
	"repository_id" uuid NOT NULL,
	"branch" text NOT NULL,
	"commit_sha" text,
	"explanation" text NOT NULL,
	"root_cause" text NOT NULL,
	"reproduction_id" uuid,
	"risks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"rollback_plan" text NOT NULL,
	"confidence" double precision NOT NULL,
	"pull_request_number" integer,
	"pull_request_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hypotheses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"investigation_id" uuid NOT NULL,
	"incident_id" uuid NOT NULL,
	"status" "claim_status" NOT NULL,
	"description" text NOT NULL,
	"confidence" double precision,
	"rank" integer DEFAULT 0 NOT NULL,
	"contradicted_by" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hypothesis_evidence" (
	"hypothesis_id" uuid NOT NULL,
	"evidence_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "incident_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"incident_id" uuid NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" text NOT NULL,
	"summary" text NOT NULL,
	"from_state" "incident_state",
	"to_state" "incident_state",
	"agent_run_id" uuid,
	"detail" jsonb
);
--> statement-breakpoint
CREATE TABLE "incidents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"key" text NOT NULL,
	"state" "incident_state" NOT NULL,
	"severity" "severity" NOT NULL,
	"title" text NOT NULL,
	"suspected_deployment_id" uuid,
	"deployment_attribution" "deployment_attribution",
	"attribution_confidence" double precision,
	"slack_channel" text,
	"slack_thread_ts" text,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "integrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"backend" text NOT NULL,
	"twin_run_id" text,
	"base_url" text,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "investigations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"incident_id" uuid NOT NULL,
	"agent_run_id" uuid,
	"suspected_root_cause" text,
	"deployment_attribution" "deployment_attribution" NOT NULL,
	"attribution_rationale" text,
	"confidence" double precision NOT NULL,
	"next_actions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"autonomy_level" text DEFAULT 'L3' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organizations_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"min_autonomy" text NOT NULL,
	"requires_approval" boolean DEFAULT true NOT NULL,
	"applies_to_risk" "risk_level" NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recovery_verifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"incident_id" uuid NOT NULL,
	"metric" text NOT NULL,
	"baseline_value" double precision NOT NULL,
	"incident_value" double precision NOT NULL,
	"post_remediation_value" double precision NOT NULL,
	"recovered" boolean NOT NULL,
	"monitors_recovered" boolean,
	"verified_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "regressions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deployment_id" uuid,
	"service_id" uuid NOT NULL,
	"metric" text NOT NULL,
	"baseline" double precision NOT NULL,
	"observed" double precision NOT NULL,
	"absolute_change" double precision NOT NULL,
	"percentage_change" double precision,
	"severity" "severity" NOT NULL,
	"confidence" double precision NOT NULL,
	"baseline_snapshot_id" uuid,
	"observed_snapshot_id" uuid,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "repositories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"full_name" text NOT NULL,
	"default_branch" text DEFAULT 'main' NOT NULL,
	"language" text,
	"package_manager" text,
	"test_command" text,
	"build_command" text,
	"lint_command" text,
	"typecheck_command" text,
	"entry_point" text,
	"profile_refreshed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reproductions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"incident_id" uuid NOT NULL,
	"command" text NOT NULL,
	"environment_description" text NOT NULL,
	"before_fix_exit_code" integer,
	"before_fix_passed" boolean,
	"after_fix_exit_code" integer,
	"after_fix_passed" boolean,
	"before_fix_output" text,
	"after_fix_output" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "services" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"repository_id" uuid,
	"name" text NOT NULL,
	"environment" "environment" DEFAULT 'production' NOT NULL,
	"owner_team" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "telemetry_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"service_id" uuid NOT NULL,
	"deployment_id" uuid,
	"metric" text NOT NULL,
	"window_kind" text NOT NULL,
	"window_from" timestamp with time zone NOT NULL,
	"window_to" timestamp with time zone NOT NULL,
	"unit" text NOT NULL,
	"sample_count" integer NOT NULL,
	"mean" double precision,
	"p95" double precision,
	"min" double precision,
	"max" double precision,
	"points" jsonb NOT NULL,
	"collected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source_tool_call_id" uuid
);
--> statement-breakpoint
CREATE TABLE "tool_calls" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agent_run_id" uuid NOT NULL,
	"incident_id" uuid,
	"tool_name" text NOT NULL,
	"risk" "risk_level",
	"status" "tool_status" NOT NULL,
	"input" jsonb,
	"output" jsonb,
	"error" text,
	"attempt" integer DEFAULT 1 NOT NULL,
	"duration_ms" integer NOT NULL,
	"started_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "validation_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fix_candidate_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"command" text NOT NULL,
	"exit_code" integer NOT NULL,
	"passed" boolean NOT NULL,
	"tests_passed" integer,
	"tests_failed" integer,
	"duration_ms" integer NOT NULL,
	"output" text NOT NULL,
	"ran_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_fix_candidate_id_fix_candidates_id_fk" FOREIGN KEY ("fix_candidate_id") REFERENCES "public"."fix_candidates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_policy_id_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."policies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_approver_user_id_users_id_fk" FOREIGN KEY ("approver_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment_commits" ADD CONSTRAINT "deployment_commits_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment_files" ADD CONSTRAINT "deployment_files_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment_pull_requests" ADD CONSTRAINT "deployment_pull_requests_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_source_tool_call_id_tool_calls_id_fk" FOREIGN KEY ("source_tool_call_id") REFERENCES "public"."tool_calls"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fix_candidate_files" ADD CONSTRAINT "fix_candidate_files_fix_candidate_id_fix_candidates_id_fk" FOREIGN KEY ("fix_candidate_id") REFERENCES "public"."fix_candidates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fix_candidates" ADD CONSTRAINT "fix_candidates_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fix_candidates" ADD CONSTRAINT "fix_candidates_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fix_candidates" ADD CONSTRAINT "fix_candidates_reproduction_id_reproductions_id_fk" FOREIGN KEY ("reproduction_id") REFERENCES "public"."reproductions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hypotheses" ADD CONSTRAINT "hypotheses_investigation_id_investigations_id_fk" FOREIGN KEY ("investigation_id") REFERENCES "public"."investigations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hypotheses" ADD CONSTRAINT "hypotheses_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hypothesis_evidence" ADD CONSTRAINT "hypothesis_evidence_hypothesis_id_hypotheses_id_fk" FOREIGN KEY ("hypothesis_id") REFERENCES "public"."hypotheses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hypothesis_evidence" ADD CONSTRAINT "hypothesis_evidence_evidence_id_evidence_id_fk" FOREIGN KEY ("evidence_id") REFERENCES "public"."evidence"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_events" ADD CONSTRAINT "incident_events_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_suspected_deployment_id_deployments_id_fk" FOREIGN KEY ("suspected_deployment_id") REFERENCES "public"."deployments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investigations" ADD CONSTRAINT "investigations_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investigations" ADD CONSTRAINT "investigations_agent_run_id_agent_runs_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policies" ADD CONSTRAINT "policies_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_verifications" ADD CONSTRAINT "recovery_verifications_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "regressions" ADD CONSTRAINT "regressions_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "regressions" ADD CONSTRAINT "regressions_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "regressions" ADD CONSTRAINT "regressions_baseline_snapshot_id_telemetry_snapshots_id_fk" FOREIGN KEY ("baseline_snapshot_id") REFERENCES "public"."telemetry_snapshots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "regressions" ADD CONSTRAINT "regressions_observed_snapshot_id_telemetry_snapshots_id_fk" FOREIGN KEY ("observed_snapshot_id") REFERENCES "public"."telemetry_snapshots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reproductions" ADD CONSTRAINT "reproductions_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telemetry_snapshots" ADD CONSTRAINT "telemetry_snapshots_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telemetry_snapshots" ADD CONSTRAINT "telemetry_snapshots_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_calls" ADD CONSTRAINT "tool_calls_agent_run_id_agent_runs_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_calls" ADD CONSTRAINT "tool_calls_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "validation_runs" ADD CONSTRAINT "validation_runs_fix_candidate_id_fix_candidates_id_fk" FOREIGN KEY ("fix_candidate_id") REFERENCES "public"."fix_candidates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_runs_incident_idx" ON "agent_runs" USING btree ("incident_id","started_at");--> statement-breakpoint
CREATE INDEX "audit_org_time_idx" ON "audit_logs" USING btree ("organization_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "deployment_commits_idx" ON "deployment_commits" USING btree ("deployment_id","sha");--> statement-breakpoint
CREATE INDEX "deployment_files_path_idx" ON "deployment_files" USING btree ("deployment_id","path");--> statement-breakpoint
CREATE UNIQUE INDEX "deployment_prs_idx" ON "deployment_pull_requests" USING btree ("deployment_id","number");--> statement-breakpoint
CREATE INDEX "deployments_service_time_idx" ON "deployments" USING btree ("service_id","deployed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "deployments_service_sha_idx" ON "deployments" USING btree ("service_id","commit_sha","started_at");--> statement-breakpoint
CREATE INDEX "evidence_incident_idx" ON "evidence" USING btree ("incident_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "hypothesis_evidence_idx" ON "hypothesis_evidence" USING btree ("hypothesis_id","evidence_id");--> statement-breakpoint
CREATE INDEX "incident_events_time_idx" ON "incident_events" USING btree ("incident_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "incidents_org_key_idx" ON "incidents" USING btree ("organization_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "repos_org_name_idx" ON "repositories" USING btree ("organization_id","full_name");--> statement-breakpoint
CREATE UNIQUE INDEX "services_org_name_env_idx" ON "services" USING btree ("organization_id","name","environment");--> statement-breakpoint
CREATE INDEX "telemetry_service_metric_idx" ON "telemetry_snapshots" USING btree ("service_id","metric","window_from");--> statement-breakpoint
CREATE INDEX "tool_calls_run_idx" ON "tool_calls" USING btree ("agent_run_id","started_at");--> statement-breakpoint
CREATE INDEX "tool_calls_name_idx" ON "tool_calls" USING btree ("tool_name","status");--> statement-breakpoint
CREATE UNIQUE INDEX "users_org_email_idx" ON "users" USING btree ("organization_id","email");--> statement-breakpoint
CREATE INDEX "validation_fix_idx" ON "validation_runs" USING btree ("fix_candidate_id","kind");