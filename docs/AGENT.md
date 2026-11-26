# From filter to agent — implementation plan

What it takes to turn a fixed pipeline that scores jobs into something that
chooses where to look, learns from what happened, and can explain itself.

The current product is a **reliable filter**: collect → filter → score → digest,
with a fixed order and a fixed set of boards. Making it an agent means adding
three capabilities it does not have — **outcomes**, **choices**, **autonomy** —
in that order. Autonomy first would produce a machine that searches more and
knows less.

> **Status (2026-11-25).** A0–A3 are implemented: stage outcomes, a board-yield
> ledger with retirement, holdout evaluation, and a planner behind
> `npm run agent` that the scheduler now runs. A4 needs a search key. A5 needs
> outcomes that do not exist yet. A6 waits on both.

---

## 1. What "agent" means here

Measurable, not rhetorical:

1. **It records outcomes**, not just clicks: applied → screening → interview →
   offer / rejected, per posting.
2. **It chooses** each day: where to search, what to retire, whether to spend.
3. **It improves**, and can prove it: a change is adopted only when an
   **out-of-sample** comparison supports it.
4. **It explains** every choice, and one command undoes the policy.
5. **It never applies for you.** The product's line stays where it is.

An agent that cannot demonstrate (3) is a scheduler with opinions.

---

## 2. Evidence today

| Claim | Measurement | Verdict |
|---|---|---|
| ranking beats a plain profile | 32 labelled pairs, in-sample: precision@10 learned 70% vs baseline 80%; AUC 0.65 (95% CI 0.45–0.83) | **not supported** |
| discovery can run without a key | 199 public names, ~1 board per 15 | works, bounded |
| discovery can scale | `discover-web` never executed; needs a search key | unproven |
| it can learn from feedback | sample gates open at 5/10 labels; 30 labels exist | mechanism runs, value unproven |
| the funnel works | 0 interviews, 0 offers recorded | **no outcome data at all** |

The first and last rows are the reason for this plan.

---

## 3. Design principles

- **The model scores; code decides.** No LLM in the control loop. A controller
  that can be read, tested and replayed beats a planner that cannot.
- **Outcomes are events.** The decision log already records every label change;
  the funnel is a projection of it, not a second source of truth.
- **Measurement before preference.** No threshold, query or prompt changes
  without a holdout comparison.
- **Every action is logged** with its reason and cost, in a table.
- **Reversible.** `npm run agent -- --reset` forgets policy state; labels and
  jobs survive.

---

## 4. The loop

```
        ┌──────────────────────────────────────────────┐
        │                                              │
        ▼                                              │
   observe  ──▶  plan  ──▶  act  ──▶  measure  ──▶  adopt
   outcomes      pure        existing   holdout      policy
   yield         function    commands   eval         version
   cost                                 CI
        │                                              │
        └──────────────────────────────────────────────┘
```

- **observe** reads the database: outcomes, yield per board, spend, days since
  a qualified application.
- **plan** is a pure function from state to a plan. No side effects, fully
  tested.
- **act** executes the plan with the existing commands: discovery, collect,
  score, digest.
- **measure** compares variants on labels collected *after* the change.
- **adopt** writes a new policy version only if the comparison clears a bar.

---

## 5. Data model

Two new tables, two columns. Nothing is rewritten.

```sql
-- the funnel is already in decision_log: (job_id, label, action, at)
-- add the index the projections need
CREATE INDEX decision_log_job ON decision_log(job_id, at);

-- what a board produced, so a dead one can be retired
CREATE TABLE board_yield (
  ats      TEXT NOT NULL,
  ident    TEXT NOT NULL,
  at       TEXT NOT NULL,     -- the run that measured it
  fetched  INTEGER NOT NULL,
  eligible INTEGER NOT NULL,
  matched  INTEGER NOT NULL,  -- at or above the threshold
  PRIMARY KEY (ats, ident, at)
);

-- every decision the controller made, why, and what it cost
CREATE TABLE policy_runs (
  id      TEXT PRIMARY KEY,
  at      TEXT NOT NULL,
  version TEXT NOT NULL,      -- hash of the policy rules
  plan    TEXT NOT NULL,      -- JSON: actions + reasons
  result  TEXT,               -- JSON: counts, spend, matches
  run_id  TEXT               -- the pipeline run it triggered
);

-- a prompt or threshold variant under test
CREATE TABLE experiments (
  id       TEXT PRIMARY KEY,
  kind     TEXT NOT NULL,     -- 'prompt' | 'threshold'
  variant  TEXT NOT NULL,
  started  TEXT NOT NULL,
  ended    TEXT,
  notes    TEXT
);

-- scores remember which arm produced them
ALTER TABLE scores ADD COLUMN arm TEXT;
```

