# Storage architecture

Diagrams only. For the engine see [`ENGINE.md`](./ENGINE.md); for the package
rules see [`../AGENTS.md`](../AGENTS.md).

One SQLite file per config directory: `config/jobs.db`, opened with WAL.

---

## 1. Tables

```
┌───────────────────────┐         ┌───────────────────────┐
│        jobs           │         │        boards         │
│                       │         │                       │
│ id            hash PK │         │ ats + ident   PK      │
│ source · company      │         │ token                 │
│ title · url           │         │ name · open_roles     │
│ locations · remote    │         │ verified_at · misses  │
│ description           │         │ enabled               │
│ description_hash      │         └───────────────────────┘
│ comp · lang · country │           the tenant directory:
│ first_seen · last_seen│           no company file exists
│ active                │
│ evaluated             │
└───────────┬───────────┘
            │ 1
            │
    ┌───────┴────────┬─────────────────┐
    │ n              │ n               │ 1
    ▼                ▼                 ▼
┌────────────┐  ┌────────────┐  ┌─────────────────┐
│   scores   │  │  rejects   │  │    decisions    │
│            │  │            │  │                 │
│ job_id  ┐  │  │ job_id  ┐  │  │ job_id PK       │
│ track   ┘PK│  │ track   ┘PK│  │ label (stage)   │
│ score 0-100│  │ reason     │  │ note            │
│ reasons    │  │ at         │  │ at · updated_at │
│ flags      │  └────────────┘  └─────────────────┘
│ model      │   why it was       what you decided
│ profile_hash│  dropped
│ scored_at  │
└────────────┘

┌───────────────────────┐
│         runs          │
│ id · started          │
│ collected · new_jobs  │
│ filtered · scored     │
│ tokens · cost · errors│
└───────────────────────┘
```

---

## 2. What owns what

```
   engine/ingest  ──writes──▶  jobs
   engine/filter  ──writes──▶  rejects         (one row per job per track)
   engine/score   ──writes──▶  scores          (one row per job per track)
   server POST    ──writes──▶  decisions       (one row per job, ever)
   engine/pipeline──writes──▶  runs
   engine/discovery──writes──▶ boards
```

Each table has exactly one writer. Nothing else mutates it.

---

## 3. The job lifecycle

```
  discovered ──▶ stored                evaluated = 0
                   │
                   ▼
              filter each track
                   │
        ┌──────────┴───────────┐
        │ rejected             │ passed
        ▼                      ▼
   rejects row            scores row
   score deleted          evaluated = 1
        │                      │
        └──────────┬───────────┘
                   ▼
             appears in the list
                   │
        ┌──────────┴───────────┐
        │ applied / skipped    │ nothing yet
        ▼                      ▼
   decisions row          stays visible
   never listed again
```

Two things to notice:

- a rejection **deletes** any score the posting had, so a tightened filter can
  never leave an old verdict behind
- a decision is permanent until the user undoes it, and removal happens at read
  time — the row is never deleted while hidden, so the funnel keeps its history

---

## 4. When rows are rewritten

```
   description text changed   ──▶ description_hash differs
                                  └─▶ scores dropped, evaluated = 0

   profile or tracks changed  ──▶ profile_hash differs
                                  └─▶ scores dropped, evaluated = 0

   posting gone from source   ──▶ active = 0
                                  └─▶ still on record, never listed

   board silent 14 times      ──▶ boards.enabled = 0
                                  └─▶ revived if discovered again
```

Change detection is a hash comparison, which is why re-running a collection is
free: unchanged text produces the same hash and nothing is re-scored.

---

## 5. The two queries that matter

```
  collection queue                    the shortlist
  ────────────────                    ─────────────
  SELECT * FROM jobs                  SELECT s.score, j.*
  WHERE active = 1                      FROM scores s
    AND evaluated = 0                   JOIN jobs j ON j.id = s.job_id
  ORDER BY first_seen DESC              LEFT JOIN decisions d
                                          ON d.job_id = s.job_id
  "what has never been              WHERE s.score >= ?
  looked at"                          AND d.job_id IS NULL   ← hides decided
                                      ORDER BY s.score DESC
                                      "what is worth reading"
```

The left join is what makes a decision disappear from every future list without
deleting anything.

---

## 6. Indexes

| Index | Serves |
|---|---|
| `jobs_company` | grouping and diagnostics |
| `jobs_first_seen` | the collection queue's ordering |
| `scores_track` | ranking within a track |

`jobs.id`, `scores (job_id, track)`, `rejects (job_id, track)` and
`decisions.job_id` are primary keys, so they are indexed by definition.
