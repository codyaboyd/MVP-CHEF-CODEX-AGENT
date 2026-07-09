# MVP Chef Codex

MVP Chef Codex is a playful digital recipe book for repeatable Codex prompt workflows. It is built for Linux/Ubuntu-friendly Node.js 20+ environments with Express, EJS templates, Bootstrap 5, SQLite, and dotenv configuration.

## Features

- Cartoonish recipe book theme with Bootstrap 5 styling.
- Clean MVC-ish structure: routes, controllers, services, views, public assets, and database module.
- SQLite persistence through `better-sqlite3` with automatic schema creation and starter recipe seeds.
- Add and view prompt recipes from the browser.
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

The app creates the configured SQLite database and `recipes` table on boot. If the table is empty, it seeds three starter prompt recipes so the cookbook is useful immediately.

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