**Why not store the funnel in a new table.** `decision_log` is append-only and
already records every stage change. A second table would drift; a projection
cannot.

---

## 6. Components

| Component | File | Responsibility |
|---|---|---|
| outcome capture | `src/ui/app.js`, `src/server/server.ts` | change a decided posting's stage; existing `/api/feedback` already accepts every stage |
| funnel projection | `src/engine/report.ts` | qualified applications, interview rate, cost per interview |
| board yield | `src/engine/pipeline.ts`, `src/storage/db.ts` | write `board_yield` at the end of a run |
| experiment assignment | `src/engine/score/rerank.ts` | stamp `scores.arm`; deterministic assignment by job id |
| holdout eval | `src/engine/report.ts` | `eval --holdout 30d`: tune on older labels, test on newer |
| planner | `src/engine/agent/plan.ts` | pure `planDay(state, policy) → Plan` |
| executor | `src/engine/agent/execute.ts` | turn a plan into the existing commands; log `policy_runs` |
| CLI | `src/cli.ts` | `npm run agent [-- --dry] [-- --reset]` |
| status | `src/cli.ts` | `npm run agent-status`: last plan, yield, outcome rate |

The planner is a **rule set with a version**, not a model. Learning enters only
through adoption of a new version after a holdout win.

---

## 7. Phases

Each phase ships with tests and an acceptance check, and can stop the project
without leaving it worse.

### A0 — Outcomes (1–2 days)

**Status:** done. The hidden list carries a stage selector, and every stage change is an event.

**Why first:** with zero interviews recorded, every downstream claim is fiction.

- UI: in the hidden list, a stage selector per row (applied, screening,
  interview, offer, rejected). A stage change posts to `/api/feedback`.
- CLI: `npm run feedback -- <id> interview` already exists; document it.
- `funnel` reports conversion from the event log, not the current label only.
- Tests: a stage change appends a `set` event; the funnel counts the latest
  stage per posting; clearing does not resurrect it.

**Acceptance:** after two weeks of use, `npm run funnel` shows a real
interview rate, or explicitly says "no outcomes yet".

### A1 — Yield ledger (1 day)

**Status:** done. `board_yield` is written per run; a board with 14 empty runs is retired and revival is automatic.

- Write one `board_yield` row per board per run: fetched, eligible, matched.
- `npm run agent-status` shows the top and bottom five boards.
- Retire a board after 14 consecutive runs with zero eligible postings;
  re-enable it if discovery finds it again.
- Tests: a fake run writes the rows; a silent board is disabled on the 14th
  miss; an active one is not.

**Acceptance:** the directory stops carrying boards that never produce a
candidate.

### A2 — Holdout evaluation (1–2 days)

**Status:** done. `npm run eval -- --holdout [days]` measures only labels made after the window.

- Split labels by time: tuner uses labels older than `HOLDOUT_DAYS` (default
  30); the test uses newer ones.
- `eval --holdout` reports precision@10 and AUC on the test slice only.
- Refuse to call anything an improvement below 20 test pairs, as today.
- Tests: labels are partitioned by timestamp; an in-sample win with no
  out-of-sample support is reported as such.

**Acceptance:** every future claim about learning is out-of-sample.

### A3 — Planner v1 (1–2 days)

**Status:** done. `npm run agent -- --dry` prints the plan; the real run records `policy_runs`, a run row and the board yield. `npm run agent-status` reports the plan, spend, yield and outcomes. Existing schedulers need `npm run schedule -- install` once to switch from `run` to `agent`.

A pure function with four rules, all off by default until measured:

```
if matches in the last 7 days < 3      → discover: next 40 unseen names
if a board has 0 eligible for 14 runs  → retire it
if spend this month > MONTHLY_CAP      → skip scoring, collect only
otherwise                              → collect, score, digest
```

- `planDay` returns actions with a reason string per action.
- `npm run agent -- --dry` prints the plan and exits without acting.
- `npm run agent` writes a `policy_runs` row, then executes.
- The scheduler runs `agent` instead of `run` (one-line change).
- Tests: each rule triggers on its input and only on it; the dry run performs
  no writes; the cost cap stops scoring but still collects.

**Acceptance:** a week of plans can be read back and every action has a reason.

