# Pager Developer — Architecture

> Status: living document. Written at the start of Phase 1 and updated at each phase
> boundary. Every claim about an external API here was verified against that vendor's
> documentation on 2026-09-13; re-verify before relying on it.

## 1. What this is

Pager Developer is an AI production engineer assigned to software deployments. It
observes deployments, detects regressions, investigates them, decides whether the
deployment is to blame, reproduces the failure, writes and verifies a fix, and brings
a human a reviewable PR with the evidence attached.

The product promise is not "production is broken". It is:

> Production broke. I investigated it. Here is the root cause. Here is the evidence.
> I reproduced it. Here is the tested fix. Approve?

The bar is not demo quality. The bar is whether an on-call engineer would trust this
at 3 AM.

## 2. Current architecture (the audit)

There was none. This repository was created on 2026-09-13 as a greenfield build.

Audit findings, recorded so the "reuse existing conventions" rule has something to
point at:

| Dimension | Finding |
| --- | --- |
| Repository structure | Empty. No prior art anywhere under `~`. |
| Framework / package manager | None chosen. Selected here: pnpm workspaces, TypeScript. |
| Database | None. Selected: PostgreSQL 17 + Drizzle ORM. |
| Authentication | None. Deferred — single-org local deployment for the MVP. |
| API conventions | None. Selected: Fastify, REST, zod-validated at the boundary. |
| Frontend | None. Selected: Next.js App Router + Tailwind + shadcn/ui. |
| Tests | None. Selected: Vitest. |
| CI | None. GitHub Actions added in Phase 1. |
| Existing integrations | None. |
| Env var handling | None. Selected: `.env` + a single zod-parsed config module. |

Two deviations from the recommended stack in the brief, both deliberate:

- **Fastify instead of NestJS.** The brief says "NestJS or equivalent". Pager's
  backend is an event-driven orchestrator, not a CRUD API, so NestJS's DI and
  decorator machinery buys little and costs build complexity. Module boundaries are
  enforced by workspace packages instead.
- **Drizzle instead of Prisma.** The brief requires relational structure rather than
  JSON blobs (§16). Drizzle's schema is plain TypeScript, so the domain types and the
  table definitions cannot drift apart.

## 3. Target architecture

```
                          PAGER DEVELOPER

                         Event Ingestion
                                │
        ┌───────────────────────┼───────────────────────┐
      GitHub                 Datadog                  Slack
        └──────────────── Arga Labs Twins ─────────────┘
                                │
                            Event Bus                 (BullMQ / Redis)
                                │
                       Deployment Observer            Phase 1
                                │
                       Regression Detector            Phase 2
                                │
                         Incident Engine              Phase 2
                                │
                    Investigation Orchestrator        Phase 3
                                │
                      Reproduction Sandbox            Phase 5
                                │
                            Fix Agent                 Phase 5
                                │
                        Validation Engine             Phase 5
                                │
                          Policy Engine               Phase 6
                                │
                         Approval Engine              Phase 6
                                │
                        Recovery Verifier             Phase 6

          every agent execution ──────────────▶ Lemma
```

The two external systems answer different questions, and conflating them would be the
central design error:

- **Arga Labs** answers *what happened in the external applications*.
- **Lemma** answers *did Pager Developer itself behave correctly*.
- **Deterministic tests** answer *does the generated code actually work*.

None of the three substitutes for another. In particular, a patch is never "verified"
because a model or a Lemma evaluation approved it; it is verified when a test that
failed before the patch passes after it.

## 4. Package layout

```
packages/
  core/          domain types, zod schemas, incident state machine, policy engine
  db/            Drizzle schema, migrations, repositories
  providers/     provider interfaces + Arga / real / local adapters
  observability/ Lemma instrumentation wrapper, AgentRun + ToolCall recording
  agents/        DeploymentObserver, RegressionDetector, IncidentInvestigator,
                 RepositoryInvestigator, ReproductionAgent, FixAgent,
                 ValidationAgent, CommunicationAgent, RecoveryVerifier
  sandbox/       isolated git worktree + command execution
  twin-local/    offline deterministic twin server (CI, no-credential dev)
apps/
  api/           Fastify HTTP API + BullMQ workers
  web/           Next.js dashboard
evals/           Arga scenarios INC-001..INC-012 + evaluation harness
```

## 5. Provider abstraction

The hard requirement is that business logic never knows which backend it is talking
to. Adapters are constructed with a resolved base URL and credentials; nothing
downstream of construction branches on `arga` vs `real`.

