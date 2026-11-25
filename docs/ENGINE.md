# Engine architecture

Diagrams only. For the reasoning see [`DECISIONS.md`](./DECISIONS.md); for the
package rules see [`../AGENTS.md`](../AGENTS.md); for learning see
[`LEARNING.md`](./LEARNING.md).

---

## 1. A run

```
                     config/profile.yaml · market.yaml · tracks.yaml
                                     │
                                     ▼
   storage/backup.ts ──▶ config/backups/jobs-<stamp>.db   (seven kept)
                                     │
                                     ▼
   discover-list.ts ──▶ boards      optional: DISCOVER_ON_RUN=1
                                     │
                                     ▼
   ingest/            six adapters, one per platform
                                     │
                                     ▼
   enrich/            clean html · language · salary · city
                                     │
                                     ▼
   storage/           upsert · dedupe by description hash · queue pending
                                     │
                                     ▼
   filter/            title · field · seniority · location · clearance
                                     │
                                     ├────────▶ rejects: every drop, with its reason
                                     ▼
   score/             batches · temperature 0 · N samples · strict JSON
                                     │
                                     ├────────▶ shadow_scores: a subset, scored without learning
                                     ▼
   storage/           scores + variant + rule version · learning_runs
                                     │
                                     ▼
   deliver/           digest.md · telegram (optional)
                                     │
                                     ▼
   audit.ts           runs/<stamp>.log and runs/<stamp>.json
```

`pipeline.ts` owns this order. Nothing else decides it. Every collaborator is
injected through `PipelineDeps`, so the order is testable without a model.

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
     pipeline · discovery · discover-list · ingest · enrich
     filter · score · learn · profile · deliver · report · schedule
                      │
                      ▼
                storage/db.ts · storage/backup.ts
```

The server never reimplements the pipeline, so the page and the terminal
cannot disagree.

---

## 3. Discovery

Two paths, one directory.

```
   with a search key                        without a key
   ─────────────────                        ──────────────
   Brave / Google CSE                       Wikipedia category APIs
        │                                         │
        ▼                                         ▼
   ATS urls from results                   company names
        │                                         │
        │                                         ▼
        │                                   slug candidates
        │                                         │
        ▼                                         ▼
   GET the board ────────┬─────────────── GET the board
                         │
                         ▼
              identity check: the board must
              name the company we asked for
                         │
                         ▼
              boards with ≥1 open role
                         │
                         ▼
                    the directory
```

- Search finds boards by query; it is precise and needs a credential.
- The keyless path guesses slugs and verifies them. Measured yield: about one
  board per fifteen names.
- `discover-list` remembers every name it probed, so a daily run does not ask
  the same companies again.
- `collect` reads `boards` from storage. There is no company file.

---

## 4. Scoring

```
   survivors (job × track)
        │
        ▼
   batch of BATCH_SIZE ──▶ prompt ──▶ model ──▶ strict JSON
                              ▲                     │
                              │                     ▼
                    learning block          parse · retry · split on truncation
                    (only when earned)             │
                                                   ▼
                                          one score per job per track
                                          + reasons + flags
```

- **Temperature 0.** Scoring is a measurement, not a writing task.
- **`SCORE_SAMPLES`** (1–3, default 1) repeats the call and averages. The model
  disagrees with itself by up to 16 points between identical runs.
- **A failed batch is never written as 0.** It is reported and left unscored.
- **`variant` and the rule version** are stored with every score, so a learned
  score is distinguishable from a baseline one and old rules are not compared
  with new.
- **Shadow scoring** repeats a bounded subset without learning, so `eval` has a
  baseline twin to compare against. It rotates through postings so coverage
  grows.

---

## 5. Profile

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

A scanned PDF is refused rather than turned into an empty profile.

---

## 6. Packages

```
src/ui ──HTTP──▶ src/server ──▶ src/engine ──▶ src/storage
                                      │             │
                                      └─────────────┴──▶ engine/types.ts
```

Enforced by `tests/structure.test.ts`.
