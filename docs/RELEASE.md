# Releases

How a release is cut, and what each one contained. The process is short because
the repository is protected: nothing reaches `main` except through a pull
request.

---

## Cutting a release

1. **Bump the version** in `package.json` and `package-lock.json` (both the
   root `version` and `packages[""]`) on a branch, and open a PR. Version bump
   only — no code changes in that PR.
2. **Merge it.** `main` requires a green `test` check; the admin can bypass, but
   the release PR should be green.
3. **Tag from `main`:**

   ```bash
   git tag -a v0.2.1 -m "JobPilot 0.2.1"
   git push origin v0.2.1
   ```

4. **The `release` workflow does the rest.** Pushing a `v*` tag runs it, and it
   refuses to publish unless all four hold:

   - `npm test` passes
   - the tag equals `package.json`'s version
   - the tagged commit is an ancestor of `main`
   - no release with that tag exists yet

   Then it creates the GitHub release.

5. **Verify:** the run is green, the release page renders, and the notes name
   what was and was not verified.

### Release notes

Commit `docs/releases/v0.2.1.md` before tagging for curated notes. Without that
file the workflow uses GitHub's generated notes, which list merged PRs but say
nothing about limits — so the file is the default choice.

### What the notes must contain

- what changed, in the user's terms
- what was actually verified (tests, platforms, live runs)
- **what was not verified** — the Telegram path, discovery without a key, a
  fresh install
- known limits, stated plainly

A release note that only lists features is incomplete.

### Secrets

Neither CI nor the release workflow needs a repository secret. Tests are
offline, and publishing uses the built-in `GITHUB_TOKEN` with `contents: write`.

If a live integration workflow is added later, its keys belong in **repository
secrets** and it must run on `workflow_dispatch` or `main` only — never on
`pull_request`, where a fork could read them.

### Rules

- **Never move a published tag.** Fix forward with a new patch.
- **Semver by capability:** a new thing the agent can do is a minor release;
  fixes are a patch.
- **The version in `package.json` must match the tag.** A tarball that claims
  to be a different version is a bug.

---

## History

| Tag | Date | What it was |
|---|---|---|
| `v0.1.0` | 2026-11-21 | first complete release: CV → filter → score → digest, 32 boards, CI, screenshot |
| `v0.1.1` | 2026-11-21 | cross-site refusal, per-batch learned provenance, eval sample gate, stage semantics, silent-failure fixes |
| `v0.2.0` | 2026-11-24 | keyless discovery, in-run discovery, sample averaging, decision log, shadow rotation, scheduler and digest fixes |

Each release page carries the full notes:
<https://github.com/michaelavoyan/JobPilot/releases>

---

## Before a release

```bash
npm test             # typecheck + 403 tests
npm run health       # scheduler, last run, backups, directory
npm run screenshot   # refresh the README image from the real UI
```

Then read the digest the product actually produced, not the one you expected.
The last release was delayed by a defect that was only visible in that output.
