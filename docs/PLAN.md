# JobPilot — Implementation Plan

**Location:** `~/Development/JobPilot`
**Status:** Phases 0–6 implemented and tested. See [`../README.md`](../README.md) for use, §14 for the two decisions still open.
**Runtime:** Node 26 · TypeScript (no build step) · SQLite · one npm dependency

---

## Contents

1. [What JobPilot is](#1-what-jobpilot-is)
2. [What a day looks like](#2-what-a-day-looks-like)
3. [Architecture](#3-architecture)
4. [Six design decisions](#4-six-design-decisions)
5. [Data model](#5-data-model)
6. [Components in detail](#6-components-in-detail)
7. [Configuration you own](#7-configuration-you-own)
8. [Commands](#8-commands)
9. [Daily scheduling](#9-daily-scheduling)
10. [Testing](#10-testing)
11. [Build order and effort](#11-build-order-and-effort)
12. [Risks](#12-risks)
13. [Deferred to v2](#13-deferred-to-v2)
14. [Decisions I need from you](#14-decisions-i-need-from-you)
15. [Glossary](#15-glossary)

---

## 1. What JobPilot is

JobPilot is a job-search assistant that runs on your laptop.

Every morning it does five things:

1. **Collects** job postings from company career pages and a few public feeds.
2. **Drops** the ones that are obviously wrong — wrong city, wrong level, requires security clearance, intern.
3. **Scores** the rest against your CV, from 0 to 100, with a short written reason.
4. **Writes** a short digest: the top matches, grouped by the kind of role you're hunting.
5. **Learns** from what you apply to, so the ranking improves over time.

It does not apply to jobs for you. It does not log into LinkedIn. It costs a few dollars a month and needs no server.

**Why not just use LinkedIn's search?** Because LinkedIn cannot know that "Director of Mobile" at a 12-person startup is wrong for you while "Engineering Manager, Mobile" at a 400-person company is right. JobPilot scores against the history extracted from your CV — level, scope, domain, stack — and it can explain every ranking.

### What JobPilot will not do

| Not doing | Reason |
|---|---|
| Apply to jobs automatically | Application quality collapses and most forms need human judgement |
| Scrape LinkedIn or Indeed | No usable API, active blocking, violates their terms |
| Ship a web UI | A markdown file and a Telegram message are faster to build and to read |
| Support multiple users | You are the only user; adding users later is a schema change |
| Use a vector database | Unnecessary at this volume — see decision D1 |
| Run as a chat-style agent | The job is a fixed pipeline; an agent loop adds cost and unpredictability for no benefit |

---

## 2. What a day looks like

> **07:30, Tuesday.** Your laptop wakes, launchd runs `node src/cli.ts run`.
>
> JobPilot reads your profile and the 180 companies in `companies.yaml`. It calls 180 career-page endpoints — 412 postings come back.
>
> 96 are new. The other 316 it has already seen, so it ignores them.
>
> The rule engine runs. 271 are dropped:
> - 88 don't match any track title ("Sales Director", "Backend Developer")
> - 61 require security clearance
> - 74 are in the wrong location
> - 48 are interns, students, or juniors
>
> 41 survive. These go to the LLM in 7 batches of 6.
>
> Each posting gets a score per track, plus two or three reasons:
>
> ```
> 84  Acme        Engineering Manager, Mobile     Tel Aviv    B
>     team of 8, KMP, consumer app at scale — strong scope match
> 79  Corvid      Head of Client-Side Platform   Herzliya    B
>     right level, but adtech-adjacent and lower stack overlap
> 41  Nexo        Mobile Team Lead                Petah Tikva A
>     only 2 reports; below your management scope
> ```
>
> It writes `out/digest-2026-11-19.md`, pushes the top 5 to Telegram, and exits. Total cost: about 30 cents.
>
> You read it over coffee. You mark three as `applied`, thirty-eight as `skipped`. Those forty labels are now the ground truth used to check whether next week's ranking is better or worse.

---

## 3. Architecture

### The pipeline

```
                    config/profile.yaml · tracks.yaml · market.yaml · companies.yaml
                                              │
                                              ▼
┌──────────────┐    ┌──────────────┐    ┌──────────────┐    ┌─────────────┐
│  1. INGEST   │───▶│  2. ENRICH   │───▶│   3. STORE   │───▶│ 4. FILTER   │
│              │    │              │    │              │    │             │
│ comeet       │    │ strip html   │    │ sqlite       │    │ title       │
│ greenhouse   │    │ detect lang  │    │ dedupe       │    │ clearance   │
│ lever        │    │ parse salary │    │ upsert       │    │ location    │
│ ashby        │    │ map city     │    │              │    │ salary floor│
│ remoteok     │    │              │    │              │    │             │
└──────┬───────┘    └──────────────┘    └──────────────┘    └──────┬──────┘
       │                                                           │ 41 survive
   errors go                                                     ▼
   into the run                                      ┌─────────────────────┐
   record, never                                     │   5. SCORE (LLM)    │
   kill the run                                      │  1 call per 6 jobs  │
                                                     │  score every track  │
                                                     │  reasons + flags    │
                                                     └──────────┬──────────┘
                                                                │
                                                                ▼
                                                     ┌─────────────────────┐
                                                     │   6. DELIVER        │
                                                     │  digest .md         │
                                                     │  telegram (opt)     │
                                                     └──────────┬──────────┘
                                                                │
                                                                ▼
                                                     ┌─────────────────────┐
                                                     │   7. FEEDBACK       │
                                                     │ applied / skipped   │
                                                     └──────────┬──────────┘
                                                                │
                                                                ▼
                                                     eval set → precision@10
```

### What each stage guarantees

| Stage | Runs on | Uses LLM | If it fails |
|---|---|---|---|
| **Ingest** | Each company's API | No | Logs the error, continues with other companies |
| **Enrich** | Every posting | No | Fills defaults; never throws |
| **Store** | New + changed postings | No | Transactional upsert; a crash leaves the last good state |
| **Filter** | New postings, per track | No | Pure function; fully unit-tested |
| **Score** | Filter survivors | **Yes** | Retries once, then marks "unscored" — never writes 0 |
| **Deliver** | Scores above threshold | No | Digest is written even if Telegram fails |
| **Feedback** | You, via CLI | No | Manual; nothing depends on it running |

**The key property:** stages 1–4 are free, instant and deterministic. Only the 41 postings that survive them cost money. This is what keeps the bill at cents instead of dollars.

---

## 4. Six design decisions

These are the choices that shape everything else. Each one is a trade-off, not a preference.

### D1 — No embeddings, no vector database

**The obvious design** is to embed your CV, embed every job description, and rank by cosine similarity.

**Why we're not doing it.** At your volume — a few hundred to a couple of thousand postings a day — an LLM reading the 41 that survive the filters is both cheaper and more accurate than maintaining a multilingual embedding stack. Critically, the text is often Hebrew, and the cheap English-first embedding models score Hebrew poorly. An LLM reads Hebrew properly.

**When this changes:** above roughly 3,000 candidates a day, or if you add several countries at once. Then a multilingual model (`bge-m3`) goes in front as a cheap prefilter, and the LLM scores only the top slice.

### D2 — One LLM call per six jobs, scoring all tracks at once

Scoring each track separately would triple the cost for identical information — the same job description, read three times.

Instead, filters run first. A job that survives track B but not track A goes into the batch with only track B's brief. One call returns a score for every track that job is eligible for.

**Result:** ~7 calls per day at current volume.

### D3 — Filters run before the model, and every rejection is recorded

Two reasons.

First, cost. Filters are free. Sending 412 postings to an LLM instead of 41 costs ten times more and adds nothing.

Second, and more important: **the `rejects` table**. It records every dropped posting and why. When you wonder "why didn't I see the Waze role?", the answer is one query away. Without it, you'd be debugging a black box.

### D4 — A failed score is stored as "no score", never as 0

If the LLM returns malformed JSON and both retries fail, JobPilot records `scoring_failed` and moves on.

Writing 0 would look like a confident "this job is terrible". That single mistake would corrupt your ranking *and* your evaluation data, and it would be invisible.

### D5 — Country facts live in configuration, not in code

Everything Israel-specific sits in `config/market.yaml`: the currency, the fact that salaries are quoted monthly, the clearance phrases in Hebrew, the city name variants.

The matching engine receives a normalized job and never asks what country it's in. **Adding Germany later means one new config file plus an adapter — not a rewrite.** This is the test of whether the design actually scales.

### D6 — Zero build step, one dependency

Node 26 runs TypeScript directly and ships SQLite in the standard library. So there's no compiler, no bundler, no native module to rebuild, and one npm package (`yaml`).

Practically: `git clone`, `npm install`, `node src/cli.ts run`. Nothing to break, and the code stays readable to you as a TypeScript engineer.

---

## 5. Data model

One SQLite file at `data/jobs.db`. Five tables.

### `jobs` — every posting ever seen

| Column | Purpose |
|---|---|
| `id` | Fingerprint: hash of company + title + locations. This is what makes runs idempotent. |
| `source` | `comeet`, `greenhouse`, `lever`, `ashby`, `remoteok` |
| `company` | Display name from `companies.yaml` |
| `title` | As published |
| `url` | Application link |
| `locations` | Canonical city names, as JSON |
| `remote` | 0 or 1 |
| `description` | Cleaned plain text |
| `description_hash` | Changes only when the text really changes |
| `posted_at` | If the source provides it |
| `comp` | Parsed salary, as JSON, when extractable |
| `lang` | `he`, `en`, `mixed`, `und` |
| `first_seen` / `last_seen` | Lifecycle tracking |
| `active` | Set to 0 when a posting disappears from its source |

### `scores` — the LLM's verdict, per posting per track

| Column | Purpose |
|---|---|
| `job_id` + `track` | Primary key |
| `score` | 0–100, on the fixed rubric |
| `reasons` | JSON array of 1–3 short strings — shown in the digest |
| `flags` | JSON array, e.g. `insufficient_text`, `team_scope_unclear` |
| `model` | Which model produced it |
| `profile_hash` | Lets the system know when to re-score after you edit your profile |

### `rejects` — every dropped posting and why

`(job_id, track, reason, at)`. Populated by the filter stage.

Serves three purposes: debugging missing jobs, spotting a filter that's too aggressive, and tuning the rules with evidence instead of guesses.

### `decisions` — your labels, which become the eval set

| Column | Purpose |
|---|---|
| `job_id` | The posting |
| `label` | `applied`, `shortlisted`, `skipped` |
| `note` | Optional free text |
| `at` | Timestamp |

This is the most valuable table in the database. It's the only thing that can tell you whether a prompt change made the ranking better or worse.

### `runs` — one row per execution

Counts, errors, and cost per run. Answers "is it still working?" and "what did it cost me this month?".

---

## 6. Components in detail

### 6.1 Ingest

Five adapters behind one interface. Each adapter knows one company API.

| Adapter | Endpoint | Notes |
|---|---|---|
| **Comeet** | `comeet.co/careers-api/2.0/company/{uid}/positions?token={token}&details=true` | The most important one. Comeet is the dominant ATS for Israeli tech. Needs both a company UID and a public token, both readable from the company's careers page. |
| **Greenhouse** | `boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=true` | Free, no auth. Returns HTML-escaped content. |
| **Lever** | `api.lever.co/v0/postings/{slug}?mode=json` | Free, no auth, clean plain text. |
| **Ashby** | `api.ashbyhq.com/posting-api/job-board/{slug}` | Free, no auth. Also returns compensation when available. |
| **RemoteOK** | `remoteok.com/api` | Global remote feed. Noisy, but free. First array element is a legal notice — skip it. |

**Failure isolation.** Each adapter returns jobs *and* errors. A dead endpoint becomes one line in the run record, not a crashed night. Eleven healthy sources out of twelve still produce a useful digest.

**Tolerant field mapping.** Every field is read with a fallback chain. If Comeet renames `url_active_page`, the adapter returns `undefined` and logs it — instead of throwing and losing 180 companies' worth of data.

**A `dump` command** prints the raw JSON for one company, so fixing a renamed field takes a minute rather than an afternoon.

### 6.2 Enrich

Four small transforms, all deterministic:

- **Text cleaning** — strip scripts, styles and tags; decode entities; collapse whitespace. Applied before hashing, so a re-rendered page with identical text doesn't trigger a re-score.
- **Language detection** — Hebrew vs Latin character ratio, classified as `he`, `en`, `mixed` or `und`. Drives the prompt and, importantly, the eval breakdown.
- **Salary extraction** — deliberately conservative. Only parses when a currency marker (`₪`, `ש"ח`, `ILS`) sits next to a number, or a `XK` / `X אלף` pattern appears with an explicit monthly marker. A guessy parser would silently drop good jobs.
- **Location canonicalization** — Hebrew aliases map to English city names (`תל אביב` → `Tel Aviv`). `מרחוק` and `remote` set the remote flag; `היברידי` sets a hybrid flag.

### 6.3 Filter

A pure function: `(job, track, profile, market) → verdict`. No network, no clock, no database. That makes it trivially testable and impossible to flake.

Applied in order, cheapest and most decisive first:

| # | Rule | Rejection reason |
|---|---|---|
| 1 | Title matches a track exclusion (intern, junior, VP Sales) | `title_exclude:<term>` |
| 2 | Title matches one of the track's inclusion keywords | `title_not_in_track` |
| 3 | Not one of the market's seniority traps | `seniority_trap` |
| 4 | No security-clearance or citizenship requirement | `clearance_required` |
| 5 | City or region is within your radius, or the role is remote | `location` |
| 6 | Salary is at or above your floor (only when both sides are known) | `comp_below_floor` |

Rule 6 is inactive while `comp_floor` is `null`. That's deliberate: a wrong floor silently deletes jobs, and silence is the worst kind of bug.

### 6.4 Score

**Input per batch:** a compact profile block (~600 tokens), the eligible track briefs (~150 tokens each), and up to 6 postings with the first 1,200 characters of description.

**Output contract** — strict JSON, validated before storage:

```json
{
  "results": [
    {
      "i": 0,
      "scores": {
        "b_senior_em": {
          "score": 84,
          "reasons": ["team of 8 in scope", "KMP in stack", "consumer app at scale"],
          "flags": []
        },
        "a_director": {
          "score": 38,
          "reasons": ["single team, not a director-level org"],
          "flags": ["scope below track"]
        }
      }
    }
  ]
}
```

**The rubric is fixed**, so scores are comparable across days:

| Band | Meaning |
|---|---|
| **90–100** | Meets nearly every requirement; the profile is an obvious fit. |
| **75–89** | Strong fit; one gap you could argue past. |
| **60–74** | Plausible; meaningful gaps in scope, domain, or stack. |
| **40–59** | The title matches but the substance doesn't. |
| **0–39** | Wrong level, wrong domain, or unactionable. |

**Prompt rules that matter:**

- Judge **level first**, then domain, then stack. A perfect stack at the wrong level is a 40, not an 85.
- A "manager" role with no reports scores ≤50 on track B.
- Hebrew postings are judged on the same rubric — no language penalty.
- Truncated or empty descriptions cap at 55 and carry the flag `insufficient_text`.

**Cost:** roughly 6,400 input and 800 output tokens per batch. At 41 candidates a day that's 7 calls — about **$0.30/day** on a mid-tier model, **$0.03/day** on a small one.

### 6.5 Deliver

Markdown digest at `out/digest-YYYY-MM-DD.md`:

```markdown
# 2026-11-19 — 7 new matches

## Senior EM / Group Lead (3)
### 84 · Acme · Engineering Manager, Mobile — Tel Aviv
team of 8 in scope · KMP in stack · hybrid, 3 days
> Owning our mobile platform, a team of 8 engineers, KMP + native...
[Apply](https://...)

## Director / Head of Engineering (1)
...
```

Grouped by track (B, then C, then A), sorted by score, capped at 15 rows. Each entry shows the score, the reasons, the flags, one sentence of context, and the link.

Telegram push is optional: top 5 only, links and scores, no descriptions.

### 6.6 Feedback and evaluation

```
npm run feedback -- <job-id> applied
npm run feedback -- <job-id> skipped "too much travel"
```

Then:

```
npm run eval
```

reports four things:

| Metric | What it catches |
|---|---|
| **Precision@10** per track | Is the top of the list actually good? |
| **Score distribution by language** | Hebrew postings being systematically under-scored |
| **Reject sample by reason** | A filter that's eating good jobs |
| **Label count and balance** | Whether you have enough data to trust any of the above |

**Threshold for trusting the digest:** at least 30 labels and precision@10 ≥ 0.7 on track B. Below that, the ranking is an opinion.

---

## 7. Configuration you own

Four YAML files. All already created. Editing them never requires touching code.

| File | Contains | In git |
|---|---|---|
| `templates/*.yaml` | Shipped starting points, no personal data | yes |
| `config/profile.yaml` | Generated by `npm run profile` from a PDF CV | **no** |
| `config/market.yaml` | Your market: currency, salary markers, clearance patterns, city aliases | **no** |
| `config/tracks.yaml` | The role types you're hunting, with title keywords and scoring briefs | **no** |
| `config/companies.yaml` | The target company list | **no** |

**No personal data is in the repository, and no default persona either.** `config/` is gitignored in full and seeded from `templates/` by `npm run init`. `--config <dir>` or `JOBCONFIG_DIR` points the tool at any other directory, so configuration is always an input. The profile comes from your CV at setup time; extraction is a parser, not a recruiter — it is instructed to omit anything the document does not state, and the two facts a CV cannot contain (commute radius, salary floor) are left for you.

**The profile is generated from your CV into a gitignored directory.** `npm run init` seeds `config/` from `templates/`; `npm run profile -- cv.pdf` then extracts the profile into `config/profile.yaml`. Nothing in the repository holds a name, a market or a company list, so it is safe to publish as-is. Extraction is a parser, not a recruiter: anything the CV omits stays empty rather than being invented.

**`companies.yaml` is the file that determines quality.** 150 deliberately chosen companies beat every aggregator. Populate it with `npm run discover -- <careers-url>`.

---

## 8. Commands

| Command | What it does |
|---|---|
| `npm run profile -- <cv.pdf>` | Extract a profile from a CV into `config/profile.yaml` |
| `npm run sources` | Health-check every enabled source; print counts and errors |
| `npm run collect` | Fetch, clean, dedupe, store |
| `npm run score` | Filter and score new postings |
| `npm run digest` | Write the markdown digest, push to Telegram |
| `npm run run` | All three, in order — this is what the scheduler calls |
| `npm run discover -- <url>` | Turn a careers page URL into a `companies.yaml` entry |
| `npm run dump -- <url>` | Print a source's raw JSON, for debugging |
| `npm run feedback -- <id> <label>` | Record applied / shortlisted / skipped |
| `npm run eval` | Print ranking quality metrics |

Every command is idempotent and safe to interrupt. Running `collect` twice adds nothing the second time.

---

## 9. Daily scheduling

A macOS `launchd` agent runs `npm run run` daily at 07:30, logging to `~/Library/Logs/jobpilot.log`.

```bash
npm run schedule -- install     # creates and loads the agent
npm run schedule -- run         # trigger it once, now
npm run schedule -- status
npm run schedule -- uninstall
```

The plist is generated from the current paths, so it works from any checkout location.

`launchd` rather than `cron` because it handles sleep properly: if the laptop is closed at 07:30, the run happens on wake instead of being skipped.

```xml
<key>ProgramArguments</key>
<array>
  <string>/usr/local/bin/node</string>
  <string>/Users/YOUR_USER/Development/JobPilot/src/cli.ts</string>
  <string>run</string>
</array>
```

`launchd` rather than `cron` because it handles sleep properly: if the laptop is closed at 07:30, the run happens on wake instead of being skipped.

---

## 10. Testing

`node:test` — built in, no framework.

| Layer | How it's tested |
|---|---|
| **Enrich** | Table-driven cases: HTML fixtures, Hebrew JDs, `45K ₪`, `30,000 ש"ח`, mixed Hebrew/English |
| **Filter** | One case per rejection reason, plus false-positive guards — e.g. "team lead" must not match "lead generation" |
| **Store** | In-memory database: upsert idempotency, re-score triggered by profile change, active flag on disappearance |
| **Score** | Contract only: JSON parsing, validation, repair path. No live LLM calls in tests. |
| **Ingest** | Recorded fixtures per adapter. A test fails if an adapter returns zero jobs for a fixture containing jobs. |

**Golden-set rule:** any prompt change requires an `eval` run, and the before/after precision@10 goes in the commit message. Otherwise prompt edits are guesswork dressed up as improvement.

---

## 11. Build order and effort

| # | Phase | Deliverable | Days |
|---|---|---|---|
| **0** | Skeleton | Types, config loading, database, `sources` command | 0.5 |
| **1** | Ingest | Five adapters, enrichment, dedupe | 1.0 |
| **2** | Filter | Rules engine, tests, reject recording | 0.5 |
| **3** | Score | LLM adapter, prompt v1, batching, validation | 1.0 |
| **4** | Deliver | Markdown digest, Telegram, `run` | 0.5 |
| **5** | Onboarding | `discover`, seed 30 companies, first real run | 0.5 |
| **6** | Evaluation | `feedback`, `eval`, first 30 labels, prompt tuning | 1.0 |
| **7** | Schedule | launchd agent, log rotation | 0.25 |

**Total: ~5.25 days.**

Phases 0–5 (3.5 days) produce a digest you can read. Phase 6 is what stops it degrading — skipping it is the most common way a project like this dies quietly in week three.

---

## 12. Risks

| Risk | What happens | Mitigation |
|---|---|---|
| **Comeet changes its payload** | Adapter silently returns zero jobs | Tolerant field mapping, fixture test asserting non-zero, `dump` command |
| **Hebrew scored worse than English** | Good roles buried at the bottom | Language-tagged eval buckets, Hebrew test fixtures, a dedicated calibration pass |
| **LLM costs creep** | Surprise bill | Filter before model, per-run cap, cost recorded per run |
| **Over-filtering** | You never see a role you'd have wanted | `rejects` table, weekly sample review |
| **Too few companies** | Digest starves within a week | Minimum 30 companies before phase 6 |
| **Score drift** | Week 4 isn't comparable to week 1 | Frozen eval set, fixed rubric anchors, profile hash |
| **Scraper temptation** | Legal exposure and constant breakage | Board scrapers off by default; opt-in only, with the trade-off stated |
| **LLM provider outage** | No scores tonight | Fail soft: collect and digest still run, entries marked unscored |
| **Your own attention** | Project abandoned in week 3 | Digest is 15 rows, read in 2 minutes; feedback is one command |

---

## 13. Deferred to v2

1. **Hebrew job-board coverage** — AllJobs, Drushim, JobMaster, Jobnet, GotFriends, Ethosia. None have a public API. Prefer a paid reseller over hand-rolled scrapers: cheaper than maintaining proxies, and someone else handles the breakage.
2. **Embeddings prefilter** — only past ~3,000 candidates/day, and only with a genuinely multilingual model.
3. **Second country** — a new `market.<cc>.yaml` plus adapters. This is the real test of decision D5.
4. **Application tracker** — status per job from applied through offer, plus a weekly funnel report.
5. **Network pass** — warm introductions at target companies. Frequently a higher yield than any digest.
6. **CV tailoring** — a per-posting CV variant generated from the profile block.

---

## 14. Decisions I need from you

| # | Decision | Why it blocks | Current default |
|---|---|---|---|
| 1 | **Primary track: B or A?** B = Senior EM / Group Lead (more roles). A = Director / Head (fewer, higher ceiling). | Sets digest ordering, the salary floor, and which companies get seeded first | B → C → A |
| 2 | **Salary floor** — a real monthly gross figure in ILS | Filter stays off until set; a wrong number silently drops good roles | `null` (off) |
| 3 | **Commute radius** — which cities, or remote-only | `locations.allowed` is currently my guess | Tel Aviv area list |
| 4 | **LLM provider** — Anthropic (better Hebrew) or OpenAI (cheaper) | No default assumed; the model ID must be explicit and is validated at startup | none |
| 5 | **Board scrapers** — ATS-only, or add AllJobs/Drushim in phase 1.5? | Changes the build order and adds legal/reliability surface | ATS-only |

---

## 15. Glossary

| Term | Meaning |
|---|---|
| **ATS** | Applicant Tracking System — the software a company uses to publish jobs. Comeet, Greenhouse, Lever and Ashby are ATSs. Their job pages are public, which is why we can read them. |
| **Job board** | An aggregator that lists other companies' jobs — AllJobs, Drushim, LinkedIn. They don't own the postings, and they don't provide free APIs. |
| **Track** | One of the three role types you're hunting. Each has its own filters and its own ranking. |
| **Hard filter** | A rule that rejects a posting outright. Deterministic, no model involved. |
| **score (0–100)** | The LLM's opinion of fit, on a fixed rubric. |
| **precision@10** | Of the top 10 results, what fraction you'd actually apply to. The metric that matters most. |
| **Eval set** | A frozen list of postings with your hand labels, used to measure whether changes help. |
| **Idempotent** | Running it twice has the same effect as running it once. |
| **WAL** | SQLite's write-ahead logging mode — allows reading while writing. |
| **Fail soft** | A component failure degrades the result instead of killing the run. |
