# Server architecture

Diagrams only. For the engine see [`ENGINE.md`](./ENGINE.md); for the package
rules see [`../AGENTS.md`](../AGENTS.md).

---

## 1. Topology

```
        browser (127.0.0.1 / localhost only)
                │
                │  HTTP + one SSE stream
                ▼
    ┌────────────────────────────┐
    │   src/server/server.ts     │
    │                            │
    │  origin guard   static     │
    │  API            SSE        │
    └───────┬────────────┬───────┘
            │            │
            │ reads      │ spawns `cli.ts`
            ▼            ▼
    ┌────────────┐  ┌──────────────┐
    │  src/ui    │  │    engine/   │
    │ 3 files    │  │  the pipeline│
    └────────────┘  └──────┬───────┘
                           ▼
                    ┌──────────────┐
                    │  storage/db  │
                    └──────────────┘
```

The server holds no domain rules. It serves files, validates requests, and
runs the CLI — the same command a person would type.

---

## 2. Routes

```
  read-only                        writes                     stream
 ┌──────────────────────┐  ┌───────────────────────────┐  ┌────────────────┐
 │ GET /                │  │ POST /api/cv?name=<file>  │  │ GET /api/run   │
 │ GET /app.js          │  │ POST /api/market          │  │   ?action=…    │
 │ GET /style.css       │  │ POST /api/field           │  │                │
 │                      │  │ POST /api/interests       │  │ Server-Sent    │
 │ GET /api/state       │  │ POST /api/feedback        │  │ Events:        │
 │ GET /api/jobs        │  │ POST /api/undo            │  │   log          │
 │ GET /api/health      │  │ POST /api/discover        │  │   done         │
 │ GET /api/decisions   │  │ POST /api/learning/       │  │                │
 │ GET /api/learning    │  │        constraint         │  │                │
 └──────────────────────┘  └───────────────────────────┘  └────────────────┘
        │                             │                          │
        ▼                             ▼                          ▼
   read with queries          validate, then write         spawn + stream
```

Fourteen API endpoints, plus three static files. Writes are only ever in
response to an explicit user action.

`POST /api/undo` takes either `{ "jobId": "…" }` or `{ "all": true }`; the
second clears every decision in one transaction and returns the count.

---

## 3. A run, over SSE

```
 browser                server                     cli.ts
    │                      │                          │
    │ GET /api/run?action  │                          │
    ├─────────────────────▶│  already running?        │
    │                      │    └─▶ 409, stop         │
    │                      │                          │
    │                      │  spawn ◀─────────────────│
    │                      │──────────────▶ backup…   │
    │                      │──────────────▶ collect…  │
    │  event: log          │◀────── stdout ───────────│
    │◀─────────────────────│                          │
    │  event: log          │◀────── stdout ───────────│
    │◀─────────────────────│                          │
    │                      │        exit 0            │
    │  event: done         │◀─────────────────────────│
    │◀─────────────────────│                          │
    │                      │  write runs/<stamp>.log  │
    │                      │  read  runs/<stamp>.json │
    │                      │  attach summary to done  │
    ▼                      ▼                          ▼
  reload matches      release the lock          process gone
```

Three guarantees in that sequence:

- **one run at a time** — a second request gets `409` instead of two writers
- **the transcript is real** — it is the child's stdout, not a re-rendering
- **a dead client does not leak a process** — closing the stream kills the child

---

## 4. Request lifecycle

```
        request
           │
           ▼
   ┌──────────────────────────┐  no   ┌──────────────┐
   │ host + origin + metadata │──────▶│ 403 refused  │
   │ same-origin?             │       └──────────────┘
   └───────────┬──────────────┘
               │ yes
               ▼
   ┌───────────────┐   no    ┌──────────────┐
   │ static file?  │────────▶│ /api route?  │
   └───────┬───────┘         └──────┬───────┘
           │ yes                    │ yes
           ▼                        ▼
   path whitelisted?        method + params validated
   (no traversal)           JSON POSTs require
           │                 application/json
           ▼                        │
      send file                     ▼
                            engine / storage
                                   │
                                   ▼
                             JSON, no-store
```

Anything else is `404`. Oversized bodies are `413`. Every JSON response
carries `cache-control: no-store`, because the page's whole job is showing
fresh results.

**The origin guard exists because `127.0.0.1` stops the network, not the
browser.** Without it, any website could POST to the local server — and
`GET /api/run` starts a paid run. Requests must arrive at `127.0.0.1` or
`localhost`, `Sec-Fetch-Site` (when present) must be same-origin, and `Origin`
(when present) must match the host. Requests without those headers — `curl`, a
script — are allowed.

---

## 5. Boundaries

```
  ui  ──HTTP──▶  server  ──▶  engine  ──▶  storage
                    │
                    └─ must not contain: filtering, scoring, parsing
```

`tests/structure.test.ts` enforces that the server imports the engine and the
storage but nothing imports the server except the entry points.
