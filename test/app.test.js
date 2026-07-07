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

test('recipe CRUD supports project association and step details', async () => {
  const project = db.prepare('SELECT id FROM projects ORDER BY id ASC LIMIT 1').get();

  const createResponse = await request(app)
    .post('/recipes')
    .type('form')
    .send({
      title: 'CRUD Tart',
      phase: '2.0.0',
      summary: 'A recipe for exercising CRUD routes.',
      ingredients: 'Repo\nTicket',
      projectId: String(project.id),
      stepTitles: ['Draft', 'Review'],
      stepPrompts: ['Draft the change.', 'Review the change.'],
      stepRequiredChecks: ['Tests pass', 'Approval recorded'],
      stepRetryCounts: ['1', '2'],
      stepHumanApprovals: ['0', '1']
    });

  assert.equal(createResponse.status, 302);
  const recipeId = Number(createResponse.headers.location.split('/').pop());
  let recipe = db.prepare('SELECT * FROM recipes WHERE id = ?').get(recipeId);
  assert.equal(recipe.project_id, project.id);

  let steps = db.prepare('SELECT * FROM recipe_steps WHERE recipe_id = ? ORDER BY step_order').all(recipeId);
  assert.equal(steps.length, 2);
  assert.equal(steps[0].required_checks, 'Tests pass');
  assert.equal(steps[1].retry_count, 2);
  assert.equal(steps[1].human_approval, 1);

  const updateResponse = await request(app)
    .post(`/recipes/${recipeId}`)
    .type('form')
    .send({
      title: 'CRUD Tart Updated',
      phase: '2.1.0',
      summary: 'Updated metadata and reordered steps.',
      ingredients: 'Repo',
      projectId: '',
      stepTitles: ['Review', 'Draft'],
      stepPrompts: ['Review the change.', 'Draft the change.'],
      stepRequiredChecks: ['Approval recorded', 'Tests pass'],
      stepRetryCounts: ['2', '1'],
      stepHumanApprovals: ['1', '0']
    });

  assert.equal(updateResponse.status, 302);
  recipe = db.prepare('SELECT * FROM recipes WHERE id = ?').get(recipeId);
  assert.equal(recipe.name, 'CRUD Tart Updated');
  assert.equal(recipe.project_id, null);
  steps = db.prepare('SELECT * FROM recipe_steps WHERE recipe_id = ? ORDER BY step_order').all(recipeId);
  assert.equal(steps[0].title, 'Review');

  const duplicateResponse = await request(app).post(`/recipes/${recipeId}/duplicate`);
  assert.equal(duplicateResponse.status, 302);
  const duplicateId = Number(duplicateResponse.headers.location.match(/\/recipes\/(\d+)\/edit/)[1]);
  assert.equal(db.prepare('SELECT COUNT(*) AS total FROM recipe_steps WHERE recipe_id = ?').get(duplicateId).total, 2);

  const deleteResponse = await request(app).post(`/recipes/${recipeId}/delete`);
  assert.equal(deleteResponse.status, 302);
  assert.equal(db.prepare('SELECT COUNT(*) AS total FROM recipes WHERE id = ?').get(recipeId).total, 0);

  db.prepare('DELETE FROM recipes WHERE id = ?').run(duplicateId);
});
