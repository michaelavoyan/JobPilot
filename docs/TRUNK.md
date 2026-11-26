# Trunk-based development

`main` is the trunk. There are no long-lived branches, no `develop`, and no
release branches. A change reaches users by being small enough to merge today,
not by being finished.

The model is Paul Hammant's [Trunk Based Development](https://trunkbaseddevelopment.com/).
This page maps it to JobPilot.

---

## The rules

| Rule | In this repository |
|---|---|
| One trunk | `main`, protected, required `test` check |
| Short-lived branches | one concern, one developer, merged within two days |
| Always releasable | a release is a `v*` tag on trunk; the workflow verifies it |
| Incomplete work ships dark | env/config flags, both paths tested |
| Long refactors | branch by abstraction, applied in trunk |
| Schema evolution | expand/contract, never a flag day |
| Red trunk | revert first, fix forward second |
| Small review units | one concern, ~400 lines excluding tests |

---

## A change, start to finish

```
1. main is green                       npm test locally, CI green on main
2. branch from main                    one concern, named for the outcome
3. build in small commits              the branch lives hours, not weeks
4. if it cannot ship complete          put it behind a flag
5. merge main into the branch          resolve drift before review
6. PR: what, why, what was verified    and what was not
7. green CI, merge, delete branch
8. release when it matters             tag on main; the workflow publishes
```

If step 3 is taking more than two days, the change is too large. Split it:
a refactor PR first, then a behaviour PR, then a cleanup PR — each able to go
live on its own.

---

## Feature flags

A flagged change is mergeable before it is complete. The flag is the contract:

```bash
DISCOVER_ON_RUN=1      # search before collect
SCORE_SAMPLES=2        # average repeated scores
AGENT_PAUSED=1         # stop the agent without uninstalling it
```

Requirements for a flag:

- default off for anything incomplete or costly
- both paths tested, not just the enabled one
- named for the behaviour, not the branch or the ticket
- removed — with its dead branch — when the feature is no longer optional

---

## Database changes: expand, contract

SQLite migrations here are hand-written and run on open. Trunk must start
against the database as it was one commit ago.

1. **Expand** — add a nullable column or a new table. Old code ignores it.
2. **Write both** — new code writes the new shape and can read both.
3. **Migrate** — backfill in a separate change, idempotently.
4. **Contract** — remove the old column or path only after nothing reads it.

Never rename or drop in the same change that starts using the new shape. A
release tag can be created at any commit; if an old database cannot start, trunk
is not releasable.

`config/backups/` holds seven snapshots taken before runs. That is recovery, not
a substitute for contract-safe migrations.

---

## Releases

- A release is a tag on trunk: `v0.5.0`.
- No release branch, no cherry-picks, no hotfix branch. A bug on a released
  version is fixed on trunk and released again.
- The `release` workflow refuses a tag that is not on `main`, does not match
  `package.json`, or has already been published.
- Notes: `docs/releases/v0.5.0.md`. They must state what was **not** verified.

---

## What not to do

- Do not keep a branch open because "it is almost done". Merge it behind a flag
  or split it.
- Do not merge one short-lived branch into another.
- Do not let two developers or two agents share a branch; that is a long-lived
  branch with extra steps.
- Do not fix a red trunk by pushing another change on top of it.
- Do not create a release branch to "stabilise". Stabilise on trunk; it is the
  only branch that exists.
- Do not bypass CI as routine. The bypass is for an incident, and the incident
  gets a revert and a note.

---

## For an agent working here

1. Confirm `main` is green; if not, stop and say so.
2. Branch from `main` for one concern.
3. Keep the change reversible and the database compatible.
4. If it cannot be finished today, flag it.
5. Run `npm test` before opening the PR.
6. Say what you verified, and what you did not.
