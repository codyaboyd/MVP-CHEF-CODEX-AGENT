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

test('health endpoint reports service readiness', async () => {
  const response = await request(app).get('/healthz');

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { status: 'ok', service: 'mvp-chef-codex' });
});

test('database initializes project, recipe, run, and settings schema', () => {
  const tables = db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
      AND name IN ('projects', 'recipes', 'recipe_steps', 'runs', 'run_steps', 'run_step_checks', 'run_recovery_actions', 'project_run_locks', 'app_settings')
    ORDER BY name
  `).all().map((row) => row.name);

  assert.deepEqual(tables, ['app_settings', 'project_run_locks', 'projects', 'recipe_steps', 'recipes', 'run_recovery_actions', 'run_step_checks', 'run_steps', 'runs']);
  assert.ok(db.prepare('SELECT COUNT(*) AS total FROM projects').get().total >= 1);
  assert.ok(db.prepare('SELECT COUNT(*) AS total FROM recipes').get().total >= 1);
  assert.ok(db.prepare('SELECT COUNT(*) AS total FROM recipe_steps').get().total >= 1);
});

test('missing recipes render a friendly 404 page', async () => {
  const response = await request(app).get('/recipes/999999');

  assert.equal(response.status, 404);
  assert.match(response.text, /slipped behind the stove/);
});

test('missing run details render the 404 page instead of a demo fallback', async () => {
  const response = await request(app).get('/runs/999999');

  assert.equal(response.status, 404);
  assert.match(response.text, /slipped behind the stove/);
});

test('project folder resolver expands selected folder names to server paths', async () => {
  const response = await request(app).get('/projects/resolve-folder').query({ name: 'MVP-CHEF-CODEX-AGENT' });

  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.path, process.cwd());
  assert.deepEqual(response.body.matches, [process.cwd()]);
});

test('recipe form accepts raw text blocks as prompt steps', async () => {
  const createResponse = await request(app)
    .post('/recipes')
    .type('form')
    .send({
      title: 'Raw Block Gumbo',
      phase: '1.0.0',
      summary: 'A recipe built from raw text blocks.',
      rawTextBlocks: 'First raw instruction.\n\n---\n\nSecond raw instruction.'
    });

  assert.equal(createResponse.status, 302);
  const recipeId = Number(createResponse.headers.location.split('/').pop());
  const steps = db.prepare('SELECT * FROM recipe_steps WHERE recipe_id = ? ORDER BY step_order').all(recipeId);
  assert.deepEqual(steps.map((step) => step.title), ['Text block 1', 'Text block 2']);
  assert.deepEqual(steps.map((step) => step.prompt), ['First raw instruction.', 'Second raw instruction.']);

  db.prepare('DELETE FROM recipes WHERE id = ?').run(recipeId);
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

test('settings page saves GitHub and Codex auth configuration', async () => {
  const settingsService = require('../src/services/appSettingsService');
  try {
    const response = await request(app)
      .post('/settings')
      .type('form')
      .send({
        codexCommandPath: '/usr/local/bin/codex',
        codexAuthMode: 'api_key',
        codexApiKey: 'sk-test-settings-key',
        codexConfigDir: '/srv/.codex',
        codexModel: 'gpt-test',
        codexApprovalPolicy: 'never',
        codexSandboxMode: 'danger-full-access',
        mockRunnerMode: 'false',
        defaultBranch: 'trunk',
        githubCliPath: '/usr/bin/gh',
        githubUsername: 'chef-user',
        githubDefaultOrg: 'chef-org',
        githubToken: 'ghp_test_settings_token',
        autoMergeEnabled: 'false',
        protectedMainMode: 'true',
        githubAutomationEnabled: 'false'
      });

    assert.equal(response.status, 302);
    const settings = db.prepare('SELECT key, value FROM app_settings WHERE key IN (?, ?, ?, ?, ?, ?, ?) ORDER BY key')
      .all('codexAuthMode', 'codexApiKey', 'codexModel', 'githubAutomationEnabled', 'githubCliPath', 'githubToken', 'githubUsername');
    assert.deepEqual(settings, [
      { key: 'codexApiKey', value: 'sk-test-settings-key' },
      { key: 'codexAuthMode', value: 'api_key' },
      { key: 'codexModel', value: 'gpt-test' },
      { key: 'githubAutomationEnabled', value: 'false' },
      { key: 'githubCliPath', value: '/usr/bin/gh' },
      { key: 'githubToken', value: 'ghp_test_settings_token' },
      { key: 'githubUsername', value: 'chef-user' }
    ]);

    const page = await request(app).get('/settings');
    assert.equal(page.status, 200);
    assert.match(page.text, /Codex \/ OpenAI API key/);
    assert.match(page.text, /GitHub token/);
    assert.match(page.text, /Setup validation/);
    assert.match(page.text, /••••••••/);
  } finally {
    settingsService.updateSettings(settingsService.DEFAULT_SETTINGS);
  }
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
  assert.match(invalidResponse.text, /Local project folder path must exist/);
  assert.match(invalidResponse.text, /GitHub repo slug must use owner\/repo format/);
  assert.match(invalidResponse.text, /Default branch is required/);

  const os = require('node:os');
  const fs = require('node:fs');
  const path = require('node:path');
  const localOnlyPath = fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-chef-local-project-'));
  const localOnlyResponse = await request(app)
    .post('/projects')
    .type('form')
    .send({
      name: 'Local Folder Project',
      repoPath: localOnlyPath,
      githubRepoSlug: '',
      defaultBranch: 'main'
    });

  assert.equal(localOnlyResponse.status, 302);
  const localOnly = db.prepare('SELECT * FROM projects WHERE repo_path = ?').get(localOnlyPath);
  assert.equal(localOnly.github_repo_slug, '');
  db.prepare('DELETE FROM projects WHERE id = ?').run(localOnly.id);
  fs.rmSync(localOnlyPath, { recursive: true, force: true });

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
  require('node:child_process').execFileSync('git', ['init'], { cwd: repoPath });
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
  require('node:child_process').execFileSync('git', ['init'], { cwd: repoPath });
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
  require('node:child_process').execFileSync('git', ['init'], { cwd: repoPath });
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
  const project = db.prepare(`
    INSERT INTO projects (name, repo_path, github_repo_slug, default_branch, lint_command, test_command, build_command)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('Quality Pass Project', process.cwd(), 'example/quality-pass', 'main', 'node -e "process.exit(0)"', 'node -e "process.exit(0)"', 'node -e "process.exit(0)"');
  const recipe = db.prepare(`
    INSERT INTO recipes (project_id, name, version, description)
    VALUES (?, ?, ?, ?)
  `).run(project.lastInsertRowid, 'Engine Order Cake', '1.0.0', 'Exercise ordered engine runs.');
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
  assert.equal(db.prepare('SELECT COUNT(*) AS total FROM run_step_checks WHERE run_id = ?').get(run.id).total, 6);

  db.prepare('DELETE FROM recipes WHERE id = ?').run(recipe.lastInsertRowid);
  db.prepare('DELETE FROM projects WHERE id = ?').run(project.lastInsertRowid);
});

