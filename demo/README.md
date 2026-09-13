# Demo repository

A real, runnable service used by Pager Developer's scenarios. It is not a fixture
made of strings — you can read it, edit it and run it.

```bash
cd demo/checkout-api
node --test
```

That suite **passes**, against code that is broken in production. That is the point
of the demo: the bug shipped because no existing test exercised the failing path, so
reproducing the incident requires writing a *new* failing test, not re-running CI.

## The bug

`src/checkout/service.ts` dereferences `request.discountCode.value` unconditionally.
PR #377 widened `discountCode` to optional in `src/checkout/types.ts` — and changed
nothing else.

So the line that throws was never touched by the deployment that broke it. Attribution
cannot be settled by asking "is the failing file in the diff?", which is the shortcut
worth defending against.

## Layout

```
checkout-api/      the service at the deployed (broken) revision
history/           pre-change versions of files a commit superseded
runbooks/          documentation the investigation reads, seeded into Notion
scenario.json      commit history, telemetry, monitors, and what to seed where
```

`scenario.json` describes history as commits over the working tree. A commit lists
the paths it contains, optionally with an `overlay` directory supplying the
pre-change version of files it modified — so only superseded content is stored and
the history directory stays readable.

## Using it against real GitHub

The tree is a normal project. To run scenarios against real GitHub rather than the
local twin, push `checkout-api/` to a repository, replay the commits in
`scenario.json` as real commits, and point `GITHUB_BASE_URL` at the API. Nothing in
the adapters changes — that is the whole design.
