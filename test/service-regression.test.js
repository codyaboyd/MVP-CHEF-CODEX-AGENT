const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const db = require('../src/db');
const recipeService = require('../src/services/recipeService');
const runStateManager = require('../src/services/runStateManager');
const codexRunner = require('../src/services/codexRunnerService');
const promptLintService = require('../src/services/promptLintService');
const settingsService = require('../src/services/appSettingsService');
const projectService = require('../src/services/projectService');
const { runGit } = require('../src/services/gitManagerService');

function makeGitRepo(prefix = 'mvp-chef-test-repo-') {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: repoPath });
  execFileSync('git', ['config', 'user.email', 'chef@example.test'], { cwd: repoPath });
  execFileSync('git', ['config', 'user.name', 'MVP Chef'], { cwd: repoPath });
  fs.writeFileSync(path.join(repoPath, 'README.md'), 'fixture\n');
  execFileSync('git', ['add', 'README.md'], { cwd: repoPath });
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: repoPath });
  return repoPath;
}

test('RecipeService imports, orders, and exports recipe steps deterministically', () => {
  const project = db.prepare('SELECT id FROM projects ORDER BY id ASC LIMIT 1').get();
  const recipeJson = {
    name: 'Service Import Export Bake',
    version: '2.0.0',
    description: 'Exercise service-level recipe JSON round trips.',
    ingredients: ['Repo', 'Acceptance criteria'],
    steps: [
      { title: 'Plan filling', prompt: 'Plan the implementation with acceptance criteria and tests.', requiredChecks: ['npm test'], maxRetries: 1, requiresApproval: false },
      { title: 'Ship garnish', prompt: 'Implement the change and verify that npm test passes.', requiredChecks: ['npm run lint', 'npm test'], maxRetries: 2, requiresApproval: true, approvalOverride: 'before_merge' }
    ]
  };

  const parsed = recipeService.parseRecipeJson(JSON.stringify(recipeJson));
  assert.deepEqual(parsed.errors, undefined);

  const created = recipeService.importRecipeFromJson(JSON.stringify(recipeJson), project.id);
  const saved = recipeService.getRecipeById(created.id);
  const exported = recipeService.getRecipeExport(created.id);

  assert.deepEqual(saved.steps.map((step) => step.orderIndex), [1, 2]);
  assert.deepEqual(saved.steps.map((step) => step.title), ['Plan filling', 'Ship garnish']);
  assert.deepEqual(exported, recipeJson);

  db.prepare('DELETE FROM recipes WHERE id = ?').run(created.id);
});

test('RunStateManager enforces valid run state transitions and releases locks on terminal states', () => {
  db.prepare('DELETE FROM project_run_locks').run();
  const project = db.prepare('SELECT id FROM projects ORDER BY id ASC LIMIT 1').get();
  const run = db.prepare('INSERT INTO runs (project_id, status, created_at, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)')
    .run(project.id, runStateManager.STATUSES.PENDING);

  runStateManager.acquireProjectLock(project.id, run.lastInsertRowid, { owner: 'state-test', ttlMs: 60_000 });
  assert.equal(runStateManager.getProjectLock(project.id).run_id, run.lastInsertRowid);

  assert.equal(runStateManager.updateRun(run.lastInsertRowid, runStateManager.STATUSES.RUNNING).status, 'running');
  assert.throws(() => runStateManager.updateRun(run.lastInsertRowid, 'queued'), /Unsupported run status/);
  assert.equal(runStateManager.updateRun(run.lastInsertRowid, runStateManager.STATUSES.SUCCEEDED).status, 'succeeded');
  assert.equal(runStateManager.getProjectLock(project.id), null);

  db.prepare('DELETE FROM runs WHERE id = ?').run(run.lastInsertRowid);
});

