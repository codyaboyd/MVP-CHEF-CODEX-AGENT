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

test('projects page manages command defaults and validates project health', async () => {
  const projectsResponse = await request(app).get('/projects');

  assert.equal(projectsResponse.status, 200);
  assert.match(projectsResponse.text, /Stock a new project/);
  assert.match(projectsResponse.text, /Project health/);
  assert.match(projectsResponse.text, /GitHub repo slug/);
  assert.match(projectsResponse.text, /npm test/);

  const invalidResponse = await request(app)
    .post('/projects')
    .type('form')
    .send({
      name: 'Invalid Project',
      repoPath: '/path/that/does/not/exist',
      githubRepoSlug: 'not-a-slug',
      defaultBranch: ''
    });

  assert.equal(invalidResponse.status, 400);
  assert.match(invalidResponse.text, /Local repo path must exist/);
  assert.match(invalidResponse.text, /GitHub repo slug must use owner\/repo format/);
  assert.match(invalidResponse.text, /Default branch is required/);

  const createResponse = await request(app)
    .post('/projects')
    .type('form')
    .send({
      name: 'Managed Project',
      repoPath: process.cwd(),
      githubRepoSlug: 'example/managed-project',
      defaultBranch: 'main',
      packageManagerCommand: 'npm ci',
      testCommand: 'npm test',
      buildCommand: 'npm run build',
      lintCommand: 'npm run lint',
      description: 'A managed project fixture.'
    });

  assert.equal(createResponse.status, 302);
  const project = db.prepare('SELECT * FROM projects WHERE github_repo_slug = ?').get('example/managed-project');
  assert.equal(project.default_branch, 'main');
  assert.equal(project.package_manager_command, 'npm ci');

  db.prepare('DELETE FROM projects WHERE id = ?').run(project.id);
});

test('CodexRunner mock mode saves redacted run step logs', async () => {
  const os = require('node:os');
  const fs = require('node:fs');
  const path = require('node:path');
  const codexRunner = require('../src/services/codexRunnerService');
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-runner-repo-'));
  fs.writeFileSync(path.join(repoPath, '.env'), 'OPENAI_API_KEY=sk-test-secret-value\n');
  const run = db.prepare('INSERT INTO runs (status, started_at) VALUES (?, CURRENT_TIMESTAMP)').run('queued');
  const step = db.prepare('INSERT INTO run_steps (run_id, step_order, status) VALUES (?, ?, ?)').run(run.lastInsertRowid, 1, 'queued');

  const result = await codexRunner.executeStep({
    runId: run.lastInsertRowid,
    runStepId: step.lastInsertRowid,
    repoPath,
    prompt: 'Use sk-test-secret-value safely.',
    mockMode: true
  });

  const savedStep = db.prepare('SELECT * FROM run_steps WHERE id = ?').get(step.lastInsertRowid);
  assert.equal(result.code, 0);
  assert.equal(result.mocked, true);
  assert.equal(savedStep.status, 'succeeded');
  assert.match(savedStep.stdout_log, /Mock Codex runner completed/);
  assert.doesNotMatch(`${savedStep.stdout_log}\n${savedStep.stderr_log || ''}`, /sk-test-secret-value/);

  db.prepare('DELETE FROM runs WHERE id = ?').run(run.lastInsertRowid);
  fs.rmSync(repoPath, { recursive: true, force: true });
});

