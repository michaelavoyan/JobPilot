# JobPilot

**Find the jobs worth your time.**

---

JobPilot reads your CV, looks at every job open at the companies in its board
directory, and hands you a short list.

Each one is scored, explained in a sentence, and ready to apply to.

No searching. No scrolling. No LinkedIn.

![JobPilot](docs/screenshot.png)

---

## What it does

**Reads your CV** — your level, your skills, your background.

**Sorts the market** — it discards the wrong level, the wrong place, and anything you cannot take.

**Scores what is left** — out of 100, with a reason you can read.

---

## How the search works

```
boards → collect → filter → score → rank → digest
                    ↑                    ↓
                 rejects            your decisions
```

Every stage is cheap-to-expensive on purpose: nothing reaches the model until
the free checks have thrown most of the market away.

### 1. Find the boards

A board is a company's public ATS feed — Greenhouse, Lever, Ashby, Comeet — or
one of two global feeds, Adzuna and RemoteOK. The agent finds the company boards
two ways:

- **Without a key**, from public company lists: names become slug candidates,
  each is probed against the public ATS APIs, and a board is accepted only when
  it names the company that was asked for. Slow, but it needs no account.
- **With a search key** (`BRAVE_API_KEY`, or `GOOGLE_API_KEY` + `GOOGLE_CSE_ID`),
  `discover-web` searches for careers pages directly. This is the precise path.

Boards are remembered in the database. `DISCOVER_ON_RUN=1` grows the directory
before each run, and every company is probed only once — a name tried and found
empty is not asked again.

### 2. Collect

Each board is fetched from its ATS API, not by scraping its web page. Postings
are normalised — HTML stripped, language detected, locations canonicalised,
salary parsed — and stored by a hash of the description, so a re-listed job
updates instead of duplicating.

A source that fails is reported and skipped; it never takes the run down.

### 3. Filter, before any model call

Each posting is tested against every enabled track:

| Check | Rejects |
|---|---|
| title include / exclude | "Sales Manager", "VP", "Data Scientist" |
| field | sales, legal, finance, support, design |
| seniority traps | intern, junior, student |
| location | outside your commute radius (when one is set), or an excluded remote region |
| clearance | roles that require one you do not hold |

Every rejection is written down with its reason. `npm run eval` reports the top
ones, so an over-tight filter is visible rather than silent.

### 4. Score

Survivors are grouped by track and sent to the model in small batches. The
prompt contains your profile, the track's brief, the market, and — once you
have enough labels — a calibration block derived from your own decisions.

- **Temperature 0**, because scoring is a measurement, not a writing task.
- **`SCORE_SAMPLES=2`** (default 1) scores each posting twice and averages. The model
  disagrees with itself by up to 16 points between identical runs; averaging
  halves that, at twice the cost.
- **A failure never becomes a zero.** If a batch cannot be scored, the posting
  is left unscored and reported, because a fake zero would poison the ranking
  and the labels.

### 5. Rank and deliver

The best score per posting decides its place. Anything at or above your
threshold becomes the digest, the Telegram push if configured, and the list on
the page. Applied and skipped postings disappear from every future list.

### 6. Measure

`npm run eval` answers whether the ranking matches your judgement:

- **precision@10** — of the ten best, how many did you apply to
- **AUC, learned vs baseline** — the same postings scored with and without
  your decisions, with a bootstrap interval
- **per-track precision** — the same number for each track separately

Below 20 labelled pairs no interval is reported; 20–49 is labelled "direction
only". A number that looks like proof from four decisions is worse than no
number.

There is no vector database and no embedding step: the filters do the cheap
sorting and the model reads only what survives. The reason is in
[`docs/DECISIONS.md`](./docs/DECISIONS.md).

---

## It learns from your decisions

Mark jobs **Applied** or **Skipped**, and the agent uses your decisions as
calibration evidence: it works out where your bar actually sits and shows the
model a few of your own postings as worked examples.

