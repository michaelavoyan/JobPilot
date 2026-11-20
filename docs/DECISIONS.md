# Design decisions

Why JobPilot is built the way it is. Each entry records the choice, the reason,
and what would make it wrong. Structure and conventions live in
[`../AGENTS.md`](../AGENTS.md); usage lives in [`../README.md`](../README.md).

---

## 1. A pipeline, not an agent loop

```
collect → filter → score → show → your decision
```

An LLM deciding which tool to call next would add latency, cost and
nondeterminism to a task with a fixed shape. The model does exactly one thing:
score a posting it is given. Everything else is code.

**Would change if:** sources required real browsing to navigate — paginated
portals, logins, filters that must be discovered. That is an agent problem.

---

## 2. No embeddings, no vector search

At a few hundred to a few thousand postings a day, an LLM reading the
post-filtered survivors is cheaper and more accurate than maintaining a
multilingual embedding stack — and Hebrew is the case that breaks the cheap
English-first models.

**Would change above roughly 3,000 candidates a day**, where a multilingual
prefilter (`bge-m3`) earns its place in front of the model.

---

## 3. One model call per batch, every track at once

Scoring each track separately would triple the cost for identical information.
Filters run first, so a batch only contains postings that survived at least one
track, and one reply carries a score for each track that posting is eligible for.

---

## 4. Filters before the model, and every rejection recorded

Filtering is free; a model call is not. More importantly, the `rejects` table
answers "why didn't I see that job?" — the question that otherwise turns the
system into a black box.

**Consequence:** every rule must be explainable in one line, which is why the
rules are pure functions with no I/O.

---

## 5. A failed score is never a zero

If the model returns unusable JSON after a retry, the posting records
`scoring_failed` and carries no score. A zero would look like a confident "this
job is terrible" and would poison both the ranking and the evaluation set.

---

## 6. ATS platforms, not job boards

Comeet, Greenhouse, Lever, Ashby and Adzuna publish per-tenant APIs. They are
read the way their owners intend. The Israeli boards — AllJobs, Drushim,
JobMaster, Jobnet — have no API, so they are not scraped: a scraper in a public
repository is a legal and maintenance liability that never ends.

**This is the single biggest coverage limitation.** Israel has no country-wide
API; ADR 6 is the reason the search is company-shaped.

---

## 7. A tenant directory, not a company file

Those platforms publish no index of their customers, so "search Comeet" is not
something Comeet can answer. Discovery finds tenants by searching for career
pages, and the database remembers them. `collect` reads that table.

**Consequence:** discovery must run at least once. There is no file to maintain
and nothing to keep in sync, but deleting the database also deletes the list.

---

## 8. Country is configuration, not code

Everything market-specific — currency, salary period, clearance phrases, city
variants, country names — lives in `templates/market.<code>.yaml`. The engine
receives a normalised posting and never asks what country it is in.

**Test of the design:** adding Germany should mean a config file and an adapter,
not a branch.

---

## 9. A country means that country

With no commute radius set, a posting must still be in the market's country, and
a remote role must not be tied to a region the candidate cannot work from. An
empty radius means "anywhere in this country", never "anywhere".

---

## 10. The field is behaviour, not a label

The field selector carries exclusions and scoring context, not just a name.
"Sales Engineering Manager" matches the engineering-manager keyword, and the
field is what rejects it.

**Consequence:** adding a field is one entry in `engine/fields.ts`; nothing else
needs to change.

---

## 11. Decisions are reversible

Skip and Applied hide a posting permanently. That is right for a working list
and wrong for a misclick, so both undo paths exist: a short-lived Undo bar and a
permanent hidden list with Restore.

---

## 12. No build step

TypeScript runs directly on Node, SQLite ships with Node, and the page is three
plain files. `npm install` plus `node` is the entire toolchain.

**Would change when the page needs several views with shared state** — that is
where a framework starts paying for itself.

---

## Scoring rubric

Fixed bands, so a score means the same thing in March and in November.

| Band | Meaning |
|---|---|
| 90–100 | Meets nearly every requirement |
| 75–89 | Strong fit; one gap you could argue past |
| 60–74 | Plausible; meaningful gaps |
| 40–59 | The title matches, the substance does not |
| 0–39 | Wrong level, wrong domain, unactionable |

---

## Not building

Auto-applying, LinkedIn or Indeed, scraping the Israeli boards, cloud sync,
multi-user accounts.