test('CodexRunner spawns commands in repo path, streams logs, and captures exit code failures with retry', async () => {
  const os = require('node:os');
  const fs = require('node:fs');
  const path = require('node:path');
  const codexRunner = require('../src/services/codexRunnerService');
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-runner-retry-'));
  const run = db.prepare('INSERT INTO runs (status, started_at) VALUES (?, CURRENT_TIMESTAMP)').run('queued');
  const step = db.prepare('INSERT INTO run_steps (run_id, step_order, status) VALUES (?, ?, ?)').run(run.lastInsertRowid, 1, 'queued');

  await assert.rejects(() => codexRunner.executeStep({
    runId: run.lastInsertRowid,
    runStepId: step.lastInsertRowid,
    repoPath,
    prompt: 'hello from stdin',
    codexCommand: process.execPath,
    codexArgs: ['-e', 'process.stdin.resume(); process.stdin.on(\'data\', () => {}); console.error(process.cwd()); process.exit(7);'],
    retries: 1,
    mockMode: false
  }), /Codex exited with code 7/);

  const savedStep = db.prepare('SELECT * FROM run_steps WHERE id = ?').get(step.lastInsertRowid);
  assert.equal(savedStep.status, 'failed');
  assert.match(savedStep.stdout_log, /Attempt 1 of 2/);
  assert.match(savedStep.stdout_log, /Attempt 2 of 2/);
  assert.match(savedStep.stderr_log, new RegExp(repoPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(savedStep.error_message, /Codex exited with code 7/);

  db.prepare('DELETE FROM runs WHERE id = ?').run(run.lastInsertRowid);
  fs.rmSync(repoPath, { recursive: true, force: true });
});

test('CodexRunner can cancel an active spawned process', async () => {
  const os = require('node:os');
  const fs = require('node:fs');
  const path = require('node:path');
  const codexRunner = require('../src/services/codexRunnerService');
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-runner-cancel-'));
  const run = db.prepare('INSERT INTO runs (status, started_at) VALUES (?, CURRENT_TIMESTAMP)').run('queued');
  const step = db.prepare('INSERT INTO run_steps (run_id, step_order, status) VALUES (?, ?, ?)').run(run.lastInsertRowid, 1, 'queued');

  const execution = codexRunner.executeStep({
    runId: run.lastInsertRowid,
    runStepId: step.lastInsertRowid,
    repoPath,
    prompt: 'wait until cancelled',
    codexCommand: process.execPath,
    codexArgs: ['-e', 'process.stdin.resume(); setTimeout(() => {}, 30000);'],
    timeoutMs: 30000,
    mockMode: false
  });

  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(codexRunner.cancel(step.lastInsertRowid), true);
  const result = await execution;
  const savedStep = db.prepare('SELECT * FROM run_steps WHERE id = ?').get(step.lastInsertRowid);
  assert.equal(result.cancelled, true);
  assert.equal(savedStep.status, 'cancelled');

  db.prepare('DELETE FROM runs WHERE id = ?').run(run.lastInsertRowid);
  fs.rmSync(repoPath, { recursive: true, force: true });
});

test('RecipeRunEngine starts a recipe run, creates pending steps, and executes them in order', async () => {
  const engine = require('../src/services/recipeRunEngine');
  const project = db.prepare('SELECT id FROM projects ORDER BY id ASC LIMIT 1').get();
  const recipe = db.prepare(`
    INSERT INTO recipes (project_id, name, version, description)
    VALUES (?, ?, ?, ?)
  `).run(project.id, 'Engine Order Cake', '1.0.0', 'Exercise ordered engine runs.');
  db.prepare('INSERT INTO recipe_steps (recipe_id, step_order, title, prompt) VALUES (?, ?, ?, ?)')
    .run(recipe.lastInsertRowid, 1, 'First', 'Do first.');
  db.prepare('INSERT INTO recipe_steps (recipe_id, step_order, title, prompt) VALUES (?, ?, ?, ?)')
    .run(recipe.lastInsertRowid, 2, 'Second', 'Do second.');

  const run = await engine.startRunFromRecipe(recipe.lastInsertRowid, { mockMode: true });
  const savedRun = db.prepare('SELECT * FROM runs WHERE id = ?').get(run.id);
  const steps = db.prepare('SELECT * FROM run_steps WHERE run_id = ? ORDER BY step_order').all(run.id);

  assert.equal(savedRun.status, 'succeeded');
  assert.deepEqual(steps.map((step) => step.step_order), [1, 2]);
  assert.deepEqual(steps.map((step) => step.status), ['succeeded', 'succeeded']);
  assert.match(steps[0].stdout_log, /Mock Codex runner completed/);

  db.prepare('DELETE FROM recipes WHERE id = ?').run(recipe.lastInsertRowid);
});

test('RecipeRunEngine stops on failure and resumes from the failed step', async () => {
  const engine = require('../src/services/recipeRunEngine');
  const project = db.prepare('SELECT id FROM projects ORDER BY id ASC LIMIT 1').get();
  const recipe = db.prepare('INSERT INTO recipes (project_id, name, version, description) VALUES (?, ?, ?, ?)')
    .run(project.id, 'Resume Cake', '1.0.0', 'Exercise resume.');
  db.prepare('INSERT INTO recipe_steps (recipe_id, step_order, title, prompt) VALUES (?, ?, ?, ?)')
    .run(recipe.lastInsertRowid, 1, 'First', 'Do first.');
  db.prepare('INSERT INTO recipe_steps (recipe_id, step_order, title, prompt) VALUES (?, ?, ?, ?)')
    .run(recipe.lastInsertRowid, 2, 'Second', 'Do second.');

  const created = await engine.startRunFromRecipe(recipe.lastInsertRowid, { autoExecute: false });
  const failed = await engine.executeRun(created.id, {
    codexCommand: process.execPath,
    codexArgs: ['-e', 'process.exit(9);'],
    mockMode: false
  });
  assert.equal(failed.status, 'failed');
  let steps = db.prepare('SELECT * FROM run_steps WHERE run_id = ? ORDER BY step_order').all(created.id);
  assert.equal(steps[0].status, 'failed');
  assert.equal(steps[1].status, 'pending');

  const resumed = await engine.resumeRun(created.id, { mockMode: true });
  steps = db.prepare('SELECT * FROM run_steps WHERE run_id = ? ORDER BY step_order').all(created.id);
  assert.equal(resumed.status, 'succeeded');
  assert.deepEqual(steps.map((step) => step.status), ['succeeded', 'succeeded']);

  db.prepare('DELETE FROM recipes WHERE id = ?').run(recipe.lastInsertRowid);
});

test('RunStateManager prevents concurrent active runs for one project and cancels active runs', async () => {
  const engine = require('../src/services/recipeRunEngine');
  const state = require('../src/services/runStateManager');
  const project = db.prepare('SELECT id FROM projects ORDER BY id ASC LIMIT 1').get();
  const recipe = db.prepare('INSERT INTO recipes (project_id, name, version, description) VALUES (?, ?, ?, ?)')
    .run(project.id, 'Lock Cake', '1.0.0', 'Exercise locks.');
  db.prepare('INSERT INTO recipe_steps (recipe_id, step_order, title, prompt) VALUES (?, ?, ?, ?)')
    .run(recipe.lastInsertRowid, 1, 'Only', 'Do only.');

  const run = await engine.startRunFromRecipe(recipe.lastInsertRowid, { autoExecute: false });
  await assert.rejects(
    () => engine.startRunFromRecipe(recipe.lastInsertRowid, { autoExecute: false }),
    /already has active run/
  );

  const cancelled = state.cancelRun(run.id);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(db.prepare('SELECT status FROM run_steps WHERE run_id = ?').get(run.id).status, 'cancelled');

  db.prepare('DELETE FROM recipes WHERE id = ?').run(recipe.lastInsertRowid);
});