### A4 — Search-driven discovery (1–2 days, needs a key)

**Status:** done. Serper provides 2,500 free queries without a card. When a
search key is configured, the plan's `discover` action runs search-driven
discovery; without one it falls back to the public name lists. Serper's free
tier rejects `site:` combined with quoted phrases, so queries name the ATS host
as a term — weaker, and a first real run returned 91 verified boards of mixed
relevance. Pruning and the yield ledger handle the noise.

- Generate queries from the profile: each track label × each city × ATS host.
- Run `discover-web` inside the plan when A3 asks for it.
- Resolve Comeet hits: `comeet.com/jobs/<slug>/<uid>` carries both identifiers.
- Record yield per query in `policy_runs.result` so queries can be ranked later.
- Tests: query construction from a profile; a hit is not added twice; a failed
  provider call is reported, not fatal.

**Acceptance:** the directory grows without a human list, and still verifies
identity before adding a board.

### A5 — Policy adoption (2–3 days, needs outcomes)

**Status:** not started. Cannot be honest before ~50 applications.

- Experiments: assign postings to prompt/threshold variants deterministically,
  stamp `scores.arm`.
- After `HOLDOUT_DAYS`, compare arms on labels collected after assignment.
- Adopt only when the 95% interval on the difference excludes zero and the
  point estimate favours the new arm. Otherwise keep the incumbent and record
  the failed test.
- `npm run agent -- --adopt <experiment>` writes a new policy version; one
  command reverts.

**Acceptance:** every threshold or prompt change in the repository has a
matching holdout result, or an explicit note that it was a judgement call.

### A6 — Bandit over discovery queries (2–3 days, last)

**Status:** not started.

Only once A0–A5 have produced ≥50 outcomes:

- Arms: query families (role term × city). Reward: qualified applications per
  unit of search spend.
- Thompson sampling with a cost prior; never more than `MAX_QUERIES` a day.
- Every draw and reward is logged in `policy_runs`.

**Acceptance:** the top query family accounts for most qualified applications,
and the bottom ones stop being run.

---

## 8. Metrics

| Metric | Definition | Target direction |
|---|---|---|
| **qualified applications / week** | applications the user actually made | up |
| **interview rate** | interviews ÷ applications | up |
| **cost per qualified application** | model + search spend ÷ applications | down |
| **discovery yield** | new boards per 100 names/queries | informational |
| **out-of-sample precision@10** | holdout slice only | up |
| **stale board share** | boards with 0 eligible in 14 runs | down |

`npm run agent-status` prints all six. A plan that improves none of them is not
progress.

---

## 9. Safety and reversibility

- **No auto-apply, ever.** It prepares a shortlist and a digest.
- **Caps:** `MONTHLY_CAP` on model spend, `MAX_QUERIES` on search, `MAX_BOARDS`
  on directory size.
- **Kill switch:** `AGENT_PAUSED=1` makes `agent` a no-op with an explanation.
  Two safety controls from this section are implemented now; experiments do
  not exist until A5.
- **One command forgets policy:** `npm run agent -- --reset` clears the plan
  history and the yield ledger; labels, scores and jobs survive.
- **Every action logged** in `policy_runs` with its reason, version and cost.

---

## 10. Cost

| Activity | Cost |
|---|---|
| one measured scan (2 samples, 10 shadow) | ~$0.02 |
| daily agent run | ~$0.02–0.05 with caps |
| search discovery | free tier; bounded by `MAX_QUERIES` |
| A0–A3 engineering | ~5 days |
| A4–A6 engineering | ~5–7 days, after outcomes exist |

The expensive part is not the model. It is waiting for outcomes: A5 cannot be
honest before roughly 50 applications.

---

## 11. Out of scope

- Auto-application, cover letters, form filling.
- Scraping job boards or LinkedIn.
- An LLM planner choosing actions from scratch.
- Multi-user or hosted concerns.
- Embeddings or a vector store; the filters earn their place first.

---

## 12. Definition of done

```
1. a stage change is event data, and the funnel is real            A0
2. dead boards retire themselves, with a log                       A1
3. no claim is made from in-sample data                            A2
4. every morning's actions and reasons can be read back            A3
5. the directory grows from queries, not a hand-written list       A4
6. a policy change ships only with a holdout win                   A5
7. search spend follows measured yield                             A6
```

When 1–5 hold, it is an agent in the only sense that matters: it decides what
to do next, and the decision is auditable. When 6–7 hold as well, it improves —
and can prove it with a number instead of a promise.
