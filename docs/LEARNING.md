# Learning loop

How decisions become calibration evidence, and how the effect is measured.

> **Status (2026-11-25).** L0–L5 are implemented: measurement, per-track
> examples, similarity selection, notes turned into confirmed constraints,
> preference hints, and a page section that shows all of it. Rules are
> versioned; every derivation is recorded; pairs from different rules are never
> compared.
>
> **L6 has run once.** On 32 labelled pairs the learned variant scored 70%
> precision@10 against the baseline's 80%, with an AUC interval of 0.45–0.83.
> **This is not evidence that learning helps** — and it is in-sample, with the
> answers visible. The result is recorded in §13, not hidden.

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

## 2. What exists

```
decisions ──▶ buildLearning() ──▶ prompt block ──▶ scores (+ variant, version)
                    │                                   │
                    └─ medians · examples ·             └─▶ shadow twin
                       preferences · constraints            (baseline)
```

| Implemented | Not implemented |
|---|---|
| applied / skipped / shortlisted / interview / offer as positive evidence | location affinity — the radius filter makes it circular |
| per-track medians, bar, and examples | company affinity — needs repeat decisions that do not exist yet |
| preferences from domains and stack, gated at 4 mentions and a 30-point lift | out-of-sample validation |
| notes → proposed constraints → confirmed or rejected | automatic constraint application, deliberately |
| variant, `learning_at` and rule version on every score | |
| shadow twins, rotation across runs, a 20-pair interval gate | |
| `learn` report, `--history`, `--reset`, and a page section | |

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

```sql
-- what produced a score, so variants can be compared
scores: + variant TEXT        -- 'baseline' | 'learned'
        + learning_at TEXT    -- null when baseline
        + learning_version TEXT

-- the same posting, scored without learning, so there is a twin
CREATE TABLE shadow_scores (
  job_id TEXT, track TEXT, score INTEGER,
  model TEXT, version TEXT, at TEXT,
  PRIMARY KEY (job_id, track)
);

-- every derivation, kept so a past score can be explained
CREATE TABLE learning_runs (
  id TEXT PRIMARY KEY, at TEXT NOT NULL, labels INTEGER NOT NULL,
  version TEXT NOT NULL,     -- hash of the derivation gates
  payload TEXT NOT NULL      -- the exact block that reached the model
);

-- rules inferred from notes; nothing applies until confirmed
CREATE TABLE learning_constraints (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, value TEXT,
  note TEXT NOT NULL, job_id TEXT,
  status TEXT NOT NULL DEFAULT 'proposed', at TEXT NOT NULL
);
```

`variant` is the measurement story: without it, "did learning help?" is
unanswerable. `learning_version` and `learning_runs` are the other half: `eval`
refuses to compare scores produced under different rules rather than averaging
them.

---

## 5. Derive: what gets learned

Per track, from labelled postings joined to their jobs:

| Signal | Source | Applied how |
|---|---|---|
| **Score band** | median positive vs negative decisions | calibration line in the prompt |
| **Domain and stack affinity** | job text matched against profile domains and stack | prompt hint: "roles they accept mention X more often" |
| **Negative patterns** | notes on decisions | proposed constraints, confirmed by the user |
| *Location pattern* | deferred: the radius filter makes every labelled job inside it | — |
| *Company affinity* | deferred: needs repeat decisions that do not exist | — |

### Notes become constraints

`npm run feedback -- <id> skipped "too much travel"` stores the note and the
classifier reads it. It is lexical on purpose — a model only when ambiguous was
considered and rejected, because a misread note is expensive and a model adds
another reason to distrust it. It maps notes into:

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
| Any derivation | ≥ 5 positive **and** ≥ 10 negative decisions |
| Per-track derivation | ≥ 3 in that track |
| Preferences | ≥ 4 mentions **and** a 30-point lift, and only above the 5/10 gate |
| Note classification | nothing — one note is one data point |
| Suggested threshold | ≥ 8 points of separation |

---

## 6. Apply: how learning reaches the score

Ordered by risk, lowest first:

```
1. calibration + exemplars      done, gated at 5 applied / 10 skipped
2. per-track exemplars          done, needs 3 of its own in that track
3. similarity-selected examples done, nearest the track being scored
4. preference hints             done, domains and stack
5. note constraints             done, proposed then confirmed
6. threshold proposal           printed, never applied
```

Steps 1–5 change the prompt only. **No score arithmetic, no weight changes.**
That is deliberate: there is no evidence yet that the prompt changes help, so
adding arithmetic would make the question harder to answer.

---

## 7. Measure: the part that makes it real

Without this section the loop is faith.

### Shadow scoring