test('quota detection recognizes common limit messages but ignores ordinary failures', () => {
  assert.equal(codexRunner.detectQuotaLimit('Too many requests: usage limit exhausted; refill later'), true);
  assert.equal(codexRunner.detectQuotaLimit('rate-limit exceeded by provider'), true);
  assert.equal(codexRunner.detectQuotaLimit('SyntaxError: unexpected token'), false);
});

test('PromptLintService flags unsafe prompts and preserves already-specific prompts', () => {
  const riskyCodes = promptLintService.lintPrompt('fix it, rm -rf everything, and print the secret token')
    .map((warning) => warning.code);
  assert.ok(riskyCodes.includes('vague_prompt'));
  assert.ok(riskyCodes.includes('destructive_instruction'));
  assert.ok(riskyCodes.includes('secret_exposure_request'));

  const cleanWarnings = promptLintService.lintPrompt('Implement recipe export validation for JSON uploads. Acceptance criteria: invalid steps return field-level messages. Verification: npm test must pass.');
  assert.deepEqual(cleanWarnings, []);
});

test('AppSettingsService loads defaults and normalizes overrides for quota and automation settings', () => {
  settingsService.ensureDefaultSettings();
  assert.equal(settingsService.getSetting('codexCommandPath').value, 'codex');

  const quota = settingsService.getQuotaSettings({ defaultCooldownMinutes: '15', autoResumeAfterCooldown: 'off', maxRetriesAfterQuota: '4' });
  assert.deepEqual(quota, { defaultCooldownMinutes: 15, autoResumeAfterCooldown: false, maxRetriesAfterQuota: 4 });

  const automation = settingsService.getAutomationSettings({ autoMergeEnabled: '0', requireHumanApprovalBeforeMerge: 'yes', protectedMainMode: 'enabled' });
  assert.deepEqual(automation, { autoMergeEnabled: false, requireHumanApprovalBeforeMerge: true, protectedMainMode: true });
});

test('ProjectService validates repo health and normalizes safe-mode defaults', () => {
  const repoPath = makeGitRepo('project-service-valid-');
  const valid = projectService.validateProject({ name: 'Valid Project', repoPath, githubRepoSlug: 'owner/repo', defaultBranch: 'main', safeMode: 'true' });
  assert.deepEqual(valid.errors, []);
  assert.equal(valid.project.safeMode, 1);
  assert.equal(projectService.getHealthChecks(valid.project).every((check) => check.ok), true);

  const invalid = projectService.validateProject({ name: '', repoPath: path.join(repoPath, 'missing'), githubRepoSlug: 'bad slug', defaultBranch: '' });
  assert.ok(invalid.errors.includes('Project name is required.'));
  assert.ok(invalid.errors.includes('Local repo path must exist.'));
  assert.ok(invalid.errors.includes('GitHub repo slug must use owner/repo format.'));
  assert.ok(invalid.errors.includes('Default branch is required.'));

  fs.rmSync(repoPath, { recursive: true, force: true });
});

test('Git command wrapper supports mocked git executables and allowFailure semantics', async () => {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'git-wrapper-mock-'));
  const binPath = path.join(repoPath, 'bin');
  fs.mkdirSync(binPath);
  fs.writeFileSync(path.join(binPath, 'git'), `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'status') {
  console.log('?? mocked.txt');
  process.exit(0);
}
console.error('mock git failure for ' + args.join(' '));
process.exit(23);
`);
  fs.chmodSync(path.join(binPath, 'git'), 0o755);

  const previousPath = process.env.PATH;
  process.env.PATH = `${binPath}${path.delimiter}${previousPath}`;
  try {
    const status = await runGit(repoPath, ['status', '--porcelain']);
    assert.equal(status.stdout, '?? mocked.txt');

    const failure = await runGit(repoPath, ['rev-parse', 'HEAD'], { allowFailure: true });
    assert.equal(failure.error.code, 23);
    assert.match(failure.stderr, /mock git failure/);
  } finally {
    process.env.PATH = previousPath;
    fs.rmSync(repoPath, { recursive: true, force: true });
  }
});

