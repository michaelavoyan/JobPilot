# Learning loop — implementation plan

What it takes to go from "calibration text injected into a prompt" to a loop
that learns from decisions and **proves** it ranks better.

> **Status.** L0 (measurement), L1 (per-track examples) and L2 (similarity
> selection) are implemented, plus `learn --reset`. L3 (notes to constraints),
> L4 (preference hints), the UI section of L5 and L6 (a calibrated comparison)
> are **not** implemented — see §10 for what each needs.

---

## 1. Definition of complete

The loop is complete when all five hold:

1. **Every decision is captured with context** — score, track, the job's
   features, the prompt variant that produced it, and any note.
2. **The agent derives preferences**, not just a threshold: which domains,
   stacks, levels and locations this candidate actually accepts.
3. **Preferences reach the model per track**, not globally.
4. **A measurement says whether it helps** — precision@10 and a ranking AUC
   with a confidence interval, comparing learned against baseline.
5. **The user can see and undo it** — a page section, and every learned signal
   traceable to the labels that produced it.

Anything less is a prompt tweak with good intentions.

---

## 2. Where it stands today

```
decisions  ──▶  buildLearning()  ──▶  prompt block  ──▶  scores
                     │
                     └── median, suggested threshold, 5 examples
```

| Present | Absent |
|---|---|
| applied / skipped / shortlisted captured | nothing records which prompt produced a score |
| per-track medians | preferences beyond a score band |
| 3 applied + 2 skipped examples | examples are global, not per track |
| `npm run learn` report | no measurement, no UI, notes ignored |

---

## 3. The loop

```
        ┌──────────────────────────────────────────────┐
        │                                              │
        ▼                                              │
   label a job ──▶ decisions + context ──▶ derive ──▶ apply ──▶ score
                        │                    │          │        │
                        │                    │          │        ▼
                        │                    │          │    measure
                        │                    │          │   (shadow run)
                        │                    │          └──────┬─┘
                        │                    └─────────────────┘
                        └── notes become structured constraints
```

Six stages: capture, derive, apply, score, measure, adjust.

---

## 4. Data model

Two new tables, no changes to `scores`.

```sql
-- what produced a score, so variants can be compared
ALTER TABLE scores ADD COLUMN variant     TEXT;   -- 'baseline' | 'learned'
ALTER TABLE scores ADD COLUMN learning_at TEXT;   -- null when baseline

-- every derivation, kept so a past decision can be explained
CREATE TABLE learning_runs (
  id          TEXT PRIMARY KEY,
  at          TEXT NOT NULL,
  labels      INTEGER NOT NULL,
  version     TEXT NOT NULL,      -- hash of the derivation rules
  payload     TEXT NOT NULL       -- the JSON that went into prompts
);
```

The `variant` column is the whole measurement story: without it, "did learning
help?" is unanswerable.

---

## 5. Derive: what gets learned

Per track, from labelled postings joined to their jobs:

| Signal | Source | Applied how |
|---|---|---|
| **Score band** | median applied vs skipped | calibration line in the prompt |
| **Domain affinity** | job domains from `enrich` + profile domains | higher weight in the track brief |
| **Stack affinity** | job text matched against `profile.stack` | prompt hint, not a filter |
| **Location pattern** | accepted locations vs skipped ones | *suggestion only* — never auto-edits the radius |
| **Company affinity** | repeat applications at a company or its peers | prompt hint |
| **Negative patterns** | notes and skipped reasons | structured constraints, see below |

### Notes become constraints

`npm run feedback -- <id> skipped "too much travel"` currently stores text and
ignores it. The plan: a small classifier — lexical first, the model only if
ambiguous — mapping notes into:

```
{ location_penalty: true }     "too much travel", "far"
{ seniority_penalty: true }    "too junior", "not a manager role"
{ hands_on_penalty: true }     "wanted hands-on", "no coding"
{ domain_penalty: ["adtech"] }  "no more adtech"
```

Each constraint is shown back to the user for confirmation before it affects
anything. A misread note silently narrowing the search is worse than no
learning.

### Minimums

| Rule | Threshold |
|---|---|
| Any derivation | ≥ 5 applied **and** ≥ 10 skipped |
| Per-track derivation | ≥ 3 in that track |
| Note classification | nothing — one note is one data point |
| Suggested threshold | ≥ 8 points of separation |