test('RecipeRunEngine stops on failure and resumes from the failed step', async () => {
  const engine = require('../src/services/recipeRunEngine');
  const project = db.prepare(`
    INSERT INTO projects (name, repo_path, github_repo_slug, default_branch, lint_command, test_command, build_command)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('Resume Project', process.cwd(), 'example/resume-project', 'main', 'node -e "process.exit(0)"', 'node -e "process.exit(0)"', 'node -e "process.exit(0)"');
  const recipe = db.prepare('INSERT INTO recipes (project_id, name, version, description) VALUES (?, ?, ?, ?)')
    .run(project.lastInsertRowid, 'Resume Cake', '1.0.0', 'Exercise resume.');
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
  db.prepare('DELETE FROM projects WHERE id = ?').run(project.lastInsertRowid);
});

test('RecipeRunEngine fails required quality gates and allows manual override', async () => {
  const engine = require('../src/services/recipeRunEngine');
  const qualityGateService = require('../src/services/qualityGateService');
  const project = db.prepare(`
    INSERT INTO projects (name, repo_path, github_repo_slug, default_branch, lint_command, test_command, build_command)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('Quality Fail Project', process.cwd(), 'example/quality-fail', 'main', 'node -e "process.exit(0)"', 'node -e "process.exit(5)"', 'node -e "process.exit(0)"');
  const recipe = db.prepare('INSERT INTO recipes (project_id, name, version, description) VALUES (?, ?, ?, ?)')
    .run(project.lastInsertRowid, 'Gate Cake', '1.0.0', 'Exercise gates.');
  db.prepare('INSERT INTO recipe_steps (recipe_id, step_order, title, prompt, required_checks) VALUES (?, ?, ?, ?, ?)')
    .run(recipe.lastInsertRowid, 1, 'Only', 'Do only.', 'test');

  const created = await engine.startRunFromRecipe(recipe.lastInsertRowid, { autoExecute: false });
  const failed = await engine.executeRun(created.id, { mockMode: true });
  const step = db.prepare('SELECT * FROM run_steps WHERE run_id = ?').get(created.id);
  assert.equal(failed.status, 'failed');
  assert.equal(step.status, 'failed');
  assert.match(step.error_message, /Required quality gate failed: test/);
  assert.equal(db.prepare('SELECT status FROM run_step_checks WHERE run_step_id = ? AND check_name = ?').get(step.id, 'test').status, 'failed');

  qualityGateService.saveManualOverride(step.id, 'Reviewed and accepted.');
  const resumed = await engine.resumeRun(created.id, { mockMode: true });
  assert.equal(resumed.status, 'succeeded');
  assert.equal(db.prepare('SELECT quality_gate_override FROM run_steps WHERE id = ?').get(step.id).quality_gate_override, 1);

  db.prepare('DELETE FROM recipes WHERE id = ?').run(recipe.lastInsertRowid);
  db.prepare('DELETE FROM projects WHERE id = ?').run(project.lastInsertRowid);
});


test('Project run locks expire, clean up stale owners, and guard git operations', () => {
  db.prepare('DELETE FROM project_run_locks').run();
  const state = require('../src/services/runStateManager');
  const project = db.prepare('SELECT id FROM projects ORDER BY id ASC LIMIT 1').get();
  const runA = db.prepare('INSERT INTO runs (project_id, status, created_at, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)').run(project.id, 'failed');
  const runB = db.prepare('INSERT INTO runs (project_id, status, created_at, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)').run(project.id, 'failed');

  state.acquireProjectLock(project.id, runA.lastInsertRowid, { owner: 'test-owner-a', ttlMs: 60_000 });
  assert.match(db.prepare('SELECT lock_owner FROM (SELECT l.owner AS lock_owner FROM project_run_locks l WHERE l.project_id = ?)').get(project.id).lock_owner, /test-owner-a/);
  assert.throws(
    () => state.acquireProjectLock(project.id, runB.lastInsertRowid, { owner: 'test-owner-b', ttlMs: 60_000 }),
    /locked by run/
  );
  assert.throws(
    () => state.assertRunOwnsProjectLock(project.id, runB.lastInsertRowid),
    /git operations are blocked/
  );

  db.prepare('UPDATE project_run_locks SET expires_at = ? WHERE project_id = ?').run(new Date(Date.now() - 1000).toISOString(), project.id);
  assert.equal(state.cleanupStaleLocks(), 1);
  state.acquireProjectLock(project.id, runB.lastInsertRowid, { owner: 'test-owner-b', ttlMs: 60_000 });
  assert.equal(state.getProjectLock(project.id).run_id, runB.lastInsertRowid);

  state.releaseProjectLock(project.id, runB.lastInsertRowid);
  db.prepare('DELETE FROM runs WHERE id IN (?, ?)').run(runA.lastInsertRowid, runB.lastInsertRowid);
});

test('RunStateManager prevents concurrent active runs for one project and cancels active runs', async () => {
  db.prepare('DELETE FROM project_run_locks').run();
  const engine = require('../src/services/recipeRunEngine');
  const state = require('../src/services/runStateManager');
  const project = db.prepare(`
    INSERT INTO projects (name, repo_path, github_repo_slug, default_branch, lint_command, test_command, build_command)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('Lock Project', process.cwd(), 'example/lock-project', 'main', 'node -e \"process.exit(0)\"', 'node -e \"process.exit(0)\"', 'node -e \"process.exit(0)\"');
  const recipe = db.prepare('INSERT INTO recipes (project_id, name, version, description) VALUES (?, ?, ?, ?)')
    .run(project.lastInsertRowid, 'Lock Cake', '1.0.0', 'Exercise locks.');
  db.prepare('INSERT INTO recipe_steps (recipe_id, step_order, title, prompt) VALUES (?, ?, ?, ?)')
    .run(recipe.lastInsertRowid, 1, 'Only', 'Do only.');

  const run = await engine.startRunFromRecipe(recipe.lastInsertRowid, { autoExecute: false });
  await assert.rejects(
    () => engine.startRunFromRecipe(recipe.lastInsertRowid, { autoExecute: false }),
    /already has active run|locked by run/
  );

  const cancelled = state.cancelRun(run.id);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(db.prepare('SELECT status FROM run_steps WHERE run_id = ?').get(run.id).status, 'cancelled');

  db.prepare('DELETE FROM recipes WHERE id = ?').run(recipe.lastInsertRowid);
  db.prepare('DELETE FROM projects WHERE id = ?').run(project.lastInsertRowid);
});

test('failure recovery tools persist actions and expose reports, logs, and retry controls', async () => {
  const engine = require('../src/services/recipeRunEngine');
  const project = db.prepare(`
    INSERT INTO projects (name, repo_path, github_repo_slug, default_branch, lint_command, test_command, build_command)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('Failure Recovery Project', process.cwd(), 'example/failure-recovery', 'main', 'node -e "process.exit(0)"', 'node -e "process.exit(0)"', 'node -e "process.exit(0)"');
  const recipe = db.prepare('INSERT INTO recipes (project_id, name, version, description) VALUES (?, ?, ?, ?)')
    .run(project.lastInsertRowid, 'Recovery Cake', '1.0.0', 'Exercise failure recovery tools.');
  db.prepare('INSERT INTO recipe_steps (recipe_id, step_order, title, prompt) VALUES (?, ?, ?, ?)')
    .run(recipe.lastInsertRowid, 1, 'Recover me', 'Original prompt.');

  const created = await engine.startRunFromRecipe(recipe.lastInsertRowid, { autoExecute: false });
  await engine.executeRun(created.id, {
    codexCommand: process.execPath,
    codexArgs: ['-e', 'console.error("boom"); process.exit(4);'],
    mockMode: false
  });
  const failedStep = db.prepare('SELECT * FROM run_steps WHERE run_id = ?').get(created.id);

  const detail = await request(app).get(`/runs/${created.id}`);
  assert.equal(detail.status, 200);
  assert.match(detail.text, /Failure recovery tools/);
  assert.match(detail.text, /Retry failed step/);
  assert.match(detail.text, /Edit failed prompt and retry/);
  assert.match(detail.text, /Continue from this step/);

  const logs = await request(app).get(`/runs/${created.id}/logs?stepId=${failedStep.id}`);
  assert.equal(logs.status, 200);
  assert.match(logs.text, /boom/);

  const retry = await request(app).post(`/runs/${created.id}/steps/${failedStep.id}/retry`);
  assert.equal(retry.status, 302);
  assert.equal(db.prepare('SELECT COUNT(*) AS total FROM run_recovery_actions WHERE run_id = ? AND action = ?').get(created.id, 'retry_failed_step').total, 1);

  const report = await request(app).get(`/runs/${created.id}/failure-report`);
  assert.equal(report.status, 200);
  assert.equal(report.type, 'application/json');
  assert.equal(report.body.run.id, created.id);
  assert.equal(report.body.recoveryActions[0].action, 'retry_failed_step');

  db.prepare('DELETE FROM recipes WHERE id = ?').run(recipe.lastInsertRowid);
  db.prepare('DELETE FROM projects WHERE id = ?').run(project.lastInsertRowid);
});

test('run events stream live run snapshots with progress, logs, and retries', async () => {
  const run = db.prepare('INSERT INTO runs (status, stdout_log, stderr_log, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)')
    .run('running', 'run stdout\n', 'run stderr\n');
  const step = db.prepare('INSERT INTO run_steps (run_id, step_order, status, stdout_log, stderr_log) VALUES (?, ?, ?, ?, ?)')
    .run(run.lastInsertRowid, 1, 'running', '[CodexRunner] Attempt 1 of 2.\nstep stdout\n', 'step stderr\n');

  const response = await request(app).get(`/runs/${run.lastInsertRowid}/events`).buffer(true).parse((res, callback) => {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => {
      body += chunk;
      res.destroy();
    });
    res.on('close', () => callback(null, body));
  });

  assert.equal(response.status, 200);
  const eventBody = response.body;
  assert.match(eventBody, /event: run-update/);
  assert.match(eventBody, /"progress":0/);
  assert.match(eventBody, /run stdout/);
  assert.match(eventBody, /step stderr/);
  assert.match(eventBody, /"retryAttempts":1/);

  db.prepare('DELETE FROM run_steps WHERE id = ?').run(step.lastInsertRowid);
  db.prepare('DELETE FROM runs WHERE id = ?').run(run.lastInsertRowid);
});


test('app settings include auto-merge safety controls', () => {
  const settings = require('../src/services/appSettingsService').getAutomationSettings();
  assert.equal(settings.autoMergeEnabled, true);
  assert.equal(settings.requireHumanApprovalBeforeMerge, false);
  assert.equal(settings.protectedMainMode, true);
  assert.equal(settings.githubAutomationEnabled, true);

  const keys = db.prepare(`
    SELECT key FROM app_settings
    WHERE key IN ('autoMergeEnabled', 'requireHumanApprovalBeforeMerge', 'protectedMainMode', 'githubAutomationEnabled')
    ORDER BY key
  `).all().map((row) => row.key);
  assert.deepEqual(keys, ['autoMergeEnabled', 'githubAutomationEnabled', 'protectedMainMode', 'requireHumanApprovalBeforeMerge']);
});

test('GitManager blocks PR automation when committed changes contain known secrets', async () => {
  const os = require('node:os');
  const fs = require('node:fs');
  const path = require('node:path');
  const { execFileSync } = require('node:child_process');
  const { GitManager } = require('../src/services/gitManagerService');
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'git-manager-secret-'));
  const git = (args) => execFileSync('git', args, { cwd: repoPath, encoding: 'utf8' }).trim();
  const previousToken = process.env.MVP_CHEF_TEST_TOKEN;

  process.env.MVP_CHEF_TEST_TOKEN = 'secret-value-for-detection';
  git(['init', '--initial-branch=main']);
  git(['config', 'user.email', 'chef@example.test']);
  git(['config', 'user.name', 'MVP Chef']);
  fs.writeFileSync(path.join(repoPath, 'README.md'), 'hello\n');
  git(['add', 'README.md']);
  git(['commit', '-m', 'initial']);
  fs.writeFileSync(path.join(repoPath, 'leak.txt'), 'secret-value-for-detection\n');
  git(['add', 'leak.txt']);
  git(['commit', '-m', 'leak']);

  const manager = new GitManager({ repoPath, mainBranch: 'main' });
  await assert.rejects(() => manager.assertNoSecretsInCommit(git(['rev-parse', 'HEAD'])), /Secret values were detected/);

  if (previousToken === undefined) {
    delete process.env.MVP_CHEF_TEST_TOKEN;
  } else {
    process.env.MVP_CHEF_TEST_TOKEN = previousToken;
  }
  fs.rmSync(repoPath, { recursive: true, force: true });
});

