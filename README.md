# Pager Developer

An AI production engineer assigned to software deployments. It observes deployments,
detects regressions, investigates them, decides whether the deployment is to blame,
reproduces the failure, writes and verifies a fix, and brings a human a reviewable PR
with the evidence attached.

The bar is not whether a demo looks impressive. It is whether an on-call engineer
would trust this at 3 AM.

## Quick start

Nothing below needs credentials or network access.

```bash
pnpm install

pnpm eval             # evaluation suite across three scenarios
pnpm demo:workflow    # the full incident workflow, alert to team email
pnpm demo:local       # observe + detect, printed to the terminal
pnpm demo:repo        # run the demo service's own test suite

pnpm api:seed         # populate the database by running the real pipeline
pnpm api              # API on http://127.0.0.1:4000
pnpm --filter @pager/web dev   # dashboard on http://127.0.0.1:4100
```

`pnpm verify` runs typecheck, lint, tests and build. It must pass before any commit.

## What works today

| Phase | State |
| --- | --- |
| 1 — Connect & observe | Done. Verified against real Arga twins and the local twin |
| 2 — Detect regressions | Done |
| 3 — Investigate | **Not built.** Needs a reasoning model |
| 4 — Communicate | Templates, evidence gate and Slack delivery done |
| 5 — Fix & verify | Deterministic half done. Patch generation needs a model |
| 6 — Approve & recover | Policy, approval and recovery verification done |

The deterministic spine is complete: an incident can be detected, opened, persisted,
communicated, reproduced in a sandbox, verified with real test runs, gated by policy
and checked for recovery. What is missing is the judgement in the middle — deciding
*why* production broke and *what* patch to write.

## The three properties this rests on

Each is enforced in application code, not requested of a model in a prompt.

**Claims cannot outrun evidence.** A tool call id is minted only after a call really
executes, and it is the only thing evidence may cite. The database enforces this too:
`evidence.source_tool_call_id` is `NOT NULL` and foreign-keyed to `tool_calls`. A
model cannot fabricate evidence because it cannot fabricate an id the recorder never
issued.

**Verification means a process ran.** A check has passed only when a command exited
zero. A skipped check is not a passing check, an all-skipped suite is not a pass, and
unparseable test output yields null counts rather than zero — "0 failed" and "we could
not tell" must never look alike. Reproduction requires FAIL BEFORE and PASS AFTER;
a regression test that passes before the patch is rejected as not exercising the bug.

**Correlation is not causation.** The regression detector has no field in which to
record deployment blame, so the shortcut cannot be taken even by accident. Attribution
is a separate verdict requiring evidence, and until one exists the incident reads
`NOT DETERMINED` everywhere it appears.

## Layout

```
packages/
  core/           domain types, incident state machine, evidence gate, tool policy
  db/             Drizzle schema, repositories, Postgres-backed telemetry sink
  providers/      provider interfaces + GitHub, Datadog, Slack, Jira, Linear, Notion
  observability/  Lemma instrumentation, agent run and tool call recording
  agents/         observer, detector, incident engine, communication, policy, recovery
  sandbox/        isolated execution, repository profiling, deterministic validation
  twin-local/     offline twin server with real diffs and deterministic reset
apps/
  api/            Fastify read API; owns the database connection
  web/            Next.js incident command centre
evals/            scenarios, evaluation harness, demos
```

## Integrations

| App | Adapter | Against real Arga | Against local twin |
| --- | --- | --- | --- |
| GitHub | full, authenticates as a GitHub App | yes | yes |
| Datadog | metrics, logs, monitors | not yet | yes |
| Slack | threads, replies, read-back | not yet | yes |
| Jira | REST v3, ADF, transitions | not yet | yes |
| Linear | GraphQL, per-team workflow states | not yet | yes |
| Notion | block trees, pagination | not yet | yes |

Only GitHub has been exercised against hosted Arga infrastructure; the rest are
verified against the local twin. See `CLAUDE.md` for the Arga constraints that
shaped this.

## Known limitations

- **No reasoning model is configured**, so Phase 3 and patch generation are absent.
  Attribution accuracy, root-cause accuracy and communication accuracy are reported by
  the evaluation suite as explicitly unmeasured rather than counted as passing.
- **Lemma is on hold.** Instrumentation records locally; no agent behavioural
  evaluations run.
- **The hosted Arga GitHub twin cannot compute diffs**, which is why the local twin
  exists. Scenario fidelity against hosted twins is limited for anything needing
  file-level change data.
- **Three of twelve evaluation scenarios** have local fixtures. Two of the three have
  an innocent deployment, which is the ratio that matters.
- **The API is read-only** and unauthenticated. Approval endpoints require
  authentication first.
- No event bus or job queue; the pipeline runs in process.