---

## 6. Apply: how learning reaches the score

Ordered by risk, lowest first:

```
1. calibration + exemplars      (exists)
2. per-track exemplars          per track, from that track's own labels
3. similarity-selected examples nearest the job being scored, not nearest the median
4. preference hints             "this candidate has consistently accepted
                                 platform roles, rarely pure backend"
5. note constraints             hard prompt statements, user-confirmed
6. threshold proposal           printed, never applied
```

Steps 1–5 change the prompt only. **No score arithmetic, no weight changes.**
If a later version adjusts scores numerically, it must arrive with the
measurement from §7 already in place.

---

## 7. Measure: the part that makes it real

Without this section the loop is faith.

### Shadow scoring

Each run, score a small random subset **twice** — once baseline, once learned —
and store both with their `variant`. Cap at `LEARNING_SHADOW=10` jobs per run, so
the cost is bounded and known: about 10 extra model calls a day.

```sql
SELECT variant, AVG(score) FROM scores WHERE job_id = ? GROUP BY variant;
```

### Metrics

| Metric | Definition | Why |
|---|---|---|
| **precision@10** | of the ten best, the share labelled applied | the product question |
| **AUC** | applied scores above skipped scores | scale-free, works with few labels |
| **agreement** | baseline vs learned on the same job | detects churn without improvement |

Reported by `npm run eval`, with a **bootstrap confidence interval**.

### Sample sizes, stated honestly

| Labels per class | What you can conclude |
|---|---|
| < 20 | nothing. Any difference is noise |
| 20–50 | direction only, wide interval |
| 50–150 | a real comparison |
| 150+ | per-track conclusions |

The plan is to ship the measurement and *say* it is inconclusive until 50 per
class, rather than printing a number that looks like proof.

---

## 8. Surface

**CLI**

```
npm run learn          # calibration report, suggested threshold, constraints
npm run eval           # precision@10, AUC, variant comparison + CI
npm run learn -- reset # forget derived state, keep labels
```

**UI** — one section, no new concepts:

```
Learning
  41 applied · 87 skipped · measured over 3 runs
  precision@10  baseline 0.40 → learned 0.60  (95% CI 0.35–0.78)
  not enough data for a per-track conclusion
  [ Review 2 learned constraints ]
```

---

## 9. Safety

- **Every constraint is confirmed** before it filters anything.
- **Reset is one command**, and labels survive it.
- **Variants are recorded**, so a regression is attributable, not mysterious.
- **Nothing moves the user's threshold.** Ever.
- **The learning version is hashed** (`version` column), so a rules change
  invalidates old comparisons instead of silently mixing them.

---

## 10. Phases

| # | Phase | Deliverable | Days |
|---|---|---|---|
| L0 | Measurement plumbing | `variant` + `learning_at` columns, shadow scoring, eval metrics | 1.0 |
| L1 | Per-track learning | exemplars and calibration scoped to the track being scored | 0.5 |
| L2 | Similarity selection | choose examples nearest the job, not the median | 0.5 |
| L3 | Notes → constraints | classify, confirm, apply | 1.0 |
| L4 | Preference hints | domain/stack/location patterns in the prompt | 1.0 |
| L5 | Surface | `learn` reset, eval report, UI section | 0.5 |
| L6 | Calibration run | 50 labels per class, one measured comparison written up | 1.0 |

**~5.5 days**, but L0 is the only phase that must come first, and L6 is the only
one that proves anything.

Order matters: **L0 → L1 → L6 → the rest.** Measuring comes before preferring.

---

## 11. Out of scope

- Fine-tuning or training weights: the corpus is tens of labels, not thousands
- Embeddings-based personalisation: same reason, see DECISIONS 2
- Fully automatic filter changes: a wrong inference would silently narrow the
  search, and silence is indistinguishable from "nothing matched"
- Multi-user learning: one candidate, one model of their taste

---

## 12. What "done" looks like

```
1. a decision stores its context and its prompt variant
2. `eval` prints precision@10 for learned vs baseline, with an interval
3. the interval is the honest answer, including when it straddles zero
4. every derived signal can be traced to the labels behind it
5. one command forgets it all
```
