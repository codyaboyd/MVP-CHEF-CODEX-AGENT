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