It starts at **five applied and ten skipped**. Below that a handful of clicks is
noise, so the scorer runs on your profile alone — `npm run learn` says how many
more it needs. The more you label, the closer the scores get to your judgement.

If you write a note when you skip something — "too far", "no more adtech" — the
agent reads it and proposes a rule. Nothing changes until you confirm it, and
every confirmed rule stays visible so you can remove it.

It does not invent a preference you never expressed, and it never moves your
threshold on its own — `npm run learn` tells you what it would suggest.

---

## Getting started

You need Node.js 24 or newer, and one AI key — DeepSeek, Anthropic, OpenAI or
OpenCode Go.

```bash
git clone https://github.com/michaelavoyan/JobPilot.git
cd JobPilot
npm install
npm run init -- --market il
cp .env.example .env    # paste your AI key here
./start.sh
```

Then, on the page:

1. **Drop your CV** — PDF, Word or Markdown.
2. **Choose your country.**
3. **Press Find jobs.**

That is the whole setup.

### Make it run by itself

```bash
npm run schedule -- install   # collect, score and digest daily at 07:30
npm run health                # scheduler, last run, backups, directory size
npm run backup                # snapshot the database now
```

The daily run also snapshots the database first and keeps the last seven, so a
mistake costs a day, not a history. On a failed run it exits non-zero and, on
macOS, sends a desktop notification instead of failing quietly into a log.

Set `DISCOVER_ON_RUN=1` in `.env` to let it look for new companies before each
run. Each company is probed once; when the public lists are exhausted the
directory stops growing, which is the honest ceiling of the keyless path.

Grow it by hand at any time:

```bash
npm run discover-list -- --limit 120    # public company lists, no key
npm run discover-web -- --bands "1-20"  # search key required
npm run discover -- <careers-url>       # one company, by its careers page
```

Each adds boards to the database; the next run collects from them.

---

## After you decide

| | |
|---|---|
| **Apply** | Opens the job. Nothing is saved. |
| **✓ Applied** | Saves it and clears it from the list. |
| **✕ Skip** | Hides it from every future list. |

Changed your mind? Press **Undo**, or open **hidden** below the list and bring
any job back. Undo clears the decision from the metrics but keeps it in the
decision log, so a choice can be explained later even after it is reversed.

Your decisions also calibrate the scorer: from five applied and ten skipped it
is shown where your bar actually sits, and `npm run learn` suggests a minimum
score. The suggestion is never applied for you.

---

## Private by default

Your CV, your jobs and your decisions stay on your own computer. The web page
listens on `127.0.0.1` only, refuses requests from other sites, and nothing is
cached.

Two things can leave, both because you asked for them: the job text sent to the
AI that scores it, and the digest if you configure Telegram.

---

## What it will not do

It will not apply for you, will not use LinkedIn, and will not scrape the job
boards. It reads public ATS APIs and the careers pages you point it at.

---

## For contributors

The code is four packages — `ui`, `server`, `engine`, `storage` — with the rules
written down in [`AGENTS.md`](./AGENTS.md) and enforced by `npm test`.

| Read | For |
|---|---|
| [`AGENTS.md`](./AGENTS.md) | the package rules, and where new code goes |
| [`docs/ENGINE.md`](./docs/ENGINE.md) | diagrams: a run, discovery, the profile path |
| [`docs/SERVER.md`](./docs/SERVER.md) | diagrams: routes and the live run stream |
| [`docs/STORAGE.md`](./docs/STORAGE.md) | diagrams: the schema and its two key queries |
| [`docs/LEARNING.md`](./docs/LEARNING.md) | how decisions become calibration, and how that is measured |
| [`docs/DECISIONS.md`](./docs/DECISIONS.md) | why it is built this way, and what would reverse it |
| [`docs/RELEASE.md`](./docs/RELEASE.md) | how a release is cut, and what each one contained |

`npm test` type-checks and runs the suite; `npm run typecheck` runs only the
compiler.

---

## License

MIT — see [LICENSE](./LICENSE).
