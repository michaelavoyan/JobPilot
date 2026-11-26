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
| `OPENCODE_API_KEY` | model scoring | local `.env`, `integration` workflow | **yes** |
| `ANTHROPIC_API_KEY` | alternative provider | local `.env` | no |
| `OPENAI_API_KEY` | alternative provider | local `.env` | no |
| `DEEPSEEK_API_KEY` | alternative provider | local `.env` | no |
| `SERPER_API_KEY` | search discovery | local `.env`, `integration` workflow | **yes** |
| `TELEGRAM_BOT_TOKEN` | optional digest push | local `.env` | no |
| `TELEGRAM_CHAT_ID` | optional digest target | local `.env` | no |
| `GITHUB_TOKEN` | publish a release | `release` workflow | built in, not stored |

**Not secrets, and not stored as such:** `LLM_MODEL`, `MIN_SCORE`,
`SCORE_SAMPLES`, `AGENT_*`, `JOBCONFIG_DIR`, paths, thresholds. These are
configuration. Putting them in secrets only hides them from the people who need
to read them.

---

## 3. Current state

- Repository secrets: **`SERPER_API_KEY`, `OPENCODE_API_KEY`**
- Repository variable: **`LLM_MODEL`** (configuration, readable)
- Workflow reading them: **`integration`**, manual only
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

## 5. The integration workflow

`.github/workflows/integration.yml` is the only consumer. It runs manually and
proves both external dependencies still answer:

1. one search query through Serper — the result count is printed
2. one tiny model call — the model name and output tokens are printed

Nothing is written to the repository; the job starts from a fresh checkout.

Run it with **Actions → integration → Run workflow**, or:

```bash
gh workflow run integration.yml
gh run watch
```

It costs one search query and a few tokens. Secrets are passed to a single step
each via `env`, never at job level, and the job cannot run on a pull request.

### Creation

```bash
gh secret set SERPER_API_KEY
gh secret set OPENCODE_API_KEY
```

`gh` prompts for the value; it is encrypted at rest by GitHub and cannot be read
back afterwards. Never commit a value, never put one in a workflow file.

### Injection pattern

The real workflow uses `workflow_dispatch`, a repository guard, per-step `env`,
and `contents: read`. Environment approval was considered and left off: the job
is manual and the only reader is the repository owner.

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

When a key is rotated, update **both** places: `gh secret set <NAME>` for the
workflow and the local `.env`. The workflow is the check that the new value is
valid.

### Open item

`SERPER_API_KEY` was pasted into a chat during setup. It is now also a
repository secret, which does not change the advice: treat the chat copy as
exposed and rotate at serper.dev when convenient.

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