test('GitManager enforces a clean tree, branches, summarizes, commits, pushes, pulls, and rolls back', async () => {
  const os = require('node:os');
  const fs = require('node:fs');
  const path = require('node:path');
  const { execFileSync } = require('node:child_process');
  const { GitManager } = require('../src/services/gitManagerService');
  const originPath = fs.mkdtempSync(path.join(os.tmpdir(), 'git-manager-origin-'));
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'git-manager-repo-'));
  const git = (args, cwd = repoPath) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

  git(['init', '--bare', '--initial-branch=main'], originPath);
  git(['init', '--initial-branch=main']);
  git(['config', 'user.email', 'chef@example.test']);
  git(['config', 'user.name', 'MVP Chef']);
  git(['remote', 'add', 'origin', originPath]);
  fs.writeFileSync(path.join(repoPath, 'README.md'), 'hello\n');
  git(['add', 'README.md']);
  git(['commit', '-m', 'initial']);
  git(['push', '-u', 'origin', 'main']);

  const manager = new GitManager({ repoPath, mainBranch: 'main' });
  await manager.assertCleanWorkingTree();
  fs.writeFileSync(path.join(repoPath, 'dirty.txt'), 'dirty\n');
  await assert.rejects(() => manager.assertCleanWorkingTree(), /Working tree must be clean/);
  fs.rmSync(path.join(repoPath, 'dirty.txt'));

  const checkpoint = await manager.getCurrentSha();
  const branch = await manager.createBranchForStep({ runId: 42, stepId: 7, stepTitle: 'Build UI!' });
  assert.equal(branch, 'mvp-chef/run-42/step-7-build-ui');
  fs.writeFileSync(path.join(repoPath, 'feature.txt'), 'feature\n');

  const changedFiles = await manager.detectChangedFiles();
  assert.deepEqual(changedFiles, [{ status: '??', file: 'feature.txt' }]);
  assert.match(await manager.diffSummary(), /feature.txt/);

  const commit = await manager.commitStep({ runId: 42, stepId: 7, stepTitle: 'Build UI!' });
  assert.equal(commit.committed, true);
  assert.match(git(['log', '-1', '--pretty=%B']), /mvp-chef: Build UI!\n\nRun ID: 42\nStep ID: 7/);
  await manager.pushBranch(branch);

  await manager.rollbackToCheckpoint(checkpoint);
  assert.equal(git(['rev-parse', 'HEAD']), checkpoint);
  assert.equal(fs.existsSync(path.join(repoPath, 'feature.txt')), false);
  await manager.pullLatestMain();

  fs.rmSync(originPath, { recursive: true, force: true });
  fs.rmSync(repoPath, { recursive: true, force: true });
});

