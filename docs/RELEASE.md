# Release plan — 0.1.0

What stands between "working software" and "shipped product", in order.
Each item has an acceptance check, so "done" is not a judgement call.

Status at the time of writing, verified:

```
main            65c0343
tests           226 pass, typecheck clean
open PRs        none
config          placeholder: name "Your Name", 0 boards, 0 jobs
scheduler       installed, pointed at that empty config
CI              none
tag             0.1.0 declared in package.json, never tagged
```

---

## 1. Rebuild the config

The software works; this installation is empty. Nothing else in this plan can
be verified until there is real data.

### Steps

1. **Upload the CV** — open `./start.sh`, drop the PDF, wait for extraction.
   Alternative: `npm run profile -- ~/Documents/cv.pdf`.
2. **Set the two preferences a CV cannot carry** — in `config/profile.yaml`:
   `locations.allowed` (commute radius) and `comp_floor` (or leave `null`).
3. **Fill the tenant directory**, one of:
   - `npm run discover-web -- --bands "1-20,21-100,101-500"` — needs
     `BRAVE_API_KEY`, or `GOOGLE_API_KEY` + `GOOGLE_CSE_ID`
   - `npm run discover -- <careers-url>` per company — no key needed, slower
   - import the directory from a previous install, if one exists
4. **One search** — press Find jobs, or `npm run run`.
5. **Record what happened** — `npm run stats`, and the newest
   `runs/<stamp>-run.json`.

### Acceptance

- `config/profile.yaml` has a real name and `total_years > 0`
- `npm run boards` shows ≥ 20 active boards
- the run's JSON reports `evaluated ≥ 500`, `scored ≥ 20`
- at least one match scores ≥ 65
- one posting labelled applied, so the funnel is not empty

### Cost

Discovery is free (search quota aside). The first scoring run writes ~20-60
model calls — cents. Expect 3-5 minutes of wall clock.

### Failure modes

| Symptom | Cause |
|---|---|
| `scoring is off` | no key in `.env` |
| `the tenant directory is empty` | discovery never ran |
| `web discovery needs a search provider` | no Brave/CSE key — use `discover` per company |
| matches but all foreign | market is `us` while boards are Israeli |

---

## 2. CI that gates pull requests

One workflow, one job. The suite is offline and takes about eight seconds.

### File — `.github/workflows/test.yml`

```yaml
name: test

on:
  push:
    branches: [main]
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: npm
      - run: npm ci
      - run: npm test
```

`npm test` already runs `tsc --noEmit` before the suite, so one step covers both.

### Acceptance

- the workflow runs on a PR and reports success
- a deliberately broken type or failing test turns it red (verify once, then revert)
- branch protection on `main` requires the check

### Notes

- **No secrets are needed.** Tests never call a model or the network.
- **Node 24, not 26.** The floor in `package.json` is 24; CI should test the
  floor, not the machine this was written on.
- **`npm ci` not `npm install`**, so the lockfile is enforced.

---

## 3. The scheduler

Right now it is installed and pointed at an empty config: it will fire daily and
do nothing useful.

### Decide first

- **Uninstall** if this is still a development install:
  `npm run schedule -- uninstall`
- **Keep** only after step 1 passes, and preferably after a second consecutive
  successful manual run.

### If keeping

1. `npm run schedule -- status` → installed
2. `npm run schedule -- run` → triggers once, now
3. `tail -20 ~/Library/Logs/jobpilot.log` → expect a completed run
4. confirm tomorrow's log shows a second successful run

### Acceptance

- either `status` reports *not installed*,
- or two consecutive scheduled runs produce a digest and a `runs/*.json`

---

## 4. Screenshot in the README

The one item that needs a human at a browser.

### Steps

1. Start with the config from item 1 — an empty page proves nothing.
2. Open `http://127.0.0.1:7788`, set the minimum score so 3-5 matches show.
3. Capture at 1440×900, window only, no desktop, no personal data beyond what
   the fixture already contains. **Check the CV name and any company names you
   would not publish.**
4. Save as `docs/screenshot.png`, under 400 KB.
5. Reference it in the README, directly under the tagline:

```markdown
![JobPilot](docs/screenshot.png)
```

### Acceptance

- the image renders on GitHub
- nothing personal appears in it (file name, email, employer you would not name)
- it shows matches, not the empty state

---

## 5. Tag 0.1.0

Only after 1-4.

```bash
git tag -a v0.1.0 -m "JobPilot 0.1.0"
git push origin v0.1.0
gh release create v0.1.0 --title "0.1.0" --notes-file /tmp/notes.md
```

Tag push and release creation are remote state changes outside the branch-push
allowance — **ask before running either.**

### Release notes outline

- what it does, one paragraph
- requirements: Node 24+, one AI key
- what was verified for this release (tests, markets, sources)
- what is deliberately absent: no auto-apply, no LinkedIn, no board scraping
- known limits: Israel has no country-wide API; discovery needs a search key

### Acceptance

- `git tag` lists `v0.1.0` locally and on the remote
- the release page renders with notes and the README link
- `main` is green at the tag

---

## Order and effort

| # | Item | Blocked by | Effort |
|---|---|---|---|
| 1 | Rebuild config | a CV, and a search key or a company list | 30 min |
| 2 | CI | nothing | 20 min |
| 3 | Scheduler | 1 | 5 min |
| 4 | Screenshot | 1 | 15 min |
| 5 | Tag | 1-4 | 10 min |

Items 2 and 1 can run in parallel. 3 and 4 must follow 1. 5 last.

---

## Out of scope for 0.1.0

- Scraping the Israeli boards, or buying a feed for them
- A second field beyond Hi-Tech
- An application tracker in the UI
- Multi-user, accounts, cloud sync

Each is a decision to make after 0.1.0 ships, not a blocker for it.

---

## Definition of shipped

1. a stranger can clone, install, add a key, and get a shortlist
2. CI proves the claim on every PR
3. a scheduled run produces a digest unattended
4. the README shows the product, not just describes it
5. `v0.1.0` exists with notes
