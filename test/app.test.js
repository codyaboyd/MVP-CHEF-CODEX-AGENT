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

test('recipes can be imported from and exported to versioned JSON', async () => {
  const project = db.prepare('SELECT id FROM projects ORDER BY id ASC LIMIT 1').get();
  const importJson = {
    name: 'Import Export Stew',
    version: '1.0.0',
    description: 'A recipe for import and export testing.',
    steps: [
      {
        title: 'First simmer',
        prompt: 'Do the first step.',
        requiredChecks: ['npm test'],
        maxRetries: 1,
        requiresApproval: false
      },
      {
        title: 'Second garnish',
        prompt: 'Do the second step.',
        requiredChecks: ['npm run lint'],
        maxRetries: 2,
        requiresApproval: true
      }
    ]
  };

  const importResponse = await request(app)
    .post('/recipes/import')
    .type('form')
    .send({
      projectId: String(project.id),
      recipeJson: JSON.stringify(importJson)
    });

  assert.equal(importResponse.status, 302);
  const recipeId = Number(importResponse.headers.location.split('/').pop());
  const steps = db.prepare('SELECT * FROM recipe_steps WHERE recipe_id = ? ORDER BY step_order').all(recipeId);
  assert.equal(steps[0].title, 'First simmer');
  assert.equal(steps[1].title, 'Second garnish');

  const exportResponse = await request(app).get(`/recipes/${recipeId}/export`);
  assert.equal(exportResponse.status, 200);
  assert.equal(exportResponse.type, 'application/json');
  assert.match(exportResponse.headers['content-disposition'], /attachment/);
  assert.deepEqual(exportResponse.body, importJson);

  db.prepare('DELETE FROM recipes WHERE id = ?').run(recipeId);
});

test('recipe import rejects malformed and schema-invalid JSON with useful errors', async () => {
  const malformedResponse = await request(app)
    .post('/recipes/import')
    .type('form')
    .send({ recipeJson: '{not json' });

  assert.equal(malformedResponse.status, 400);
  assert.match(malformedResponse.text, /Recipe JSON is malformed/);

  const invalidResponse = await request(app)
    .post('/recipes/import')
    .type('form')
    .send({
      recipeJson: JSON.stringify({
        name: 'Bad Bake',
        version: '1.0.0',
        description: 'Missing step fields.',
        steps: [{ title: '', prompt: '', requiredChecks: 'npm test', maxRetries: -1, requiresApproval: 'no' }]
      })
    });

  assert.equal(invalidResponse.status, 400);
  assert.match(invalidResponse.text, /Step 1 title is required/);
  assert.match(invalidResponse.text, /Step 1 requiredChecks must be an array of strings/);
  assert.match(invalidResponse.text, /Step 1 maxRetries must be a non-negative integer/);
});