Each run, score a bounded subset **twice** — once learned, once baseline — and
store both with their `variant`. `LEARNING_SHADOW=10` caps the extra calls per
run; the default is **0**, because it doubles the cost of the postings it
touches and that is the user's bill, not a silent default.

Postings without a twin are chosen first, so coverage grows by ten per run
instead of measuring the same ten forever.

### Metrics

| Metric | Definition | Why |
|---|---|---|
| **precision@10** | of the ten best, the share labelled applied | the product question |
| **AUC** | applied scores above skipped scores | scale-free, works with few labels |
| **agreement** | baseline vs learned on the same job | detects churn without improvement |

Reported by `npm run eval`, with a **bootstrap confidence interval**.

### Sample sizes, stated honestly

| Labelled pairs | What `eval` reports |
|---|---|
| < 20 | no interval at all — a bootstrap over a handful of values collapses to the point estimate |
| 20–50 | an interval, labelled "direction only" |
| 50+ | an interval, unqualified |

A number that looks like proof from four decisions is worse than no number. The
gate is enforced in the CLI, the API and the page from the same constant.

---

## 8. Surface

**CLI**

```
npm run learn                        # calibration, preferences, proposed constraints
npm run learn -- --confirm <id>      # accept a constraint; it reaches the prompt
npm run learn -- --reject <id>       # discard it
npm run learn -- --history           # rule versions that produced recent scores
npm run learn -- --reset             # forget shadow scores and proposals, keep labels
npm run eval                         # precision@10, AUC, variant comparison + CI
```

**UI** — one section, no new concepts. The counts are the user's own
decisions; the comparison appears only once a shadow pass has run:

```
Learning
  14 applied · 16 skipped
  Your applications score around 67; the ones you skip around 56.
  Your own decisions put the bar at about 58.  [Use it]
  direction only: 32 of the 50 pairs a firm comparison needs.

  Down-weight roles in adtech            your note: "no more adtech"  [Keep] [Ignore]
```

---

## 9. Safety

- **Every constraint is confirmed** before it filters anything.
- **Reset is one command**, and labels survive it.
- **Variants are recorded**, so a regression is attributable, not mysterious.
- **Nothing moves the user's threshold.** Ever.
- **The learning version is hashed** from the derivation gates, so a rules
  change invalidates old comparisons instead of silently mixing them.

---

## 10. Phases

| # | Phase | Deliverable | Days |
|---|---|---|---|
| L0 | Measurement plumbing | `variant`, `learning_at`, `learning_version`, shadow scoring, eval metrics | done |
| L1 | Per-track learning | exemplars and calibration scoped to the track being scored | done |
| L2 | Similarity selection | examples nearest the job, not the median | done |
| L3 | Notes → constraints | classify, confirm, apply | done |
| L4 | Preference hints | domain and stack patterns in the prompt | done; location and company deferred |
| L5 | Surface | `learn` reset and history, eval report, UI section | done |
| L6 | Calibration run | 50 labels per class, one measured comparison written up | **partial: 32 pairs, negative** |

L0–L5 are done. L6 is not code: it is the labelling work the loop exists for,
and the first run of it did not favour learning (§13).

Order mattered: measuring came before preferring, which is why the negative
result arrived before any score arithmetic was written.

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
1. a decision stores its context and its prompt variant          done
2. `eval` prints precision@10 for learned vs baseline, with CI   done
3. the interval is the honest answer, including when it straddles zero  done
4. every derived signal can be traced to the labels behind it    done
5. one command forgets it all                                    done
6. a measured result that favours the loop                       not yet — §13
```

The loop is mechanically complete and empirically unproven. That distinction is
the whole document.

---

## 13. The first measurement

Run on 2026-11-24, with 30 labels (14 applied, 16 skipped) and shadow coverage
of all 45 scored postings.

```
labelled shadow pairs      32
mean change                -0.8 points
agreement within 5         64%
precision@10 learned       70%   (7 of 10)
precision@10 baseline      80%   (8 of 10)
AUC learned                0.65  (95% CI 0.45–0.83)
AUC baseline               0.60
```

**What this says:** the point estimate for AUC is slightly better with learning,
the point estimate for precision@10 is worse, and the interval spans both harm
and benefit. There is no evidence of improvement.

**Why it is stronger than it looks:** the comparison is in-sample. The learning
block was built from these very labels before scoring. A mechanism that cannot
win with the answers visible is unlikely to win without them.

**What happens next:** the block stays because it is cheap and the interval is
wide, but nothing is built on it. The honest next step is 50 labels per class;
if the result stays negative, the prompt block should be removed and the labels
kept — they are still the eval set, which is the part that works.
