# Pager Developer — working notes

Facts that were expensive to discover and are not in any vendor's documentation.
Re-verify anything here before relying on it; Arga is a young product and its
behaviour will change.

## Arga Labs

**The SDK's default base URL is wrong.** `arga-sdk@0.1.3` defaults to
`https://app.argalabs.com`, which serves the web app. The API is
`https://api.argalabs.com`. Symptom of getting this wrong: `Unexpected token '<'`
from JSON parsing. Always construct clients via `createArgaClient()`.

**Resolve the twin catalogue at runtime.** The SDK's `KnownTwinName` union is stale
in both directions — it omits `datadog` (which exists) and includes `postgres`
(which the API does not offer). `twins.list()` is the authority. As of 2026-09-13
the account is offered 31 twins including `github`, `datadog` and `slack`.

**Free plan limits, all discovered by hitting them:**

| Limit | Value |
| --- | --- |
| Twin session TTL | 10 minutes (`ttl_minutes` above 10 is rejected) |
| Twins per run | 1 (a three-twin scenario needs three runs) |
| Validation runs | a small monthly quota, exhausted 2026-09-13 |

The one-twin limit is not as damaging as it looks: GitHub, Datadog and Slack hold
independent data, and the correlation between them happens inside Pager, not inside
Arga. The 10-minute TTL matters more — a full incident lifecycle must fit inside it
or the run must be re-provisioned, which is why `TwinRunExpiredError` is a distinct
error type.

**Twin credentials are not in `envVars`.** A provisioned GitHub twin returns
`envVars: {}` and rejects unauthenticated writes. The `proxyToken` gates the *admin*
host via `Authorization: Bearer` but is not a GitHub credential. The way in is the
**GitHub App Manifest flow**, which the twin implements:

```
POST /settings/apps/new    (form field `manifest`, needs hook_attributes.url)
  -> 302 with ?code=...
POST /app-manifests/{code}/conversions
  -> { id, pem }
sign an RS256 app JWT with the pem
POST /app/installations/{id}/access_tokens
  -> { token: "ghs_..." }
```

`packages/providers/src/github/app-auth.ts` implements this. It is also the correct
production design, so there is no twin-only code path.

**The GitHub twin does not compute diffs.** `/compare/{a}...{b}` returns the correct
schema with `files: []` and `commits: 0`; `/pulls/{n}/files` is empty; and
`/git/trees/{sha}` is not commit-addressed. `getDiff` therefore falls back to tree
comparison, but on this twin that currently yields nothing either. A scenario needing
a real file-level diff cannot be fully reconstructed from the twin today — the
DeploymentObserver records this as a gap rather than reporting "nothing changed".

## Issue trackers and knowledge

Three more adapters, each written against the real vendor API and exercised through
the local twin. The protocol differences are the reason each needed its own work:

- **Jira** (REST v3) will not take a plain string for a description or comment — it
  needs Atlassian Document Format — and a status cannot be assigned. You must list
  the transitions available *from the issue's current status* and execute one by id,
  and that set is per-project. `updateIssue` resolves the transition by name at call
  time; it throws `JiraStateError` rather than reporting a silent success, because an
  incident that believes it is resolved while the tracker says open is worse than an
  error.
- **Linear** (GraphQL) answers HTTP 200 with an `errors` array, so a 200 is not
  success. Workflow states are per-team rows with a `type`, so a state id is resolved
  for the team rather than guessed. Priority is an integer 0-4.
- **Notion** stores a page as a tree of typed blocks, and a page's title lives in
  whichever property has type `title` — named arbitrarily inside a database. Children
  are paginated, so a long runbook read without pagination truncates silently.

All three are optional in the registry and resolve to `null` when unconfigured;
callers must handle absence rather than assume a tracker exists.

## Local infrastructure

No local Docker daemon on this machine — the only context is a remote host over
Tailscale, which this project does not touch. Postgres runs as PGlite (real Postgres
compiled to WASM, in process) via `pglite://memory`. `docker-compose.yml` is kept for
real deployments.

## Conventions

- `pnpm verify` (typecheck + lint + test + build) must pass before any commit.
- Adapters are written against the real vendor API. There is never an `if (arga)`
  branch inside one; backend selection happens once, in the registry.
- Absent data is never reported as empty data. Distinguish "unknown" from "none".
- Evidence may only cite a tool call id the tracer actually issued.