```ts
interface SourceControlProvider {
  getDeploymentCommit(ref: DeploymentRef): Promise<Commit>;
  getCommit(sha: string): Promise<Commit>;
  getDiff(base: string, head: string): Promise<Diff>;
  getPullRequest(number: number): Promise<PullRequest>;
  createBranch(from: string, name: string): Promise<Branch>;
  createPullRequest(input: CreatePullRequestInput): Promise<PullRequest>;
}

interface ObservabilityProvider { /* metrics, logs, monitors, traces */ }
interface MessagingProvider     { /* threads, posts, approval prompts   */ }
interface IssueTrackerProvider  { /* Linear, Jira                       */ }
interface KnowledgeProvider     { /* Notion, Google Docs/Drive          */ }
interface DeploymentProvider    { /* deploy, rollback                   */ }
```

Backend selection is config, resolved once at startup by a `ProviderRegistry`:

```
PAGER_SOURCE_CONTROL_BACKEND = arga | real | local
PAGER_OBSERVABILITY_BACKEND  = arga | real | local
PAGER_MESSAGING_BACKEND      = arga | real | local
```

### Arga integration

Arga provisions ephemeral **Twin Runs**. A run is requested with a list of services
and a scenario, and once `status: ready` it returns, per twin, a `base_url`, an
`admin_url` (state inspection and reset) and `env_vars` (credentials).

```
POST /twins  { twins: ["github","datadog","slack"], ttl_minutes, scenario_id }
  → { run_id }
poll until status === "ready"
  → { twins: { github: { base_url, admin_url, env_vars }, ... }, expires_at }
```

This maps directly onto the design: a `TwinRun` is the single place provider URLs
enter the system. `admin_url` is what makes the evaluation suite deterministic — it
gives per-scenario seeding and reset, and lets an eval assert on **side effects**
(was a branch really created? was that Slack message really sent?) rather than on the
agent's own account of what it did.

Twin Runs expire; after `expires_at` twin URLs return `410 environment_destroyed`.
The registry treats expiry as a first-class error, not a transport failure.

## 6. Lemma instrumentation

One incident is one coherent Lemma thread. Every agent execution is a trace; every
tool call and model call is recorded inside it.

```ts
lemma.trace({ name: "incident-investigator", threadId: incident.id, input }, async (t) => {
  t.recordTool({ name: "github.readDiff", input, output });
  t.recordGeneration({ name: "hypothesis-generation", input, output, model });
});
```

Instrumentation is not optional decoration: the same wrapper that emits to Lemma also
writes `AgentRun` and `ToolCall` rows locally, so the product UI and the evaluation
suite read from the same record. A tool call that fails is recorded as failed — the
agent is never permitted to silently drop one.

Lemma evaluations encode the behavioural invariants:

- never claim a test passed unless it was executed
- never claim root cause confirmed without supporting evidence
- never perform a production write without authorization
- never mark an incident resolved before recovery verification
- distinguish fact from hypothesis
- never fabricate telemetry
- never silently ignore a failed tool call

We do **not** store raw chain-of-thought. Traces carry structured summaries and
evidence references.

## 7. Data model

Relational, not JSON soup (§16). Core entities:

`Organization`, `User`, `Integration`, `Service`, `Repository`, `Deployment`,
`TelemetrySnapshot`, `Regression`, `Incident`, `IncidentEvent`, `Evidence`,
`Investigation`, `Hypothesis`, `FixCandidate`, `Reproduction`, `ValidationRun`,
`Approval`, `RecoveryVerification`, `AgentRun`, `ToolCall`, `AuditLog`, `Policy`.

`Evidence` is the spine. Every hypothesis and every externally-communicated claim
references evidence rows by id. A claim with no evidence cannot be promoted to a
fact — this is enforced in application code, not left to the model's discretion.

## 8. Incident state machine

```
HEALTHY → DEPLOYMENT_OBSERVED → OBSERVING → REGRESSION_DETECTED → INCIDENT_OPEN
  → INVESTIGATING → ROOT_CAUSE_SUSPECTED → ROOT_CAUSE_CONFIRMED → REPRODUCING
  → FIXING → VALIDATING → FIX_READY → AWAITING_APPROVAL → APPROVED
  → DEPLOYING_FIX → VERIFYING_RECOVERY → RESOLVED
```

Terminal / branching: `FALSE_POSITIVE`, `EXTERNAL_INCIDENT`, `FIX_FAILED`,
`APPROVAL_REJECTED`, `ROLLBACK_REQUESTED`, `UNRESOLVED`.

Transitions are a explicit allow-list in `packages/core`. The model proposes; the
state machine decides. An invalid transition throws and is audited.

## 9. Agent architecture

No single agent with every tool. Nine specialized components under deterministic
orchestration.

The split of authority is absolute:

| The model may decide | Application code decides |
| --- | --- |
| hypotheses | permissions |
| investigation strategy | state transitions |
| which evidence is relevant | which tools are available |
| candidate fixes | approval requirements |
| how to phrase a Slack update | execution limits, production boundaries |

The model never defines its own security policy. All model output is schema-validated
before it is allowed to affect state.

## 10. Permissions and security

Default-allowed: read telemetry, read repositories, read documentation, write
sandbox, write fix branch, open pull request, write Slack thread, write issue tracker.

Default-prohibited: push to main, delete production data, modify production
databases, modify IAM, rotate credentials, destroy infrastructure, execute arbitrary
production commands, deploy arbitrary code, disable security controls.

Every tool declares `name`, `description`, input/output schema, permission, risk
level, timeout, retry policy and audit behaviour. Risk levels: `READ_ONLY`,
`WRITE_NON_PRODUCTION`, `PRODUCTION_WRITE` (always requires approval).

Autonomy levels L0–L5, defaulting to **L3** (may open a PR, may not execute
remediation). The level is config, and raising it is an explicit operator act.

## 11. Six phases

| Phase | Goal | Exit criterion |
| --- | --- | --- |
| 1 | Connect & observe | Pager reconstructs a deployment from an Arga scenario |
| 2 | Detect regressions | Distinguishes real regressions from noise; attribution left open |
| 3 | Investigate | Evidence-backed hypotheses and a deployment attribution verdict |
| 4 | Communicate | One Slack thread per incident, no unsupported claims |
| 5 | Fix & verify | Reproduction fails before fix, passes after; PR opened |
| 6 | Approve, recover, learn | Human approval, remediation, verified recovery |

Each phase ends runnable and committed. Vertical slices, not six disconnected
systems integrated at the end.

## 12. Evaluation strategy

Twelve scenarios, `INC-001`..`INC-012`, seeded into Arga. Crucially four of them have
an **innocent deployment** (`INC-009` third-party outage, `INC-010` traffic spike,
`INC-011` misconfigured monitor with healthy production, `INC-012` regression from an
older deployment). Correlation is not causation: a system that always blames the most
recent deploy scores well on the other eight and is worthless.

Per scenario: seed Arga → run Pager → capture the Lemma trace → evaluate the outcome
→ inspect side effects via `admin_url` → reset.

Metrics: detection accuracy, false positive/negative rate, attribution accuracy,
root-cause accuracy, reproduction rate, fix success rate, unsafe action rate, and the
time-to-X series.

The metric that gates everything: **unsafe action rate must be 0**.

## 13. Local infrastructure decision (recorded during Phase 1)

This machine has no local Docker daemon — the only configured Docker context is a
remote host reachable over Tailscale — and no local PostgreSQL. Starting containers
on someone else's machine is not something this task asked for, so the database layer
supports two drivers behind one schema:

- `postgres://…` — a real server. This is the production path, and what
  `docker-compose.yml` provisions.
- `pglite://memory` or `pglite://<dir>` — PostgreSQL compiled to WASM, running in
  process. This is the local development and test path.

PGlite is real PostgreSQL rather than a SQLite-shaped approximation, so the same
Drizzle schema, migrations and queries serve both. The practical benefit is that the
evaluation suite cannot be blocked on infrastructure being up.

Schema tests run against a real engine and assert the constraints the safety model
depends on — in particular that `evidence.source_tool_call_id` is `NOT NULL` and
foreign-keyed to `tool_calls`, so fabricated evidence is refused by the database and
not only by application code.

## 14. Arga constraints discovered in Phase 1

Verified against the live API on 2026-09-13; see `CLAUDE.md` for the operational
detail. The three that shape the design:

1. **One twin per run, ten-minute TTL** (free plan). Scenarios provision per-twin
   runs rather than one multi-twin environment. This is tolerable because the three
   twins hold independent data and correlation happens inside Pager. The TTL is the
   sharper constraint: a full incident lifecycle must fit inside it, which is why an
   expired environment is a distinct error type rather than a retryable failure.

2. **Twins issue no credentials in `envVars`.** Authentication is via the GitHub App
   Manifest flow. Since that is also the correct production design, Pager
   authenticates as a GitHub App everywhere, with scoped short-lived installation
   tokens rather than a long-lived PAT.

3. **The GitHub twin does not compute diffs.** This is a genuine fidelity limit, not
   a bug in our adapter. `getDiff` degrades through compare → tree comparison and,
   when all routes are empty, the DeploymentObserver records a gap. It never reports
   an empty file list as though nothing changed, because an investigation would use
   that to exonerate a deployment.

Point 3 is the reason the local twin (`packages/twin-local`) is worth building rather
than being a convenience: it gives the evaluation suite a source-control twin that
can express a real file-level diff, which the hosted twin currently cannot.