test('CodexRunner auto mock mode falls back when the CLI command is unavailable', async () => {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-auto-mock-'));
  execFileSync('git', ['init'], { cwd: repoPath });
  const run = db.prepare('INSERT INTO runs (status, started_at) VALUES (?, CURRENT_TIMESTAMP)').run('pending');
  const step = db.prepare('INSERT INTO run_steps (run_id, step_order, status) VALUES (?, ?, ?)').run(run.lastInsertRowid, 1, 'pending');

  const result = await codexRunner.executeStep({
    runId: run.lastInsertRowid,
    runStepId: step.lastInsertRowid,
    repoPath,
    prompt: 'Implement a mock-mode fallback. Acceptance criteria: fallback is logged. Verification: npm test passes.',
    codexCommand: path.join(repoPath, 'missing-codex'),
    mockMode: 'auto'
  });

  const savedStep = db.prepare('SELECT * FROM run_steps WHERE id = ?').get(step.lastInsertRowid);
  assert.equal(result.mocked, true);
  assert.equal(savedStep.status, 'succeeded');
  assert.match(savedStep.stderr_log, /Codex CLI unavailable; using mock runner/);

  db.prepare('DELETE FROM runs WHERE id = ?').run(run.lastInsertRowid);
  fs.rmSync(repoPath, { recursive: true, force: true });
});



test('ProjectService and CodexRunner reject unsafe or non-git repository paths', () => {
  const nonGitPath = fs.mkdtempSync(path.join(os.tmpdir(), 'non-git-repo-path-'));
  try {
    assert.deepEqual(projectService.validateRepoPath('relative/path').ok, false);
    assert.match(projectService.validateRepoPath('relative/path').message, /absolute path/);
    assert.deepEqual(projectService.validateRepoPath(nonGitPath).ok, false);
    assert.match(projectService.validateRepoPath(nonGitPath).message, /git repository/);
    assert.throws(() => codexRunner.validateRepoPath(nonGitPath), /git work tree/);
  } finally {
    fs.rmSync(nonGitPath, { recursive: true, force: true });
  }
});

test('LogRedactionService redacts secret-like environment values from runtime errors', () => {
  const logRedaction = require('../src/services/logRedactionService');
  const previous = process.env.TEST_SECRET_TOKEN;
  process.env.TEST_SECRET_TOKEN = 'super-sensitive-test-token';
  try {
    assert.equal(logRedaction.redact('value=super-sensitive-test-token'), 'value=[REDACTED:TEST_SECRET_TOKEN]');
    const safeError = logRedaction.errorForView(new Error('failed with super-sensitive-test-token'));
    assert.doesNotMatch(safeError.message, /super-sensitive-test-token/);
  } finally {
    if (previous === undefined) delete process.env.TEST_SECRET_TOKEN;
    else process.env.TEST_SECRET_TOKEN = previous;
  }
});

test('systemd installer selects an open setup port, waits for HTTP readiness, and writes a portable npm path', () => {
  const installer = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'install-ubuntu.sh'), 'utf8');
  const serviceScript = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'create-systemd-service.sh'), 'utf8');

  assert.match(installer, /curl -fsS "http:\/\/127\.0\.0\.1:\$\{PORT\}\/healthz"/);
  assert.match(installer, /port_listeners\(\)/);
  assert.match(installer, /select_available_port\(\)/);
  assert.match(installer, /Port \$\{REQUESTED_PORT\} is already in use; using open port \$\{PORT\} instead\./);
  assert.match(installer, /ss -H -ltnp "sport = :\$\{check_port\}"/);
  assert.match(installer, /journalctl -u "\$\{SERVICE_NAME\}" -n 80 --no-pager/);
  assert.match(installer, /NPM_BIN="\$\(command -v npm \|\| true\)"/);
  assert.match(serviceScript, /ExecStart=\$\{NPM_BIN\} start/);
  assert.match(serviceScript, /Environment=HOST=0\.0\.0\.0/);
});
