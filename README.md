# MVP Chef Codex

MVP Chef Codex is a local web application for turning repeatable Codex CLI work into reusable, versioned recipes. It connects recipes to project folders, runs ordered prompts, streams structured Codex output, records run history in SQLite, and provides approval and recovery controls.

> **Status:** This is an MVP developer tool. Review and test every generated change before relying on it.

## Capabilities

- Compose a quick one-off run from a folder and one or more prompts.
- Create, edit, duplicate, delete, import, and export recipes.
- Associate recipes with local folders, including folders that are not Git repositories.
- Detect common Node.js, Python, and Make project commands.
- Run Codex with `workspace-write`, `read-only`, or `danger-full-access` sandbox settings.
- Stream stdout and stderr to the run detail page with secret redaction.
- Pause, resume, cancel, retry, skip, edit-and-retry, or continue a run.
- Add approval checkpoints before a step, after Codex, or before a local commit.
- Pause on quota limits and optionally resume after a configured cooldown.
- Persist recipes, projects, settings, runs, recovery actions, and locks in SQLite.
- Optionally use local Git checkpoints and commits when a run enables Git behavior.

The run progress bar does not estimate the number of steps. Each structured Codex `item.completed` event advances it by three percentage points, capped at 99% while work is active; a successful run displays 100%.

## Requirements

- Node.js 20 or newer
- npm
- Codex CLI for real runs
- Git only for optional local checkpoint and commit behavior
- Linux for the included systemd deployment scripts

## Local development

```bash
cp .env.example .env
npm install
npm run dev
```

Open <http://localhost:3000>. The SQLite database is created automatically at `DATABASE_PATH`.

Run the project checks with:

```bash
npm test
npm run lint
npm run build
```

## Codex setup

The default executable is `codex`. Authenticate it as the same operating-system user that runs MVP Chef:

```bash
codex login
codex login status
```

The Settings page can select a command path, auth mode, model, approval policy, sandbox, timeout, quota cooldown, safe-mode default, and display preferences. A normal signed-in CLI does not need an API key stored in the app.

## Configuration

Copy `.env.example` to `.env`. Supported environment values are:

| Variable | Purpose | Default |
| --- | --- | --- |
| `PORT` | HTTP port | `3000` |
| `HOST` | Listen address | `127.0.0.1` |
| `DATABASE_PATH` | SQLite file | `data/mvp-chef-codex.sqlite` |
| `CODEX_CLI_COMMAND` | Codex executable | `codex` |
| `CODEX_RUN_TIMEOUT_MS` | Per-attempt timeout | `600000` |

Do not commit `.env` or place credentials in recipes. Logs redact values from secret-like environment variables and the target folder's `.env` file.

## Recipe format

Recipe imports use JSON shaped like this:

```json
{
  "name": "Small feature",
  "version": "1.0.0",
  "description": "Implement and verify one focused change.",
  "ingredients": ["Acceptance criteria", "Existing project"],
  "approvalMode": "manual_steps",
  "steps": [
    {
      "title": "Inspect and plan",
      "prompt": "Inspect the project and describe the smallest implementation plan. Do not edit files yet.",
      "requiredChecks": ["Plan names affected files and tests"],
      "maxRetries": 1,
      "requiresApproval": false,
      "approvalOverride": "inherit"
    },
    {
      "title": "Implement and verify",
      "prompt": "Implement the plan, run the relevant test, lint, and build commands, and report exact results.",
      "requiredChecks": ["npm test", "npm run lint", "npm run build"],
      "maxRetries": 2,
      "requiresApproval": true,
      "approvalOverride": "before_commit"
    }
  ]
}
```

Supported recipe approval modes are `manual_steps`, `none`, `before_step`, `after_codex`, `before_commit`, and `all`. Step overrides also accept `inherit`. `requiredChecks` documents verification that the Codex prompt must perform; MVP Chef does not run a second hidden quality-gate process.

The full example at `recipes/demo-node-saas-mvp.json` uses the same fields and approval points as the editor, importer, exporter, and run engine. Built-in templates cover SaaS foundations, landing pages, APIs, authentication, billing, admin dashboards, CRUD, chat, documentation, and test hardening.

## Run lifecycle and safety

1. The app validates the target folder and obtains a per-project run lock.
2. Each recipe step is sent to `codex exec --json` through stdin.
3. Structured output is stored and streamed to the browser.
4. Configured approval points pause execution for a human decision.
5. Failures retain logs and expose retry, prompt editing, skip, continuation, and rollback controls.
6. Terminal states release the project lock.

Use isolated projects for experimentation. Start with `workspace-write`, keep safe mode enabled for risky prompts, inspect diffs and logs, and back up important work before running automation.

## Ubuntu service installation

From a prepared checkout:

```bash
sudo ./scripts/install-ubuntu.sh
```

The installer copies the application to `/opt/mvp-chef-codex`, installs production dependencies, creates the environment and data directories, and enables a systemd service. Related operations:

```bash
sudo ./scripts/create-systemd-service.sh mvp-chef-codex /opt/mvp-chef-codex ubuntu
sudo APP_DIR=/opt/mvp-chef-codex ./scripts/backup-db.sh
sudo ./scripts/update.sh
sudo systemctl status mvp-chef-codex
sudo journalctl -u mvp-chef-codex -f
```

## Architecture

```text
Browser -> Express routes/controllers -> services -> SQLite
                                  |-> Codex CLI
                                  |-> optional local Git helpers
```

- `src/controllers/`: request handlers
- `src/routes/`: route declarations
- `src/services/`: recipes, projects, runner, state, recovery, validation, and safety
- `src/views/`: server-rendered EJS pages
- `src/public/`: browser JavaScript and CSS
- `src/db.js`: schema migrations and seed data
- `recipes/`: importable examples
- `scripts/`: install, update, service, and backup utilities
- `test/`: route and service regression coverage

## Troubleshooting

- **Codex is unavailable:** set the correct command path in Settings and run `codex login status` as the service user.
- **A run is locked:** open the active run and resume or cancel it; stale lock leases are cleaned automatically.
- **A run pauses for quota:** wait for the displayed refill time, set a new time, or resume after capacity returns.
- **A prompt is blocked:** safe mode rejects prompt-lint warnings. Rewrite destructive, vague, or secret-exposing instructions.
- **Logs contain redaction markers:** matching credential values were deliberately replaced before persistence.
- **A service update fails:** inspect `journalctl`, confirm `.env` ownership, and restore the newest file from `backups/` if necessary.
