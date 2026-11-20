# Server architecture

Diagrams only. For the engine see [`ENGINE.md`](./ENGINE.md); for the package
rules see [`../AGENTS.md`](../AGENTS.md).

---

## 1. Topology

```
        browser (127.0.0.1 only)
                │
                │  HTTP + one SSE stream
                ▼
    ┌────────────────────────────┐
    │   src/server/server.ts     │
    │                            │
    │  static files   API   SSE  │
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
  read-only                      writes                    stream
 ┌──────────────────┐   ┌────────────────────────┐   ┌────────────────┐
 │ GET /            │   │ POST /api/cv           │   │ GET /api/run   │
 │ GET /app.js      │   │      ?name=<file>      │   │   ?action=…    │
 │ GET /style.css   │   │ POST /api/market       │   │                │
 │                  │   │ POST /api/field        │   │ Server-Sent    │
 │ GET /api/state   │   │ POST /api/interests    │   │ Events:        │
 │ GET /api/jobs    │   │ POST /api/feedback     │   │   log          │
 │ GET /api/health  │   │ POST /api/undo         │   │   done         │
 │ GET /api/decisions│  │                        │   │                │
 └──────────────────┘   └────────────────────────┘   └────────────────┘
        │                        │                            │
        ▼                        ▼                            ▼
   read with queries      validate, then write           spawn + stream
```

Twelve routes. Writes are only ever in response to an explicit user action.

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
   ┌───────────────┐   no    ┌──────────────┐
   │ static file?  │────────▶│ /api route?  │
   └───────┬───────┘         └──────┬───────┘
           │ yes                    │ yes
           ▼                        ▼
   path whitelisted?        method + params
   (no traversal)            validated
           │                        │
           ▼                        ▼
      send file              engine / storage
                                  │
                                  ▼
                            JSON, no-store
```

Anything else is `404`. Every JSON response carries `cache-control: no-store`,
because the page's whole job is showing fresh results.

---

## 5. Boundaries

```
  ui  ──HTTP──▶  server  ──▶  engine  ──▶  storage
                    │
                    └─ must not contain: filtering, scoring, parsing
```

`tests/structure.test.ts` enforces that the server imports the engine and the
storage but nothing imports the server except the entry points.
