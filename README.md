# MVP Chef Codex

MVP Chef Codex is a playful digital recipe book for repeatable Codex prompt workflows. It is built for Linux/Ubuntu-friendly Node.js 20+ environments with Express, EJS templates, Bootstrap 5, SQLite, and dotenv configuration.

## Features

- Cartoonish recipe book theme with Bootstrap 5 styling.
- Clean MVC-ish structure: routes, controllers, services, views, public assets, and database module.
- SQLite persistence through `better-sqlite3` with automatic schema creation and starter recipe seeds.
- Add, import, export, duplicate, and run prompt recipes from the browser.
- Project management with absolute local git repository path validation and health checks.
- Recipe run state persisted in SQLite, including paused, cancelled, approval, quota, and failure-recovery states.
- Codex runner log redaction for configured secret-like environment values and `.env` values.
- Run cancellation that terminates the spawned Codex process group so child processes do not continue in the background.
- Development, production, test, and lint npm scripts.

## Requirements

- Node.js 20 or newer
- npm
- Linux/Ubuntu or another Node-compatible operating system

## Quick start

```bash
cp .env.example .env
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) to view the cookbook.

## Configuration

Environment variables are loaded with `dotenv`.

| Variable | Default | Description |
| --- | --- | --- |
| `NODE_ENV` | `development` | Runtime environment. |
| `PORT` | `3000` | HTTP server port. |
| `DATABASE_PATH` | `./data/mvp-chef-codex.sqlite` | SQLite database file path. |
| `APP_NAME` | `MVP Chef Codex` | Human-readable application name. |
| `CODEX_CLI_COMMAND` | `codex` | Codex CLI executable used by recipe runs. |
| `CODEX_RUN_TIMEOUT_MS` | `600000` | Maximum runtime for a Codex step before it is terminated. |
| `CODEX_RUNNER_MOCK` | unset | Set to `true` to use the local mock Codex runner. |

## Scripts

```bash
npm run dev    # Start with nodemon for local development
npm start      # Start the Express server
npm test       # Run Node's built-in test runner
npm run lint   # Run ESLint
```

## Project structure

```text
src/
  controllers/       Request handlers
  routes/            Express route declarations
  services/          Business/data access services
  views/             EJS templates and partials
  public/            CSS and browser JavaScript
  db.js              SQLite connection, schema, and seed data
  server.js          Express app setup and entry point
test/                Node test files
```

## Database

The app creates and migrates the configured SQLite database on boot. It persists projects, recipes, recipe steps, runs, run steps, quality-gate checks, recovery actions, project locks, and app settings. If no projects exist, it seeds a demo project and starter recipe templates so the cookbook is useful immediately.

Running steps are marked paused during server startup recovery so an app restart does not discard run history. Terminal run states are retained, and active project locks are released when runs finish or are cancelled.


## Operational hardening notes

- Project repository paths must be absolute paths to existing directories that contain a `.git` work tree. Relative paths, missing paths, files, and non-git directories are rejected before a project or runner step can use them.
- HTTP request logging skips URLs that appear to include secret-bearing query strings and redacts secret-like environment variable values before writing application errors.
- Codex runner stdout/stderr and saved error messages redact secret-like values from the environment and from the target repo's `.env` file.
- Cancelling a run asks the active Codex process group to terminate, then marks active/pending run steps and the run as cancelled in SQLite.
- On restart, interrupted `running` runs and steps are preserved and moved to `paused` with a restart message so they can be inspected or resumed instead of disappearing.

## Ubuntu deployment

The repository includes helper scripts for deploying MVP Chef Codex as a systemd-managed service on Ubuntu. The default deployment installs the app into `/opt/mvp-chef-codex`, runs it as the user that invoked `sudo`, creates a production `.env` if one is missing, installs production npm packages, starts the service, and prints the local URL.

### One-command install

From a checked-out copy of this repository on the Ubuntu server, run:

```bash
sudo ./scripts/install-ubuntu.sh
```

The installer will:

- Install Ubuntu packages required to build and run the app, including Node.js 20.x when the current Node version is missing or too old.
- Create `/opt/mvp-chef-codex` and copy the application files there.
- Create `/opt/mvp-chef-codex/.env` from `.env.example` when no environment file exists.
- Create `data/` and `backups/` directories for SQLite data and backups.
- Run `npm ci --omit=dev` in the application directory.
- Create and enable a `mvp-chef-codex` systemd service.
- Start the service and print `http://localhost:3000` plus the server network URL when available.

You can override the defaults with environment variables:

```bash
sudo APP_NAME=mvp-chef-codex \
  SERVICE_NAME=mvp-chef-codex \
  APP_DIR=/opt/mvp-chef-codex \
  APP_USER=ubuntu \
  PORT=3000 \
  ./scripts/install-ubuntu.sh
```

### Systemd service only

If the app directory is already prepared, create or refresh only the systemd service:

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

### Back up the SQLite database

Create a timestamped SQLite backup in the app's `backups/` directory:

```bash
sudo APP_DIR=/opt/mvp-chef-codex ./scripts/backup-db.sh
```

The backup script reads `DATABASE_PATH` from the app `.env` file and supports overriding `BACKUP_DIR` when you want backups written elsewhere.

### Update an existing Ubuntu deployment

From a newer checkout of this repository, run:

```bash
sudo ./scripts/update.sh
```

The updater backs up the current SQLite database, syncs the new application files into `/opt/mvp-chef-codex` while preserving `.env`, `data/`, and `backups/`, reinstalls production npm packages, and restarts the systemd service.
