# Pager Developer

An AI production engineer assigned to software deployments. It observes deployments,
detects regressions, investigates them, decides whether the deployment is to blame,
reproduces the failure, writes and verifies a fix, and brings a human a reviewable PR
with the evidence attached.

The bar is not whether a demo looks impressive. It is whether an on-call engineer
would trust this at 3 AM.

## Quick start

Everything below runs without credentials or network access, against local twins.
A reasoning model is optional: without one the system still detects, files, notifies,
reproduces and hands off — it simply never claims to have diagnosed anything.

```bash
pnpm install

pnpm preflight        # what is reachable: model, Arga twins, Lemma
pnpm eval             # detection suite (deterministic)
pnpm eval:agent       # investigation + repair suite; writes a JSON report
pnpm demo:workflow    # the full incident workflow, alert to team email
pnpm demo:local       # observe + detect, printed to the terminal
pnpm demo:repo        # run the demo service's own test suite

pnpm api:seed         # populate the database by running the real pipeline
pnpm api              # API on http://127.0.0.1:4000
pnpm --filter @pager/web dev   # dashboard on http://127.0.0.1:4100
```

`pnpm verify` runs typecheck, lint, tests and build. It must pass before any commit.

### Turning the reasoning model on

Set `ANTHROPIC_API_KEY` in `.env` (`PAGER_MODEL` defaults to `claude-opus-5`). Then
`pnpm eval:agent`, `pnpm demo:workflow` and `pnpm api:seed` all switch from a scripted
fixture to real model-authored work, and say so in their output. Nothing else changes:
the reproduction gate, the check suite and the human merge gate are identical either
way, because they are the parts that must not depend on what wrote the patch.

Live-model evaluation scenarios are **skipped, not passed**, when no key is present,
and the JSON report records them as unverified.

## What works today

| Phase | State |
| --- | --- |
| 1 — Connect & observe | Done. Verified against real Arga twins and the local twin |
| 2 — Detect regressions | Done |
| 3 — Investigate | Done. Bounded read-tool loop over Datadog, GitHub and Notion, with schema-validated, citation-checked findings |
| 4 — Communicate | Templates, evidence gate and Slack delivery done |
| 5 — Fix & verify | Done. Model-authored regression test and patch, proven by exit codes, with one bounded repair attempt |
| 6 — Approve & recover | Policy, approval and recovery verification done |

The deterministic spine is complete: an incident can be detected, opened, persisted,
communicated, reproduced in a sandbox, verified with real test runs, gated by policy
and checked for recovery. The judgement in the middle — *why* production broke and
*what* patch to write — is supplied by a model, through a seam narrow enough that
every one of those guarantees still holds around it.

Three rules govern that seam:

- **The deployed revision is established, never assumed.** The workflow reads what
  production is running from deployment evidence and refuses to substitute the head
  of the base branch. A patch validated against a tree that is not the failing one
  proves nothing, so the workflow halts instead.
- **A non-zero exit code is not a reproduction.** The regression test must be new,
  must run in isolation where the runner allows it, must produce a failing assertion
  rather than a load error, and must print text the author predicted. A syntax error,
  a missing module, a broken command or a suite that was already red are each refused
  by name.
- **A patch may not touch its own evidence.** A patch naming the regression test path
  is rejected — twice, once by the generator and again by the layer that writes to
  disk.

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

- **Five live-model runs is not a reliability measurement.** `pnpm eval:agent --
  --repeat 3` passed 5/5 (three repair runs, one abstention, one deterministic
  sabotage) against `claude-opus-5` on 2026-09-13. That demonstrates the behaviour;
  it does not measure its rate, and the evaluation says so in its own caveats.
- **Hosted Arga twins are authenticated but not provisionable**: the account's monthly
  free-plan validation-run quota is exhausted (observed 2026-09-13, `pnpm preflight
  -- --probe-provision`). Every run in this repository therefore uses the local twin,
  and each report states that explicitly.
- **The merge and the recovery in `pnpm demo:workflow` are simulated** by the demo
  script, and labelled `SIMULATED` in its output. The recovery *verdict* is real — it
  is computed from those series by the same `RecoveryVerifier` that would read a real
  Datadog — but the series themselves are written by the script.
- **`lint` and `build` are reported as not run** for the demo service, which defines
  no such scripts. They are recorded as unmeasured and never counted as passing.
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
