# Storage architecture

Diagrams only. For the engine see [`ENGINE.md`](./ENGINE.md); for the package
rules see [`../AGENTS.md`](../AGENTS.md).

One SQLite file per config directory: `config/jobs.db`, opened with WAL.
Snapshots live in `config/backups/`.

---

## 1. Tables

```
┌────────────────────────┐         ┌────────────────────────┐
│         jobs           │         │        boards          │
│                        │         │                        │
│ id             hash PK │         │ ats + ident      PK    │
│ source · company       │         │ token                  │
│ title · url            │         │ name · open_roles      │
│ locations · remote     │         │ verified_at · misses   │
│ description            │         │ enabled                │
│ description_hash       │         └────────────────────────┘
│ comp · lang · country  │           the tenant directory:
│ first_seen · last_seen │           no company file exists
│ active · evaluated     │
└───────────┬────────────┘
            │
   ┌────────┴─────────┬──────────────────┬───────────────────┐
   ▼                  ▼                  ▼                   ▼
┌────────────┐  ┌────────────┐  ┌─────────────────┐  ┌───────────────┐
│   scores   │  │  rejects   │  │    decisions    │  │ discovery_    │
│            │  │            │  │                 │  │ attempts      │
│ job_id  ┐  │  │ job_id  ┐  │  │ job_id PK       │  │ name PK       │
│ track   ┘PK│  │ track   ┘PK│  │ label (stage)   │  │ at · outcome  │
│ score      │  │ reason     │  │ note            │  └───────────────┘
│ reasons    │  │ at         │  │ at · updated_at │   names already
│ flags      │  └────────────┘  └────────┬────────┘   probed by keyless
│ model      │   why it was              │            discovery
│ profile_   │   dropped                 ▼
│  hash      │                  ┌─────────────────┐
│ scored_at  │                  │  decision_log   │
│ variant    │                  │ id · job_id     │
│ learning_  │                  │ label · note    │
│  at        │                  │ action · at     │
│ learning_  │                  └─────────────────┘
│  version   │                   set / cleared,
└────────────┘                   append-only

┌──────────────────────┐  ┌──────────────────────┐  ┌──────────────────────┐
│    shadow_scores     │  │    learning_runs     │  │ learning_constraints │
│ job_id + track   PK  │  │ id PK                │  │ id PK                │
│ score · model        │  │ at · labels          │  │ kind · value · note  │
│ version · at         │  │ version · payload    │  │ job_id · status · at │
└──────────────────────┘  └──────────────────────┘  └──────────────────────┘
 the same posting scored    what derivations went    proposed → confirmed
 without learning          into a score             → rejected
```

`runs` records every session: `id · started · finished · collected · new_jobs ·
filtered · scored · tokens_in · tokens_out · cost_usd · errors`.

---

## 2. What owns what

```
  engine/ingest     ──writes──▶  jobs · boards (open_roles)
  engine/filter     ──writes──▶  rejects          one row per job per track
  engine/score      ──writes──▶  scores           one row per job per track
                                shadow_scores    the baseline twin
                                learning_runs    the block that was shown
  engine/learn      ──writes──▶  learning_constraints   proposals only
  engine/pipeline   ──writes──▶  runs
  server/cli        ──writes──▶  decisions · decision_log · boards · attempts
```

Each table has one owning module. The two exceptions are deliberate, and both go
through the same storage functions: decisions are written by the page and by
`npm run feedback`, and constraints are confirmed from the page and the CLI.

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
   hidden from lists      list is filtered at read time
        │
        │ undo
        ▼
   decisions row deleted
   decision_log keeps "cleared: <label>"
```

Two things to notice:

- a rejection **deletes** any score the posting had, so a tightened filter can
  never leave an old verdict behind
- a decision **hides** the posting at read time, and undo deletes the row — but
  `decision_log` is append-only, so the fact that a choice was made survives
- undo also **withdraws unconfirmed constraints** proposed from that decision's
  note, in the same transaction; a rule the user confirmed stays, because it is
  their statement rather than the decision's

---

## 4. When rows are rewritten

```
   description text changed   ──▶ description_hash differs
                                  └─▶ scores dropped, evaluated = 0

   profile or tracks changed  ──▶ profile_hash differs
                                  └─▶ scores dropped, evaluated = 0

   learning rules changed     ──▶ learning_version differs
                                  └─▶ old shadow pairs reported as stale,
                                      never compared with new ones

   posting gone from source   ──▶ active = 0
                                  └─▶ still on record, never listed

   board silent 14 times      ──▶ boards.enabled = 0
                                  └─▶ revived if discovered again
```

Change detection is a hash comparison, which is why re-running a collection is
free: unchanged text produces the same hash and nothing is re-scored.

---

## 5. The queries that matter

```
  collection queue                    the shortlist
  ────────────────                    ─────────────
  SELECT * FROM jobs                  SELECT s.score, j.*
  WHERE active = 1                      FROM scores s
    AND evaluated = 0                   JOIN jobs j ON j.id = s.job_id
  ORDER BY first_seen DESC              LEFT JOIN decisions d
                                          ON d.job_id = s.job_id
  "what has never been                WHERE s.score >= ?
  looked at"                          AND d.job_id IS NULL   ← hides decided
                                      ORDER BY s.score DESC
                                      "what is worth reading"

  shadow pairs                        discovery memory
  ────────────                        ────────────────
  scores ⨝ shadow_scores              SELECT name FROM
  ON job_id + track                   discovery_attempts
  WHERE versions match                "do not probe again"
  "learned vs baseline, same rules"
```

The left join is what makes a decision disappear from every future list without
deleting anything. The version equality is what keeps a comparison honest when
the learning rules change.

---

## 6. Indexes

| Index | Serves |
|---|---|
| `jobs_company` | grouping and diagnostics |
| `jobs_first_seen` | the collection queue's ordering |
| `scores_track` | ranking within a track |

`jobs.id`, `boards (ats, ident)`, `scores (job_id, track)`, `shadow_scores
(job_id, track)`, `rejects (job_id, track)`, `decisions.job_id`,
`discovery_attempts.name` and the two learning tables' ids are primary keys, so
they are indexed by definition.

---

## 7. Backups

```
   before every run        npm run backup
          │                      │
          ▼                      ▼
   VACUUM INTO config/backups/jobs-<stamp>.db
          │
          ▼
   keep the newest seven, delete the rest
```

`VACUUM INTO` is used rather than copying the file: the database is in WAL mode,
so a plain copy can miss the last transactions. A snapshot is consistent by
construction.
