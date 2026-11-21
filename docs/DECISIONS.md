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
