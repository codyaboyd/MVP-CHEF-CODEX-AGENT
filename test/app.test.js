const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const app = require('../src/server');
const db = require('../src/db');

test('home page renders seeded recipe book', async () => {
  const response = await request(app).get('/');

  assert.equal(response.status, 200);
  assert.match(response.text, /MVP Chef Codex/);
  assert.match(response.text, /Product Brief Soufflé/);
});

test('database initializes project, recipe, run, and settings schema', () => {
  const tables = db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
      AND name IN ('projects', 'recipes', 'recipe_steps', 'runs', 'run_steps', 'app_settings')
    ORDER BY name
  `).all().map((row) => row.name);

  assert.deepEqual(tables, ['app_settings', 'projects', 'recipe_steps', 'recipes', 'run_steps', 'runs']);
  assert.ok(db.prepare('SELECT COUNT(*) AS total FROM projects').get().total >= 1);
  assert.ok(db.prepare('SELECT COUNT(*) AS total FROM recipes').get().total >= 1);
  assert.ok(db.prepare('SELECT COUNT(*) AS total FROM recipe_steps').get().total >= 1);
});

test('missing recipes render a friendly 404 page', async () => {
  const response = await request(app).get('/recipes/999999');

  assert.equal(response.status, 404);
  assert.match(response.text, /slipped behind the stove/);
});
