const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');
const app = require('../src/server');
const db = require('../src/db');
const trustService = require('../src/services/codexTrustService');
const planningService = require('../src/services/codexPlanningService');
const wizardService = require('../src/services/wizardService');
const recipeService = require('../src/services/recipeService');
const recipeRunEngine = require('../src/services/recipeRunEngine');
const runStateManager = require('../src/services/runStateManager');
const { validateChain } = require('../src/services/wizardChainValidator');

function fakePty(transcript, exitCode = null) {
  const writes = [];
  let dataHandler;
  let exitHandler;
  const terminal = {
    write(value) { writes.push(value); }, kill() { terminal.killed = true; },
    onData(handler) { dataHandler = handler; queueMicrotask(() => transcript.forEach((line) => dataHandler(line))); },
    onExit(handler) { exitHandler = handler; if (exitCode !== null) setTimeout(() => exitHandler({ exitCode }), 5); }
  };
  return { terminal, writes };
}

test('trust service strips ANSI and approves only a recognized trust dialog', async () => {
  assert.equal(trustService.stripAnsi('\u001b[31mTrust\u001b[0m'), 'Trust');
  const fake = fakePty(['\u001b[33mTrust this directory?\u001b[0m', 'OpenAI Codex · type /help']);
  const result = await trustService.establishTrust({ cwd: process.cwd(), spawnPty: () => fake.terminal, timeoutMs: 100 });
  assert.equal(result.trusted, true);
  assert.deepEqual(fake.writes, ['\r']);
  assert.equal(fake.terminal.killed, true);
});

test('trust service recognizes an already trusted workspace without typing', async () => {
  const fake = fakePty(['OpenAI Codex · type /help']);
  const result = await trustService.establishTrust({ cwd: process.cwd(), spawnPty: () => fake.terminal, timeoutMs: 100 });
  assert.equal(result.alreadyTrusted, true);
  assert.deepEqual(fake.writes, []);
});

test('trust service never approves arbitrary prompts and returns structured timeout/missing errors', async () => {
  const arbitrary = fakePty(['Delete all files?']);
  const unknown = await trustService.establishTrust({ cwd: process.cwd(), spawnPty: () => arbitrary.terminal, timeoutMs: 20 });
  assert.equal(unknown.trusted, false);
  assert.deepEqual(arbitrary.writes, []);
  assert.equal(unknown.code, 'TRUST_TIMEOUT');
  assert.equal(arbitrary.terminal.killed, true);
  const missing = await trustService.establishTrust({ cwd: process.cwd(), spawnPty: () => { const error = new Error('missing'); error.code = 'ENOENT'; throw error; } });
  assert.equal(missing.code, 'CODEX_NOT_FOUND');
});

test('planning executor uses read-only Codex args and captures then removes last-message output', async () => {
  let observed;
  function spawnProcess(command, args, options) {
    observed = { command, args, options };
    const child = new EventEmitter(); child.pid = 999999; child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough(); child.kill = () => {};
    process.nextTick(() => { fs.writeFileSync(args[args.indexOf('--output-last-message') + 1], 'final architecture'); child.emit('close', 0); });
    return child;
  }
  const result = await planningService.executePlanning({ sessionId: 987, cwd: process.cwd(), prompt: 'plan only', spawnProcess, timeoutMs: 1000 });
  assert.equal(result.answer, 'final architecture');
  assert.equal(observed.options.cwd, process.cwd());
  assert.equal(observed.options.shell, false);
  assert.ok(observed.args.includes('read-only'));
  assert.ok(observed.args.includes('never'));
  assert.equal(fs.existsSync(path.dirname(observed.args[observed.args.indexOf('--output-last-message') + 1])), false);
});

test('chain validator preserves ordering and rejects malformed, empty, and duplicate steps', () => {
  const valid = { name: 'Build', version: '1.0.0', description: 'Build it', steps: [1, 2, 3, 4, 5, 6, 7, 8].map((number) => ({ title: `Step ${number}`, prompt: `Inspect current files and implement slice ${number}.`, requiredChecks: [], maxRetries: 2 })) };
  assert.deepEqual(validateChain(valid).steps.map((step) => step.title), ['Step 1', 'Step 2', 'Step 3', 'Step 4', 'Step 5', 'Step 6', 'Step 7', 'Step 8']);
  assert.throws(() => validateChain('{bad json'));
  assert.throws(() => validateChain({ ...valid, steps: [{ title: 'Empty', prompt: '' }] }));
  assert.throws(() => validateChain({ ...valid, steps: [valid.steps[0], valid.steps[0], ...valid.steps.slice(2)] }), /duplicates/);
});

