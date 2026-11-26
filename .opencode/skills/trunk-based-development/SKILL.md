---
name: trunk-based-development
description: Work in this repository the trunk-based way — short-lived branches, one concern per change, flags instead of half-finished features, expand/contract database changes, and releases only as tags on main. Use before starting any change, when a task feels too large for a day, when a schema change is involved, or when deciding whether to branch, flag, revert or tag.
---

# Trunk-based development in JobPilot

`main` is the only long-lived branch. Every change is small enough to merge
today, or ships dark behind a flag.

## Before writing code

1. `git checkout main && git pull` — trunk must be green (`npm test`).
2. State the one concern. If you cannot, the change is two changes.
3. Branch from `main`; never from another feature branch.

## While building

- Keep the branch under two days. Past one day, split: refactor first, then
  behaviour.
- A refactor and a behaviour change never share a PR.
- Unfinished behaviour goes behind an env/config flag, default off, with both
  paths tested.
- Long refactors: add the seam in trunk, move callers, delete the old path.
  Branch by abstraction, not by branch.
- Database:
  1. expand (nullable column / new table)
  2. write both paths
  3. backfill idempotently
  4. contract in a later change
  A tag may be cut at any commit; the previous database must still start.

## Before merging

- Merge `main` into the branch to resolve drift.
- `npm test` — typecheck and the suite, offline.
- The PR states: what changed, why, what was verified, what was not.
- Roughly 400 changed lines or fewer, excluding tests and lockfiles.
- Delete the branch after merge.

## When trunk is red

Revert the change that broke it first. Fix forward in a new PR. Never stack
work on red, and never bypass the required check as a routine.

## Releasing

- A release is a tag on `main`: `v0.5.0`.
- `package.json` and the tag must match; the workflow checks.
- Write `docs/releases/v0.5.0.md` before tagging. State limits.
- No release branch, no hotfix branch. Fix on trunk, release again.

## Never

- merge one short-lived branch into another
- share a branch between two people or two agents
- keep a branch open because it is almost done
- create a `develop` or release branch
- drop or rename a column in the same change that starts using it
