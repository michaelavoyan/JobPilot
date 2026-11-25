# Design decisions

Why JobPilot is shaped this way. Rules live in [`../AGENTS.md`](../AGENTS.md),
usage in [`../README.md`](../README.md).

| # | Decision | Why | Reverse it if |
|---|---|---|---|
| 1 | A fixed pipeline, not an agent loop | The model only scores; code decides the order. Deterministic, cheap, testable. | Sources need real browsing to navigate — logins, paging, filters to discover |
| 2 | No embeddings, no vector search | A model reading post-filtered survivors is cheaper and handles Hebrew better than a multilingual embedding stack | Above ~3,000 candidates a day, where a prefilter earns its place |
| 3 | One model call per batch, all tracks at once | Scoring tracks separately triples cost for identical information | Batches exceed the context window |
| 4 | Filters run before the model, every rejection recorded | Filtering is free; the `rejects` table answers "why didn't I see that job?" | Never — this is the debug story |
| 5 | A failed score is never a zero | A zero looks like a confident verdict and poisons ranking and evaluation | Never |
| 6 | ATS APIs only; no job-board scraping | Read the way their owners intend. A public scraper never stops breaking | A licensed feed covers the boards — buy it, don't scrape it |
| 7 | A tenant directory in the database, not a company file | The platforms publish no index, so discovery finds tenants and the database remembers them | A platform ships a real directory endpoint |
| 8 | Country is configuration, not code | Adding a market is a YAML file and an adapter | A market needs behaviour the config cannot express |
| 9 | A country means that country | No radius still means "in this country"; remote means "open to you" | Never |
| 10 | The field is behaviour, not a label | It carries exclusions and scoring context, so "Sales Engineering Manager" is rejected | Only one field would ever exist |
| 11 | Decisions are reversible | Skip and Applied hide postings permanently; misclicks must be undoable | Never |
| 12 | No build step | TypeScript on Node, SQLite in Node, three plain files for the page | The page needs several views with shared state |
| 13 | Learning is calibration, not training | Labels show where the user's bar actually sits and supply worked examples; no weights change and no prompt is rewritten from a handful of clicks | A sample large enough to fit a real preference model — hundreds of labels, not thirty |
| 14 | Constraints from notes are confirmed, never inferred into effect | A misread note that silently narrows a search is indistinguishable from "nothing matched"; the classifier is lexical, and a proposal changes nothing until the user accepts it | A note classifier accurate enough to act without review |
| 15 | Scores carry the rule version that produced them | Two scores from different learning rules are not the same measurement; `eval` counts old pairs as stale instead of averaging them | A rules change small enough to leave versioning unnecessary |
| 16 | Advanced funnel stages count as positive evidence; `rejected` counts as neither | An interview is stronger evidence than an application, and `rejected` is ambiguous between the company's decision and the candidate's | A separate decision recorded with who rejected whom |
| 17 | The local server refuses cross-origin requests | The page is bound to 127.0.0.1, but any website in the same browser could otherwise POST to it and start paid runs, rewrite the profile or label postings | A browser sandbox strong enough to make the check redundant |
| 18 | A score is called learned only when its prompt carried learned evidence | A batch of a track with nothing learned about it gets an unchanged prompt; counting it as learned would dilute the comparison toward "no difference" | Per-batch provenance in the score rows themselves |
| 19 | Undo clears a decision but never erases the record | Restoring a hidden posting used to delete the only evidence a choice was made; `decision_log` is append-only and metrics still read the current state | A decision model where an undone choice is genuinely uninteresting |
| 20 | Discovery guesses slugs and verifies identity when there is no search key | No ATS publishes a company index, and Comeet cannot be enumerated at all; probing names against public APIs is the only keyless path, at about one board per fifteen names | A search key, a paid company directory, or an ATS that ships an index |
| 21 | Repeated samples are averaged rather than trusting one call | The model moved the same posting by up to 16 points between identical runs; a single score is a sample, not a measurement | A provider that is deterministic at temperature 0 |
| 22 | The database is snapshotted before every run, seven kept | The file holds months of decisions: this project has already lost it twice. `VACUUM INTO` is used because WAL makes a plain copy lossy | A managed database with point-in-time recovery |
