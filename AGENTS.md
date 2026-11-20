# JobPilot — architecture rules

These are binding for every change. If a change needs to break one, the rule
changes first, deliberately, in this file.

## Layout

```
src/
  cli.ts        command entry point — the only file at the root of src/
  ui/           the page: index.html, style.css, app.js
  server/       the HTTP server and its API
  engine/       everything the agent decides
  storage/      SQLite and its queries
tests/          mirror of the four packages, one file per module
templates/      config starting points, no personal data
```

## Responsibilities

**`ui/`** — markup, styling and browser behaviour only. It talks to the server
over HTTP and holds no business logic. It has no build step and no bundler: it
is plain files loaded by the browser. Adding a framework is an architecture
change, not a refactor.

**`server/`** — HTTP, SSE, static files, request validation. It may read config
and call the engine. It must not contain domain rules: no filtering, no scoring,
no parsing.

**`engine/`** — everything that decides. Pipeline, discovery, ingestion,
enrichment, filtering, scoring, profile extraction, delivery, reporting.

**`storage/`** — the database and its queries. It stores what the engine gives
it and returns rows. It must not contain business rules.

**`cli.ts`** — argument parsing and command dispatch. Thin: it calls the engine
and prints results.

## Allowed dependencies

```
ui  ──HTTP──▶  server  ──▶  engine  ──▶  storage
                              │            │
                              └────────────┴──▶  engine/types.ts
```

- `engine/` may import `storage/` and `engine/types.ts` freely.
- `storage/` may import `engine/types.ts` and `engine/util.ts` only. It must not
  import enrich, filter, score or anything else with behaviour.
- `server/` may import `engine/` and `storage/`.
- `ui/` imports nothing: it is not module code.
- Nothing imports `server/` or `ui/` except the entry points.

`tests/structure.test.ts` enforces this mechanically. A violation fails the
suite.

## Where new code goes

| Adding | Goes to |
|---|---|
| A new job source | `engine/ingest/<name>.ts`, registered in `engine/ingest/index.ts` |
| A new filter rule | `engine/filter/rules.ts` |
| A new field (beyond hi-tech) | `engine/fields.ts`, one entry |
| A new scoring rule or prompt change | `engine/score/` |
| A new screen or control | `src/ui/` and, if it needs data, a route in `src/server/` |
| A new table or query | `src/storage/db.ts` |
| A new command | `src/cli.ts` plus a script in `package.json` |

## Conventions

- TypeScript runs directly on Node; no build step, no bundler, no transpiler.
- Dependencies stay few. A new dependency needs a reason in the PR.
- `config/`, `.env`, `runs/` and `out/` are gitignored. Nothing personal ships.
- Every post starts at the directory in the database, never a file in the repo.
- Tests are offline by default: no network, no model calls.