test('wizard persists the exact brief, artifacts, failure state, and prevents backwards transitions', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'wizard-state-'));
  const session = wizardService.create(folder);
  wizardService.update(session.id, { stage: 'describe', status: 'ready_for_description', original_brief: '  Exact brief\nwith spacing  ', architecture: 'Architecture' });
  wizardService.update(session.id, { stage: 'plan', status: 'failed', error: 'temporary failure' });
  const resumed = wizardService.get(session.id);
  assert.equal(resumed.original_brief, '  Exact brief\nwith spacing  ');
  assert.equal(resumed.architecture, 'Architecture');
  assert.equal(resumed.error, 'temporary failure');
  assert.throws(() => wizardService.update(session.id, { stage: 'workspace' }), /Invalid wizard transition/);
  db.prepare('DELETE FROM wizard_sessions WHERE id = ?').run(session.id);
  db.prepare('DELETE FROM projects WHERE id = ?').run(session.project_id);
  fs.rmSync(folder, { recursive: true, force: true });
});

test('wizard prompts contain the correct artifacts and the page exposes accessible workspace controls', async () => {
  const sample = { target_directory: '/tmp/product', original_brief: 'Build a secure app', architecture: 'Layered architecture', production_plan: 'Task 1 then Task 2' };
  assert.match(wizardService.architecturePrompt(sample), /DO NOT modify files/);
  assert.match(wizardService.architecturePrompt(sample), /\/tmp\/product/);
  assert.match(wizardService.planPrompt(sample), /Layered architecture/);
  assert.match(wizardService.chainPrompt(sample), /Build a secure app/);
  assert.match(wizardService.chainPrompt(sample), /Task 1 then Task 2/);
  const response = await request(app).get('/wizard');
  assert.equal(response.status, 200);
  assert.match(response.text, /Wizard Build/);
  assert.match(response.text, /Browse folders/);
  assert.match(response.text, /Create new/);
  assert.match(response.text, /aria-label="Wizard progress"/);
});

test('wizard performs one bounded chain repair and hands the recipe to the normal run engine', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'wizard-launch-'));
  const session = wizardService.create(folder);
  wizardService.update(session.id, { stage: 'describe', status: 'ready_for_description' });
  const chain = { name: 'Generated application build', version: '1.0.0', description: 'Production build', ingredients: ['Original specification'], steps: Array.from({ length: 8 }, (_, index) => ({ title: `Slice ${index + 1}`, prompt: `Inspect the repository and implement production slice ${index + 1}; add tests and fix failures.`, requiredChecks: ['npm test'], maxRetries: 2, requiresApproval: false })) };
  const answers = ['Architecture artifact', 'Production plan artifact', 'not json', JSON.stringify(chain)];
  let planningCalls = 0;
  let createdInput;
  let startedRecipeId;
  let resumedRunId;
  await wizardService.generate(session.id, '  Preserve this exact brief.  ', {
    planningService: { async executePlanning() { planningCalls += 1; return { answer: answers.shift() }; } },
    recipeService: { createRecipe(input) { createdInput = input; return recipeService.createRecipe(input); } },
    recipeRunEngine: {
      async startRunFromRecipe(recipeId, options) { startedRecipeId = recipeId; assert.equal(options.autoExecute, false); return recipeRunEngine.startRunFromRecipe(recipeId, options); },
      async resumeRun(runId) { resumedRunId = runId; }
    }
  });
  await new Promise((resolve) => setImmediate(resolve));
  const finished = wizardService.get(session.id);
  assert.equal(planningCalls, 4);
  assert.equal(finished.original_brief, '  Preserve this exact brief.  ');
  assert.equal(finished.architecture, 'Architecture artifact');
  assert.equal(finished.production_plan, 'Production plan artifact');
  assert.equal(createdInput.projectId, session.project_id);
  assert.equal(createdInput.steps.length, 8);
  assert.equal(startedRecipeId, finished.recipe_id);
  assert.equal(resumedRunId, finished.run_id);
  assert.equal(finished.status, 'build_running');
  runStateManager.releaseProjectLock(session.project_id, finished.run_id);
  db.prepare('DELETE FROM wizard_sessions WHERE id = ?').run(session.id);
  db.prepare('DELETE FROM runs WHERE id = ?').run(finished.run_id);
  db.prepare('DELETE FROM recipes WHERE id = ?').run(finished.recipe_id);
  db.prepare('DELETE FROM projects WHERE id = ?').run(session.project_id);
  fs.rmSync(folder, { recursive: true, force: true });
});
