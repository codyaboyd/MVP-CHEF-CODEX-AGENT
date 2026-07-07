const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const defaultDatabasePath = path.join(process.cwd(), 'data', 'mvp-chef-codex.sqlite');
const databasePath = process.env.DATABASE_PATH || defaultDatabasePath;

function ensureDatabaseDirectory(filePath) {
  const directory = path.dirname(filePath);
  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true });
  }
}

ensureDatabaseDirectory(databasePath);

const db = new Database(databasePath);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS recipes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    phase TEXT NOT NULL,
    summary TEXT NOT NULL,
    ingredients TEXT NOT NULL,
    instructions TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

const seedCount = db.prepare('SELECT COUNT(*) AS total FROM recipes').get().total;

if (seedCount === 0) {
  const insert = db.prepare(`
    INSERT INTO recipes (title, phase, summary, ingredients, instructions)
    VALUES (@title, @phase, @summary, @ingredients, @instructions)
  `);

  const seedRecipes = [
    {
      title: 'Product Brief Soufflé',
      phase: 'Discovery',
      summary: 'Turn a fuzzy product idea into a light, structured MVP brief.',
      ingredients: 'Target user\nCore problem\nPrimary journey\nMust-have features\nSuccess metrics',
      instructions: 'Ask up to five clarifying questions, then draft a concise product brief with clear boundaries.'
    },
    {
      title: 'Scope Cutter Sandwich',
      phase: 'Planning',
      summary: 'Trim a big product plan into the smallest useful MVP slice.',
      ingredients: 'Product brief\nTimebox\nAssumptions\nRisks\nMilestones',
      instructions: 'Separate features to keep from features to cut, then produce a practical milestone plan.'
    },
    {
      title: 'Launch Readiness Pie',
      phase: 'Launch',
      summary: 'Check whether the MVP is warm, stable, and ready to serve.',
      ingredients: 'Critical paths\nConfiguration\nError states\nSecurity basics\nSetup docs',
      instructions: 'Review launch blockers first, then list nice-to-have polish items for later.'
    }
  ];

  const seed = db.transaction((recipes) => {
    recipes.forEach((recipe) => insert.run(recipe));
  });

  seed(seedRecipes);
}

module.exports = db;
