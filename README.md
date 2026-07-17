# MVP Chef Codex

MVP Chef Codex is a local, Ubuntu-friendly web app for turning repeatable Codex CLI workflows into versioned “recipes.” It lets you define multi-step prompts, attach them to local Git repositories, run those prompts through Codex, inspect logs, pause for human approval, recover from failures, rely on Codex to test its work, and optionally prepare GitHub pull-request automation through the GitHub CLI.

> **Project status:** MVP Chef Codex is an MVP-oriented developer tool. Treat every generated code change as untrusted until you review, test, and approve it.

## Table of contents

- [What MVP Chef Codex does](#what-mvp-chef-codex-does)
- [Features](#features)
- [Architecture](#architecture)
- [Requirements](#requirements)
- [Ubuntu install](#ubuntu-install)
- [Local development](#local-development)
- [Codex CLI setup](#codex-cli-setup)
- [GitHub CLI setup](#github-cli-setup)
- [Configuration](#configuration)
- [Recipe format](#recipe-format)
- [Running recipes safely](#running-recipes-safely)
- [Quota handling](#quota-handling)
- [Troubleshooting](#troubleshooting)
- [Roadmap](#roadmap)

## What MVP Chef Codex does

MVP Chef Codex is a recipe book for AI-assisted software work:

1. **Register projects** by pointing the app at absolute paths to local Git repositories.
2. **Create recipes** that describe repeatable Codex tasks as ordered prompt steps.
3. **Run recipes** from the browser against the selected project repository.
4. **Track each run** in SQLite, including step status, stdout/stderr, failures, retries, approvals, quota pauses, and cancellation.
5. **Review recovery options** such as retrying, editing a prompt before retry, skipping a step, or continuing from a step while preserving its context.
6. **Coordinate GitHub automation** through `gh` when repository settings and safety checks allow it.

Typical use cases include bootstrapping MVP features, applying recurring refactors, running repository hygiene tasks, producing review-ready PRs, and documenting proven prompting workflows for a team.

## Features

### Recipe management

- Create, edit, duplicate, delete, import, and export prompt recipes.
- Store recipe metadata: name, version, description, ingredients, project association, and approval mode.
- Model each recipe as ordered steps with title, prompt, retry count, human approval flag, and optional approval override.
- Import and export versioned JSON so recipes can be shared, reviewed, and committed.

### Project management

- Register local Git repositories with absolute path validation.
- Reject missing paths, relative paths, files, and non-Git directories before a runner can use them.
- Track project details such as optional repository slug, default branch, install/test/build commands, safe mode, and automation settings.
- Prevent overlapping runs through project run locks.

### Codex run orchestration

- Execute each recipe step through the configured Codex CLI command.
- Send prompt text to Codex through stdin instead of shell interpolation.
- Persist run and step state in SQLite.
- Capture stdout/stderr logs per step.
- Support cancellation by terminating the active Codex process group.
- Resume paused, failed, approval-blocked, or quota-blocked runs through UI actions.
- Fall back to mock runner mode when configured, which is useful for demos and tests.

### Review, approval, and recovery

- Approval modes include no approval, before step, after Codex, before commit, before merge, all checkpoints, and per-step manual approval.
- Failed steps can be retried, edited and retried, skipped, or used as a continuation point.
- Interrupted running steps are preserved on app restart and moved to a paused state for inspection.

### GitHub automation

- GitHub automation can be disabled in Settings with **Use GitHub automation** for local-only operation.
- When disabled, runs do not require `gh`, do not push branches, do not create pull requests, and do not merge through GitHub.
- When enabled, uses the GitHub CLI (`gh`) for authentication checks, PR creation, PR check monitoring, squash/merge actions, and branch cleanup.
- Supports protected-main style workflows where work happens on branches and merges only after checks and approvals.
- Includes secret-scanning safety controls before PR automation proceeds.

### Safety and hardening

- Redacts secret-like environment values and target-repository `.env` values from runner logs and saved error messages.
- Skips HTTP request logging for URLs that look like they contain tokens, keys, passwords, cookies, or sessions.
- Validates project paths before execution.
- Stores operational state in SQLite so run history is auditable.
- Provides safe-mode and human-approval controls for high-risk automation.

## Architecture

MVP Chef Codex is a server-rendered Node.js application:

```text
Browser
  |
  | HTTP forms, pages, run controls
  v
Express server (src/server.js)
  |
  +-- Routes (src/routes/)
  +-- Controllers (src/controllers/)
  +-- EJS views (src/views/)
  +-- Public assets (src/public/)
  |
  v
Services (src/services/)
  |
  +-- Recipe service: recipe CRUD, import/export, validation
  +-- Project service: repository metadata and validation
  +-- Run engine/state manager: run lifecycle and recovery
  +-- Codex runner: Codex CLI process execution and log capture
  +-- Git manager: local Git workflow helpers
  +-- GitHub manager: gh-based PR/check/merge automation
  +-- Quality gate, prompt lint, failure recovery, redaction, secret scanning
  |
  v
SQLite database (better-sqlite3)
  |
  +-- projects
  +-- recipes
  +-- recipe_steps
  +-- runs
  +-- run_steps
  +-- run_recovery_actions
  +-- project_run_locks
  +-- app_settings

External tools used by runs:
  +-- codex CLI
  +-- git
  +-- gh CLI
  +-- project-specific install/test/build commands
```

### Source layout

```text
src/
  controllers/       Request handlers
  routes/            Express route declarations
  services/          Business logic, runner orchestration, Git/GitHub helpers
  views/             EJS pages and partials
  public/            CSS and browser JavaScript
  db.js              SQLite connection, schema migrations, seed data
  server.js          Express app setup and entry point
scripts/             Ubuntu install, update, systemd, and backup helpers
test/                Node test files
```

## Requirements

- Ubuntu 22.04/24.04 or another Linux environment that can run Node.js 20+.
- Node.js 20 or newer.
- npm.
- Git.
- Codex CLI for real recipe execution.
- GitHub CLI (`gh`) for optional GitHub automation. Local-only runs do not require `gh`.
- A local Git repository for each project you want MVP Chef Codex to modify.

## Ubuntu install

The repository includes scripts for installing MVP Chef Codex as a systemd-managed service.

### One-command install

From a checked-out copy of this repository on the Ubuntu server:

```bash
sudo ./scripts/install-ubuntu.sh
```

The installer will:

- Install required Ubuntu packages and Node.js 20.x when needed.
- Copy the app into `/opt/mvp-chef-codex` by default.
- Create `/opt/mvp-chef-codex/.env` from `.env.example` if no environment file exists.
- Create `data/` and `backups/` directories.
- Install production npm dependencies with `npm ci --omit=dev`.
- Create, enable, and start the `mvp-chef-codex` systemd service.
- Print the local service URL.

Override defaults with environment variables:

```bash
sudo APP_NAME=mvp-chef-codex \
  SERVICE_NAME=mvp-chef-codex \
  APP_DIR=/opt/mvp-chef-codex \
  APP_USER=ubuntu \
  PORT=3000 \
  ./scripts/install-ubuntu.sh
```

### Service-only install

If `/opt/mvp-chef-codex` is already prepared:

```bash
sudo ./scripts/create-systemd-service.sh mvp-chef-codex /opt/mvp-chef-codex ubuntu
sudo systemctl daemon-reload
sudo systemctl enable --now mvp-chef-codex
```

Useful service commands:

```bash
sudo systemctl status mvp-chef-codex
sudo journalctl -u mvp-chef-codex -f
sudo systemctl restart mvp-chef-codex
```

### Backup and update

Create a timestamped SQLite backup:

```bash
sudo APP_DIR=/opt/mvp-chef-codex ./scripts/backup-db.sh
```

Update an existing deployment from a newer checkout:

```bash
sudo ./scripts/update.sh
```

The update script backs up the database, syncs application files while preserving `.env`, `data/`, and `backups/`, reinstalls production packages, and restarts the service.

## Local development

### 1. Clone and install

```bash
git clone <your-fork-or-repo-url> mvp-chef-codex
cd mvp-chef-codex
cp .env.example .env
npm install
```

### 2. Start the app

```bash
npm run dev
```

Open <http://localhost:3000>.

### 3. Run checks

```bash
npm test
npm run lint
npm run build
```

### 4. Useful development settings

For local UI testing without invoking the real Codex CLI, set mock runner mode in Settings or add this to `.env`:

```bash
CODEX_RUNNER_MOCK=true
```

The app creates the SQLite database automatically at `DATABASE_PATH` when it boots.

## Codex CLI setup

MVP Chef Codex shells out to the configured Codex executable for real recipe runs. The default command is `codex`.

1. Install the Codex CLI according to the official Codex/OpenAI instructions for your environment.
2. Authenticate the CLI as required by your Codex installation. For the standard browser-based ChatGPT/OpenAI sign-in flow, run:

   ```bash
   codex login
   ```

   If the environment cannot open a browser directly, use device authorization instead:

   ```bash
   codex login --device-auth
   ```

   Some automation environments may use an access token instead. Only do this in a trusted environment where the token is already provided securely:

   ```bash
   printenv CODEX_ACCESS_TOKEN | codex login --with-access-token
   ```

3. Confirm it is on the service user's `PATH`:

   ```bash
   which codex
   codex --version
   ```

4. In MVP Chef Codex, open **Settings** and set **Codex command path** to either `codex` or an absolute path such as `/usr/local/bin/codex`.
5. Decide whether to use mock mode:
   - `auto`: use real Codex when available, fall back to mock runner when the CLI is missing.
   - `true`: always use the mock runner.
   - `false`: require the real Codex CLI.

For systemd deployments, remember that the service user and interactive shell may have different `PATH` values. If Codex works in your terminal but not in the service, configure an absolute command path.

## GitHub CLI setup

GitHub setup is optional. To keep all code manipulation on the local machine, open Settings and disable **Use GitHub automation**. In that mode, MVP Chef Codex skips `gh` validation and does not push branches, create pull requests, or merge through GitHub.

GitHub automation uses `gh`, not direct GitHub API tokens in the app.

1. Install GitHub CLI:

   ```bash
   sudo apt-get update
   sudo apt-get install -y gh
   ```

   If your Ubuntu repositories do not include a recent `gh`, install it using GitHub's official package instructions.

2. Authenticate as the same user that runs MVP Chef Codex:

   ```bash
   gh auth login
   gh auth status
   ```

   During `gh auth login`, choose **GitHub.com** for normal GitHub repositories. Choose **HTTPS** unless your project remote uses SSH, and allow GitHub CLI to authenticate Git when prompted.

3. Confirm whether the target project uses HTTPS or SSH remotes:

   ```bash
   cd /absolute/path/to/project
   git remote -v
   ```

   If the remote starts with `https://github.com/`, GitHub CLI can usually manage Git credentials after `gh auth login`. If the remote starts with `git@github.com:`, make sure the service user has an SSH key added to GitHub.

4. Confirm the target project repository has a GitHub remote and that `gh` can see it:

   ```bash
   cd /absolute/path/to/project
   git remote -v
   gh repo view
   ```

5. In MVP Chef Codex, configure each project with an `owner/repo` GitHub slug and the correct default branch.

If using systemd, run `gh auth status` as the service user. Authentication stored for your personal login shell will not automatically apply to another Linux user.

## Configuration

The Settings page includes setup validation checks for Codex and GitHub readiness. Codex checks verify the configured command and look for an auth signal from environment credentials, an API key setting, or a Codex config directory. GitHub checks verify `gh --version` and `gh auth status` only when GitHub automation is enabled.

Environment variables are loaded with `dotenv`.

| Variable | Default | Description |
| --- | --- | --- |
| `NODE_ENV` | `development` | Runtime environment. |
| `PORT` | `3000` | HTTP server port. During Ubuntu setup, the installer automatically advances to the next open port if this one is occupied. |
| `DATABASE_PATH` | `./data/mvp-chef-codex.sqlite` | SQLite database path. |
| `APP_NAME` | `MVP Chef Codex` | Display name used by the app. |
| `PROJECT_BROWSER_ROOTS` | Documents, Desktop, Downloads, and `/workspace` | Path-delimited list of server folders that the project browser may scan. |
| `CODEX_CLI_COMMAND` | `codex` | Default Codex CLI executable used by recipe runs. |
| `CODEX_RUN_TIMEOUT_MS` | `600000` | Maximum runtime for one Codex step before termination. |
| `CODEX_RUNNER_MOCK` | unset | Set to `true` to force local mock runner mode. |

Runtime settings are also stored in the `app_settings` SQLite table and editable in the Settings page. Important settings include Codex command path, mock runner mode, default branch, max step runtime, auto-merge controls, quota cooldown, retry limits, safe mode, and secret-scanner override policy.

## Recipe format

Recipes can be imported and exported as JSON.

### Minimal valid recipe

```json
{
  "name": "Add health check endpoint",
  "version": "1.0.0",
  "description": "Create a small endpoint, tests, and documentation for service health checks.",
  "steps": [
    {
      "title": "Inspect existing server routes",
      "prompt": "Inspect the Express routes and identify the best place to add a /health endpoint. Do not edit files yet; summarize the plan.",
      "requiredChecks": [],
      "maxRetries": 0,
      "requiresApproval": true
    },
    {
      "title": "Implement health endpoint",
      "prompt": "Add a /health endpoint that returns JSON with ok=true. Add or update tests and documentation. Run the relevant checks.",
      "requiredChecks": ["npm test", "npm run lint"],
      "maxRetries": 1,
      "requiresApproval": false,
      "approvalOverride": "before_commit"
    }
  ]
}
```

### Full schema notes

| Field | Required | Type | Description |
| --- | --- | --- | --- |
| `name` | Yes | string | Human-readable recipe name. |
| `version` | Yes | string | Recipe version, usually semver-like. |
| `description` | Yes | string | Summary shown in the UI. |
| `ingredients` | No | string[] | Optional notes, prerequisites, files, commands, or context needed before running. |
| `approvalMode` | No | string | Recipe-level approval mode. Valid values: `manual_steps`, `none`, `before_step`, `after_codex`, `before_commit`, `before_merge`, `all`. |
| `steps` | Yes | array | Ordered list of Codex prompt steps. |
| `steps[].title` | Yes | string | Step label. |
| `steps[].prompt` | Yes | string | Prompt sent to Codex stdin. |
| `steps[].requiredChecks` | Yes | string[] | Commands or check names expected after the step. |
| `steps[].maxRetries` | Yes | integer | Non-negative retry count. |
| `steps[].requiresApproval` | Yes | boolean | Whether the step needs manual approval in manual-step mode. |
| `steps[].approvalOverride` | No | string | Per-step approval override: `inherit`, `none`, `before_step`, `after_codex`, `before_commit`, `before_merge`, or `all`. |

### Recipe design tips

- Keep each step focused and reviewable.
- Tell Codex exactly which files or areas it may edit.
- Use approval checkpoints before risky operations such as commits, merges, migrations, deletions, dependency upgrades, and production configuration changes.
- Prefer several small steps over one large prompt.

## Running recipes safely

MVP Chef Codex can modify local repositories through Codex and Git automation. Use the same caution you would use with any tool that can run commands and edit code.

- Run recipes only against repositories you are willing to change.
- Start from a clean Git working tree and a new branch.
- Review diffs after every run.
- Run tests manually before merging.
- Do not put secrets in prompts, recipe JSON, URLs, issue text, or comments.
- Keep `.env` files out of Git.
- Use mock runner mode when testing recipes themselves.
- Enable human approval before merge for shared or production repositories.
- Keep protected-main workflows enabled where possible.
- Back up the SQLite database before upgrades.
- Never assume AI-generated code is correct, secure, licensed appropriately, or production-ready without human review.

## Quota handling

Codex providers may return quota, usage-limit, rate-limit, refill, exhaustion, or “too many requests” messages. MVP Chef Codex detects those messages in Codex stdout/stderr and pauses the run instead of treating it like a normal step failure.

When quota is detected:

1. The current run and step move to `waiting_for_quota`.
2. The app stores quota retry metadata and an optional refill time.
3. Later steps stay pending and are not started.
4. Normal retry loops stop so the app does not burn more quota by repeatedly retrying immediately.
5. The run detail page shows quota status and controls for setting or overriding the refill time.
6. If auto-resume-after-cooldown is enabled, the run can continue after the configured cooldown; otherwise you can resume manually.

Relevant settings:

| Setting | Default | Meaning |
| --- | --- | --- |
| `defaultCooldownMinutes` | `60` | Cooldown applied when the app needs a quota refill estimate. |
| `autoResumeAfterCooldown` | `true` | Whether a quota-paused run may resume after cooldown. |
| `maxRetriesAfterQuota` | `3` | Maximum quota-resume attempts before requiring human intervention. |

Quota handling is intentionally conservative: the app pauses work, preserves context, and waits for an explicit cooldown/resume path rather than hammering the Codex CLI.

## Troubleshooting

### App will not start

- Confirm Node.js is version 20 or newer:

  ```bash
  node --version
  ```

- Reinstall dependencies:

  ```bash
  npm ci
  ```

- Check `.env` values, especially `DATABASE_PATH` and `PORT`.
- Confirm the database directory exists and is writable:

  ```bash
  mkdir -p data
  touch data/.write-test && rm data/.write-test
  ```

### Port 3000 is already in use

The Ubuntu installer now checks the requested setup port and automatically chooses the next open port within the next 100 ports when the requested value is busy. The selected port is written to the generated `.env` and shown in the final local and network URLs.

For manual development, change `PORT` in `.env` if your chosen port is occupied:

```bash
PORT=3001
```

Then restart the app.

### Codex CLI is missing or not found

- Check availability:

  ```bash
  which codex
  codex --version
  ```

- Use an absolute command path in Settings.
- For systemd, check the service user's PATH and logs:

  ```bash
  sudo systemctl status mvp-chef-codex
  sudo journalctl -u mvp-chef-codex -f
  ```

- Use mock runner mode while diagnosing CLI installation.

### GitHub automation fails

- Verify `gh` is installed and authenticated:

  ```bash
  gh --version
  gh auth status
  ```

- Confirm the project has a GitHub remote:

  ```bash
  git remote -v
  gh repo view
  ```

- Check that the project settings use `owner/repo` format.
- Run the checks that GitHub requires before retrying merge automation.

### Project path is rejected

MVP Chef Codex requires an absolute path to an existing Git work tree.

Valid example:

```text
/home/ubuntu/apps/my-project
```

Invalid examples:

```text
../my-project
/home/ubuntu/apps/not-a-git-repo
/home/ubuntu/apps/file.txt
```

### Runs pause after restart

This is expected. If the server restarts while steps are running, MVP Chef Codex preserves run history and marks interrupted work as paused so you can inspect logs and resume intentionally.

### Logs contain `[REDACTED:...]`

This is expected when output contains values that look like configured secrets. The redactor scans secret-like environment variable names and the target repository `.env` file, then masks matching values in runner logs.

### Quota state does not clear

- Wait until the quota refill time has passed.
- Set a new refill time on the run detail page.
- Confirm `autoResumeAfterCooldown` and `maxRetriesAfterQuota` settings.
- Resume manually if automatic resume is disabled.

### SQLite database problems

- Back up before manual repair:

  ```bash
  ./scripts/backup-db.sh
  ```

- Confirm `DATABASE_PATH` points to the expected file.
- Stop the service before moving or restoring the database.

## Roadmap

Planned and potential improvements:

- First-class screenshot capture and embedded README assets.
- Richer recipe schema with variables, secrets references, conditional steps, and reusable fragments.
- WebSocket or Server-Sent Events streaming for live run logs.
- Multi-user authentication and role-based approvals.
- Per-project policy templates for safe mode, branch naming, and merge strategy.
- Deeper Git diff review UI before approval checkpoints.
- Recipe marketplace or shared catalog export/import workflow.
- More granular quota-provider integrations when Codex exposes structured quota metadata.
- Optional containerized deployment profile.
- Expanded audit log and signed run artifacts.
- Better dashboard analytics for run success rate, average duration, quota pauses, and recovery actions.
- Additional integration tests around long-running Codex processes and GitHub automation edge cases.

## License

Apache-2.0. See [LICENSE](LICENSE).