test('GitHubManager verifies gh, creates PRs, waits for checks, squash merges, and records merge SHA', async () => {
  const os = require('node:os');
  const fs = require('node:fs');
  const path = require('node:path');
  const { GitHubManager } = require('../src/services/githubManagerService');
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'github-manager-repo-'));
  const ghPath = path.join(repoPath, 'fake-gh.js');
  const callsPath = path.join(repoPath, 'calls.log');

  fs.writeFileSync(ghPath, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const callsPath = path.join(process.cwd(), 'calls.log');
const args = process.argv.slice(2);
fs.appendFileSync(callsPath, args.join(' ') + '\\n');
if (args[0] === '--version') {
  console.log('gh version 2.0.0');
  process.exit(0);
}
if (args[0] === 'auth' && args[1] === 'status') process.exit(0);
if (args[0] === 'pr' && args[1] === 'create') {
  console.log('https://github.com/example/repo/pull/12');
  process.exit(0);
}
if (args[0] === 'pr' && args[1] === 'checks') process.exit(0);
if (args[0] === 'pr' && args[1] === 'merge') process.exit(0);
if (args[0] === 'pr' && args[1] === 'view') {
  console.log(JSON.stringify({ mergeCommit: { oid: 'abc123merge' } }));
  process.exit(0);
}
console.error('unexpected gh args: ' + args.join(' '));
process.exit(1);
`);
  fs.chmodSync(ghPath, 0o755);

  const manager = new GitHubManager({ repoPath, mainBranch: 'main', ghCommand: process.execPath, checkPollIntervalMs: 1, checkTimeoutMs: 1000 });
  manager.ghCommand = process.execPath;
  manager.run = (args, options) => require('../src/services/githubManagerService').runGh(repoPath, [ghPath, ...args], { ...options, ghCommand: process.execPath });

  const verification = await manager.verifyCli();
  assert.equal(verification.authenticated, true);
  const result = await manager.createMergeAfterChecks({
    branchName: 'mvp-chef/run-1/step-2-test',
    title: 'Step PR',
    body: 'Body',
    squash: true
  });

  assert.deepEqual(result, { prUrl: 'https://github.com/example/repo/pull/12', mergeCommitSha: 'abc123merge' });
  const calls = fs.readFileSync(callsPath, 'utf8');
  assert.match(calls, /pr create --base main --head mvp-chef\/run-1\/step-2-test/);
  assert.match(calls, /pr checks https:\/\/github.com\/example\/repo\/pull\/12 --watch --fail-fast/);
  assert.match(calls, /pr merge https:\/\/github.com\/example\/repo\/pull\/12 --delete-branch --squash/);

  fs.rmSync(repoPath, { recursive: true, force: true });
});

test('GitHubManager fails gracefully when gh is missing', async () => {
  const os = require('node:os');
  const fs = require('node:fs');
  const path = require('node:path');
  const { GitHubManager } = require('../src/services/githubManagerService');
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'github-manager-missing-'));
  const manager = new GitHubManager({ repoPath, ghCommand: path.join(repoPath, 'missing-gh') });

  await assert.rejects(() => manager.verifyCli(), (error) => {
    assert.equal(error.code, 'GH_CLI_MISSING');
    assert.match(error.message, /GitHub CLI \(gh\) is not installed/);
    return true;
  });

  fs.rmSync(repoPath, { recursive: true, force: true });
});

test('CodexRunner detects quota text and marks a step waiting_for_quota without normal retries', async () => {
  const os = require('node:os');
  const fs = require('node:fs');
  const path = require('node:path');
  const codexRunner = require('../src/services/codexRunnerService');
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-runner-quota-'));
  require('node:child_process').execFileSync('git', ['init'], { cwd: repoPath });
  const run = db.prepare('INSERT INTO runs (status, started_at) VALUES (?, CURRENT_TIMESTAMP)').run('queued');
  const step = db.prepare('INSERT INTO run_steps (run_id, step_order, status) VALUES (?, ?, ?)').run(run.lastInsertRowid, 1, 'queued');

  await assert.rejects(() => codexRunner.executeStep({
    runId: run.lastInsertRowid,
    runStepId: step.lastInsertRowid,
    repoPath,
    prompt: 'hello from stdin',
    codexCommand: process.execPath,
    codexArgs: ['-e', 'console.error("Too many requests: usage limit exhausted; refill soon"); process.exit(1);'],
    retries: 3,
    mockMode: false
  }), (error) => error.code === 'QUOTA_LIMIT_DETECTED');

  const savedRun = db.prepare('SELECT * FROM runs WHERE id = ?').get(run.lastInsertRowid);
  const savedStep = db.prepare('SELECT * FROM run_steps WHERE id = ?').get(step.lastInsertRowid);
  assert.equal(savedRun.status, 'waiting_for_quota');
  assert.equal(savedStep.status, 'waiting_for_quota');
  assert.match(savedStep.stderr_log, /usage limit exhausted/);
  assert.doesNotMatch(savedStep.stdout_log, /Attempt 2 of 4/);

  db.prepare('DELETE FROM runs WHERE id = ?').run(run.lastInsertRowid);
  fs.rmSync(repoPath, { recursive: true, force: true });
});

test('RecipeRunEngine pauses on quota and does not start the next prompt until cooldown is cleared', async () => {
  const engine = require('../src/services/recipeRunEngine');
  const project = db.prepare(`
    INSERT INTO projects (name, repo_path, github_repo_slug, default_branch, lint_command, test_command, build_command)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('Quota Project', process.cwd(), 'example/quota-project', 'main', 'node -e "process.exit(0)"', 'node -e "process.exit(0)"', 'node -e "process.exit(0)"');
  const recipe = db.prepare('INSERT INTO recipes (project_id, name, version, description) VALUES (?, ?, ?, ?)')
    .run(project.lastInsertRowid, 'Quota Cake', '1.0.0', 'Exercise quota pause.');
  db.prepare('INSERT INTO recipe_steps (recipe_id, step_order, title, prompt) VALUES (?, ?, ?, ?)')
    .run(recipe.lastInsertRowid, 1, 'Quota', 'Hit quota.');
  db.prepare('INSERT INTO recipe_steps (recipe_id, step_order, title, prompt) VALUES (?, ?, ?, ?)')
    .run(recipe.lastInsertRowid, 2, 'Next', 'Must not start yet.');

  const created = await engine.startRunFromRecipe(recipe.lastInsertRowid, { autoExecute: false });
  const waiting = await engine.executeRun(created.id, {
    codexCommand: process.execPath,
    codexArgs: ['-e', 'console.error("rate limit exhausted until refill"); process.exit(1);'],
    mockMode: false,
    defaultCooldownMinutes: 5,
    autoResumeAfterCooldown: false
  });

  let steps = db.prepare('SELECT * FROM run_steps WHERE run_id = ? ORDER BY step_order').all(created.id);
  assert.equal(waiting.status, 'waiting_for_quota');
  assert.equal(steps[0].status, 'waiting_for_quota');
  assert.equal(steps[1].status, 'pending');
  assert.ok(waiting.quota_refill_at);

  const stillWaiting = await engine.resumeRun(created.id, { mockMode: true, autoResumeAfterCooldown: false });
  steps = db.prepare('SELECT * FROM run_steps WHERE run_id = ? ORDER BY step_order').all(created.id);
  assert.equal(stillWaiting.status, 'waiting_for_quota');
  assert.equal(steps[1].status, 'pending');

  db.prepare('UPDATE runs SET quota_refill_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), created.id);
  const resumed = await engine.resumeRun(created.id, { mockMode: true, autoResumeAfterCooldown: false });
  steps = db.prepare('SELECT * FROM run_steps WHERE run_id = ? ORDER BY step_order').all(created.id);
  assert.equal(resumed.status, 'succeeded');
  assert.deepEqual(steps.map((step) => step.status), ['succeeded', 'succeeded']);

  db.prepare('DELETE FROM recipes WHERE id = ?').run(recipe.lastInsertRowid);
  db.prepare('DELETE FROM projects WHERE id = ?').run(project.lastInsertRowid);
});

