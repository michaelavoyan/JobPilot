# Secrets management

How credentials are stored, injected, rotated, and kept away from forks.

The short version: **a secret exists only when a workflow consumes it, and no
workflow consumes one today.**

---

## 1. Principles

1. **No unused secrets.** A credential in repository settings that no job reads
   is exposure without benefit.
2. **Fork pull requests never see secrets.** Any job that uses one runs on
   `workflow_dispatch` or `main` only — never `pull_request`, never
   `pull_request_target`.
3. **Least privilege per job.** Workflows declare `permissions`; only `release`
   gets `contents: write`.
4. **Automation gets its own keys.** A CI key is separate from the one in a
   developer's `.env`, with its own budget, so one can be revoked without
   breaking the other.
5. **Revoke first, create second.** On exposure the old key dies immediately;
   a new one is issued afterwards.

---

## 2. Inventory

| Name | Purpose | Where it runs today | Repository secret? |
|---|---|---|---|
| `OPENCODE_API_KEY` | model scoring (this installation) | local `.env` | no |
| `ANTHROPIC_API_KEY` | alternative provider | local `.env` | no |
| `OPENAI_API_KEY` | alternative provider | local `.env` | no |
| `DEEPSEEK_API_KEY` | alternative provider | local `.env` | no |
| `SERPER_API_KEY` | search discovery | local `.env` | no |
| `TELEGRAM_BOT_TOKEN` | optional digest push | local `.env` | no |
| `TELEGRAM_CHAT_ID` | optional digest target | local `.env` | no |
| `GITHUB_TOKEN` | publish a release | `release` workflow | built in, not stored |

**Not secrets, and not stored as such:** `LLM_MODEL`, `MIN_SCORE`,
`SCORE_SAMPLES`, `AGENT_*`, `JOBCONFIG_DIR`, paths, thresholds. These are
configuration. Putting them in secrets only hides them from the people who need
to read them.

---

## 3. Current state

- Repository secrets: **none**
- Environments: **none**
- Workflows referencing `secrets.*`: **none**
- CI needs none: the suite is offline
- Release needs none: `GITHUB_TOKEN` is provided per job

Keys currently live only in `.env`, which is gitignored. `.env.example` carries
the names with empty values.

---

## 4. What GitHub Actions cannot do here

A scheduled workflow cannot replace the local agent:

- `config/jobs.db` is not persisted between runs; each run starts from a fresh
  checkout.
- Artifacts are not a database. Downloading and re-uploading the file every run
  is a worse, unbacked copy of what `config/backups/` already does locally.
- The product's value is a stateful directory, scores, labels and calibration.

So CD stays **release publishing**. A live integration check is possible; a
hosted agent is a different project.

---

## 5. When a secret does become necessary

Only for a `integration` workflow that runs one real discovery and one scored
pass, manually or nightly. It would need:

- `SERPER_API_KEY` — one or two queries
- one model key — one small batch

### Creation

```bash
gh secret set SERPER_API_KEY
gh secret set OPENCODE_API_KEY
```

`gh` prompts for the value; it is encrypted at rest by GitHub and cannot be read
back afterwards. Never commit a value, never put one in a workflow file.

### Injection pattern

```yaml
name: integration

on:
  workflow_dispatch:

permissions:
  contents: read

jobs:
  live:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    # Never on pull_request: a fork could read the keys.
    if: github.repository == 'michaelavoyan/JobPilot'
    environment: integration        # optional approval gate
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: 24
          cache: npm
      - run: npm ci
      - name: One real discovery query
        env:
          SERPER_API_KEY: ${{ secrets.SERPER_API_KEY }}
        run: npm run dump -- <careers-url>
```

Rules for the job:

- pass secrets through `env:` for one step, not job-wide
- no `set -x`, no `printenv`, no writing them to files or artifacts
- GitHub masks exact values in logs; do not transform them first
- keep the run small: a discovery query and one batch, not a full scan

---

## 6. Rotation

| Trigger | Action |
|---|---|
| suspected exposure | revoke at the provider, then rotate |
| scheduled | 90 days for provider keys; 180 for the bot token |
| an employee or agent leaves | rotate anything they could read |

Runbook:

1. Revoke the old key at the provider.
2. Create the new one with the same scope and a budget cap.
3. `gh secret set <NAME>`.
4. Update the local `.env`.
5. Run the consuming workflow with `workflow_dispatch`; verify one success.
6. Delete the old key from the provider's list.

### Open item

`SERPER_API_KEY` was pasted into a chat during setup. It is stored only in
`.env`, but the chat copy should be treated as exposed: revoke and rotate at
serper.dev when convenient.

---

## 7. Guardrails to enable once

These are repository settings, not code:

- **Secret scanning** and **push protection** — blocks a key before it lands.
- **Require approval for the `integration` environment**, if that workflow is
  added.
- **Renovate digest pinning** — already configured, so an action tag cannot
  change what runs.

---

## 8. What we will not do

- No long-lived cloud credentials. If a deployment appears, use OIDC.
- No secrets in `pull_request` jobs, even read-only ones.
- No secrets in the repository, an artifact, a release, or a log.
- No secret for configuration that a maintainer may need to read.
