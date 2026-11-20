# Engine architecture

Diagrams only. For the reasoning see [`DECISIONS.md`](./DECISIONS.md); for the
package rules see [`../AGENTS.md`](../AGENTS.md).

---

## 1. A run

```
config/profile.yaml · market.yaml · tracks.yaml
        │
        ▼
   ingest/        six adapters, one per platform
        │
        ▼
   enrich/        clean html · language · salary · city
        │
        ▼
   storage/       upsert · dedupe by id · queue pending
        │
        ▼
   filter/        six rules + field exclusions
        │
        ├──────────▶  rejects: every drop, with its reason
        ▼
   score/         batches of six · one call · strict JSON
        │
        ▼
   deliver/       digest.md · telegram (optional)
        │
        ▼
   audit.ts       runs/<stamp>.log and runs/<stamp>.json
```

`pipeline.ts` owns this order. Nothing else decides it.

---

## 2. Entry points

```
   cli.ts                        server/server.ts
 (npm run …)                     (the page, over HTTP)
      │                                │
      │ direct calls                   │ spawns cli.ts,
      │                                │ streams stdout (SSE)
      └───────────────┬────────────────┘
                      ▼
                  engine/
     pipeline · discovery · ingest · enrich
     filter · score · profile · deliver · report
                      │
                      ▼
                storage/db.ts
```

The server never reimplements the pipeline, so the page and the terminal
cannot disagree.

---

## 3. Discovery

```
   queries            parse              probe            keep
 ┌──────────┐   ┌───────────────┐  ┌──────────────┐  ┌────────────┐
 │ site:    │──▶│ ATS urls      │─▶│ GET board    │─▶│ bands by   │
 │ × ATS    │   │ lever.co/acme │  │ lever · gh   │  │ open roles │
 │ × city   │   │ comeet/x/uid  │  │ ashby·comeet │  │            │
 └──────────┘   └───────────────┘  └──────────────┘  └─────┬──────┘
                                                           ▼
                                                    ┌─────────────┐
                                                    │ boards      │
                                                    │ the         │
                                                    │ directory   │
                                                    └─────────────┘
```

`collect` reads `boards` from storage. There is no company file.

---

## 4. Profile

```
   CV (pdf · docx · md)
        │
        ▼
   profile/extract.ts ──▶ model ──▶ normalise
        │
        ▼
   profile/write.ts ──▶ config/profile.yaml
                        (preferences carried over)
```

---

## 5. Packages

```
src/ui ──HTTP──▶ src/server ──▶ src/engine ──▶ src/storage
                                      │             │
                                      └─────────────┴──▶ engine/types.ts
```

Enforced by `tests/structure.test.ts`.