test('human approval modes pause before a step and expose approval actions', async () => {
  const engine = require('../src/services/recipeRunEngine');
  const project = db.prepare(`
    INSERT INTO projects (name, repo_path, github_repo_slug, default_branch, lint_command, test_command, build_command)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('Approval Project', process.cwd(), 'example/approval-project', 'main', 'node -e "process.exit(0)"', 'node -e "process.exit(0)"', 'node -e "process.exit(0)"');
  const recipe = db.prepare('INSERT INTO recipes (project_id, name, version, description, approval_mode) VALUES (?, ?, ?, ?, ?)')
    .run(project.lastInsertRowid, 'Approval Cake', '1.0.0', 'Exercise human approval.', 'before_step');
  db.prepare('INSERT INTO recipe_steps (recipe_id, step_order, title, prompt) VALUES (?, ?, ?, ?)')
    .run(recipe.lastInsertRowid, 1, 'Review me', 'Do reviewed work.');

  const created = await engine.startRunFromRecipe(recipe.lastInsertRowid, { autoExecute: false });
  const waiting = await engine.executeRun(created.id, { mockMode: true });
  let step = db.prepare('SELECT * FROM run_steps WHERE run_id = ?').get(created.id);
  assert.equal(waiting.status, 'waiting_for_approval');
  assert.equal(step.status, 'waiting_for_approval');
  assert.equal(step.approval_point, 'before_step');

  const detail = await request(app).get(`/runs/${created.id}`);
  assert.equal(detail.status, 200);
  assert.match(detail.text, /Approve/);
  assert.match(detail.text, /Reject/);
  assert.match(detail.text, /Edit prompt and retry/);
  assert.match(detail.text, /Skip step/);
  assert.match(detail.text, /Cancel run/);

  const resumed = await engine.resumeRun(created.id, { mockMode: true, approved: true, approvedPoint: 'before_step' });
  step = db.prepare('SELECT * FROM run_steps WHERE run_id = ?').get(created.id);
  assert.equal(resumed.status, 'succeeded');
  assert.equal(step.status, 'succeeded');

  db.prepare('DELETE FROM recipes WHERE id = ?').run(recipe.lastInsertRowid);
  db.prepare('DELETE FROM projects WHERE id = ?').run(project.lastInsertRowid);
});

test('GitManager scans changed files for secrets before committing and supports explicit settings override', async () => {
  const os = require('node:os');
  const fs = require('node:fs');
  const path = require('node:path');
  const { execFileSync } = require('node:child_process');
  const { GitManager } = require('../src/services/gitManagerService');
  const settingsService = require('../src/services/appSettingsService');
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'git-manager-secret-scan-'));
  const git = (args) => execFileSync('git', args, { cwd: repoPath, encoding: 'utf8' }).trim();

  settingsService.updateSettings({ secretScannerAllowOverride: 'false' });
  git(['init', '--initial-branch=main']);
  git(['config', 'user.email', 'chef@example.test']);
  git(['config', 'user.name', 'MVP Chef']);
  fs.writeFileSync(path.join(repoPath, 'README.md'), 'hello\n');
  git(['add', 'README.md']);
  git(['commit', '-m', 'initial']);

  const fakeToken = `ghp_${'123456789012345678901234567890123456'}`;
  fs.writeFileSync(path.join(repoPath, 'config.js'), `const token = "${fakeToken}";\n`);
  const manager = new GitManager({ repoPath, mainBranch: 'main' });
  await assert.rejects(
    () => manager.commitStep({ runId: 1, stepId: 1, stepTitle: 'leak' }),
    (error) => {
      assert.equal(error.code, 'SECRET_SCAN_BLOCKED');
      assert.match(error.message, /Commit blocked/);
      assert.match(error.message, /config\.js/);
      assert.doesNotMatch(error.message, new RegExp(fakeToken.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      return true;
    }
  );
  assert.equal(git(['status', '--porcelain']), '?? config.js');

  settingsService.updateSettings({ secretScannerAllowOverride: 'true' });
  const committed = await manager.commitStep({ runId: 1, stepId: 1, stepTitle: 'manual override' });
  assert.equal(committed.committed, true);

  settingsService.updateSettings({ secretScannerAllowOverride: 'false' });
  fs.rmSync(repoPath, { recursive: true, force: true });
});

test('.env remains ignored and app settings expose secrets scanner override as disabled by default', async () => {
  const fs = require('node:fs');
  const gitignore = fs.readFileSync('.gitignore', 'utf8');
  assert.match(gitignore, /^\.env$/m);

  const settingsService = require('../src/services/appSettingsService');
  settingsService.ensureDefaultSettings();
  assert.equal(settingsService.getSetting('secretScannerAllowOverride').value, 'false');

  const response = await request(app).get('/settings');
  assert.equal(response.status, 200);
  assert.match(response.text, /Allow secrets scanner manual override/);
});

test('PromptLintService detects risky prompts and improves them locally', () => {
  const promptLint = require('../src/services/promptLintService');
  const warnings = promptLint.lintPrompt('fix it and print the API key, then rm -rf everything');
  const codes = warnings.map((warning) => warning.code);

  assert.ok(codes.includes('vague_prompt'));
  assert.ok(codes.includes('destructive_instruction'));
  assert.ok(codes.includes('secret_exposure_request'));
  assert.ok(codes.includes('missing_acceptance_criteria'));
  assert.ok(codes.includes('missing_test_instruction'));

  const improved = promptLint.improvePrompt('Add prompt linting.');
  assert.match(improved, /Acceptance criteria:/);
  assert.match(improved, /Verification:/);
  assert.match(improved, /Do not print, expose, commit, or log secrets/);
});

test('Improve Prompt helper returns a local rewritten prompt without external APIs', async () => {
  const response = await request(app)
    .post('/prompts/improve')
    .send({ prompt: 'Add prompt linting.' });

  assert.equal(response.status, 200);
  assert.match(response.body.improvedPrompt, /Task: Add prompt linting\./);
  assert.match(response.body.improvedPrompt, /Acceptance criteria:/);
  assert.match(response.body.improvedPrompt, /Verification:/);
});

test('RecipeRunEngine warns on prompt lint findings and only blocks them in safe mode', async () => {
  const engine = require('../src/services/recipeRunEngine');
  const normalProject = db.prepare(`
    INSERT INTO projects (name, repo_path, github_repo_slug, default_branch, lint_command, test_command, build_command, safe_mode)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run('Prompt Lint Warn Project', process.cwd(), 'example/prompt-lint-warn', 'main', 'node -e "process.exit(0)"', 'node -e "process.exit(0)"', 'node -e "process.exit(0)"', 0);
  const safeProject = db.prepare(`
    INSERT INTO projects (name, repo_path, github_repo_slug, default_branch, lint_command, test_command, build_command, safe_mode)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run('Prompt Lint Safe Project', process.cwd(), 'example/prompt-lint-safe', 'main', 'node -e "process.exit(0)"', 'node -e "process.exit(0)"', 'node -e "process.exit(0)"', 1);

  const createRecipe = (projectId, name) => {
    const recipe = db.prepare('INSERT INTO recipes (project_id, name, version, description) VALUES (?, ?, ?, ?)')
      .run(projectId, name, '1.0.0', 'Exercise prompt linting.');
    db.prepare('INSERT INTO recipe_steps (recipe_id, step_order, title, prompt) VALUES (?, ?, ?, ?)')
      .run(recipe.lastInsertRowid, 1, 'Only', 'fix it');
    return recipe.lastInsertRowid;
  };

  const normalRecipeId = createRecipe(normalProject.lastInsertRowid, 'Prompt Lint Warning Cake');
  const normalRun = await engine.startRunFromRecipe(normalRecipeId, { mockMode: true });
  const normalStep = db.prepare('SELECT * FROM run_steps WHERE run_id = ?').get(normalRun.id);
  assert.equal(normalRun.status, 'succeeded');
  assert.match(normalStep.stdout_log, /\[PromptLint\] Warnings:/);

  const safeRecipeId = createRecipe(safeProject.lastInsertRowid, 'Prompt Lint Safe Cake');
  const safeRun = await engine.startRunFromRecipe(safeRecipeId, { mockMode: true });
  const safeStep = db.prepare('SELECT * FROM run_steps WHERE run_id = ?').get(safeRun.id);
  assert.equal(safeRun.status, 'failed');
  assert.equal(safeStep.status, 'failed');
  assert.match(safeStep.stdout_log, /Prompt may be too vague/);
  assert.match(safeRun.error_message, /Safe mode blocked/);

  db.prepare('DELETE FROM recipes WHERE id IN (?, ?)').run(normalRecipeId, safeRecipeId);
  db.prepare('DELETE FROM projects WHERE id IN (?, ?)').run(normalProject.lastInsertRowid, safeProject.lastInsertRowid);
});

test('database seeds built-in recipe templates with ordered Codex prompts', () => {
  const templateNames = [
    'Node.js SaaS MVP',
    'Bootstrap landing page',
    'REST API backend',
    'Auth system',
    'Stripe billing',
    'Admin dashboard',
    'CRUD app',
    'AI chatbot app',
    'Documentation cleanup',
    'Test hardening'
  ];

  const rows = db.prepare(`
    SELECT recipes.name, recipe_steps.step_order, recipe_steps.title, recipe_steps.prompt
    FROM recipes
    JOIN recipe_steps ON recipe_steps.recipe_id = recipes.id
    WHERE recipes.name IN (${templateNames.map(() => '?').join(',')})
    ORDER BY recipes.name ASC, recipe_steps.step_order ASC
  `).all(...templateNames);

  assert.equal(new Set(rows.map((row) => row.name)).size, templateNames.length);

  for (const name of templateNames) {
    const steps = rows.filter((row) => row.name === name);
    assert.equal(steps.length, 4, `${name} should include four ordered prompts`);
    assert.deepEqual(steps.map((step) => step.step_order), [1, 2, 3, 4]);
    assert.ok(steps.every((step) => step.title.length > 5));
    assert.ok(steps.every((step) => step.prompt.length > 80));
  }
});
