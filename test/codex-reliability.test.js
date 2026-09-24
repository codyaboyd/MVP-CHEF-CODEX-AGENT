const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const db = require('../src/db');
const runner = require('../src/services/codexRunnerService');

const fakeCodex = path.join(__dirname, '..', 'scripts', 'fixtures', 'fake-codex.js');

function records() {
  const run = db.prepare('INSERT INTO runs (status, created_at, updated_at) VALUES (\'pending\', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)').run();
  const step = db.prepare('INSERT INTO run_steps (run_id, step_order, status, created_at, updated_at) VALUES (?, 1, \'pending\', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)').run(run.lastInsertRowid);
  return { runId: Number(run.lastInsertRowid), runStepId: Number(step.lastInsertRowid) };
}

test('Codex NDJSON captures a session ID and resume args continue that session', () => {
  const aggregator = runner.createNdjsonAggregator();
  aggregator.push(`${JSON.stringify({ type: 'thread.started', thread_id: 'thread-abc' })}\n`);
  aggregator.push(`${JSON.stringify({ type: 'turn.completed', usage: {} })}\n`);
  aggregator.finish();

  assert.equal(aggregator.result().progress.sessionId, 'thread-abc');
  const args = runner.buildCodexArgs('continue', [], 'test-model', 'high', '/tmp/project', 'thread-abc');
  assert.deepEqual(args.slice(-3), ['resume', 'thread-abc', '-']);
});

test('large NDJSON output is aggregated incrementally and memory/database tails are bounded', async () => {
  const ids = records();
  const old = { ...process.env };
  process.env.FAKE_CODEX_MODE = 'stream'; process.env.FAKE_CODEX_EVENTS = '12000';
  try {
    const result = await runner.executeStep({ ...ids, repoPath: os.tmpdir(), prompt: 'stream', codexCommand: process.execPath, codexArgs: [fakeCodex], stdoutTailBytes: 32 * 1024, stderrTailBytes: 4096, stepLogMaxBytes: 48 * 1024, logFlushBytes: 4096, logFlushIntervalMs: 20, maxProcessTreeRssMb: 0 });
    assert.equal(result.structuredOutput.progress.completedItems, 12000);
    assert.equal(result.structuredOutput.progress.turnCompleted, true);
    assert.deepEqual(result.structuredOutput.progress.usage, { input_tokens: 12000, output_tokens: 24000 });
    assert.ok(Buffer.byteLength(result.stdout) <= 32 * 1024);
    assert.equal('events' in result.structuredOutput, false);
    const saved = db.prepare('SELECT stdout_log, stderr_log FROM run_steps WHERE id=?').get(ids.runStepId);
    assert.ok(Buffer.byteLength(saved.stdout_log) <= 48 * 1024);
    assert.match(saved.stdout_log, /earlier log output truncated/);
  } finally { Object.keys(process.env).forEach((key) => { if (!(key in old)) delete process.env[key]; }); Object.assign(process.env, old); db.prepare('DELETE FROM runs WHERE id=?').run(ids.runId); }
});

test('Linux watchdog kills a growing isolated worker and clears bookkeeping', { skip: process.platform !== 'linux' }, async () => {
  const ids = records();
  process.env.FAKE_CODEX_MODE = 'memory';
  try {
    await assert.rejects(runner.executeStep({ ...ids, repoPath: os.tmpdir(), prompt: 'grow', codexCommand: process.execPath, codexArgs: [fakeCodex], maxProcessTreeRssMb: 35, memoryPollIntervalMs: 25, killGraceMs: 25, retries: 0 }), (error) => error.code === 'CODEX_MEMORY_LIMIT');
    assert.equal(runner._activeProcesses.size, 0);
    assert.match(db.prepare('SELECT stderr_log FROM run_steps WHERE id=?').get(ids.runStepId).stderr_log, /CODEX_MEMORY_LIMIT/);
  } finally { delete process.env.FAKE_CODEX_MODE; db.prepare('DELETE FROM runs WHERE id=?').run(ids.runId); }
});

test('cancellation terminates the worker process group including descendants', async () => {
  const ids = records();
  process.env.FAKE_CODEX_MODE = 'descendant';
  const execution = runner.executeStep({ ...ids, repoPath: os.tmpdir(), prompt: 'wait', codexCommand: process.execPath, codexArgs: [fakeCodex], killGraceMs: 30, maxProcessTreeRssMb: 0 });
  let log = '';
  for (let index = 0; index < 20 && !log.includes('descendant.started'); index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    log = db.prepare('SELECT stdout_log FROM run_steps WHERE id=?').get(ids.runStepId).stdout_log || '';
  }
  assert.equal(runner.cancel(ids.runStepId), true);
  const result = await execution;
  assert.equal(result.cancelled, true);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(runner._activeProcesses.size, 0);
  log = db.prepare('SELECT stdout_log FROM run_steps WHERE id=?').get(ids.runStepId).stdout_log;
  const descendantPid = Number(log.match(/"pid":(\d+)/)?.[1]);
  assert.ok(descendantPid);
  let descendantState = null;
  try { descendantState = fs.readFileSync(`/proc/${descendantPid}/stat`, 'utf8').slice(fs.readFileSync(`/proc/${descendantPid}/stat`, 'utf8').lastIndexOf(')') + 2).split(' ')[0]; } catch (error) { assert.equal(error.code, 'ENOENT'); }
  assert.ok(descendantState === null || descendantState === 'Z', `descendant remained runnable in state ${descendantState}`);
  delete process.env.FAKE_CODEX_MODE; db.prepare('DELETE FROM runs WHERE id=?').run(ids.runId);
});

test('retry starts a fresh worker after complete cleanup', async () => {
  const ids = records();
  const marker = path.join(os.tmpdir(), `mvp-chef-retry-${process.pid}-${Date.now()}`);
  process.env.FAKE_CODEX_MODE = 'retry'; process.env.FAKE_CODEX_MARKER = marker;
  try {
    const result = await runner.executeStep({ ...ids, repoPath: os.tmpdir(), prompt: 'retry', codexCommand: process.execPath, codexArgs: [fakeCodex], retries: 1, retryDelay: 0, maxProcessTreeRssMb: 0 });
    assert.equal(result.attempt, 2);
    assert.equal(result.structuredOutput.progress.turnCompleted, true);
    assert.notEqual(Number(fs.readFileSync(marker, 'utf8')), result.workerPid);
    assert.equal(runner._activeProcesses.size, 0);
  } finally {
    delete process.env.FAKE_CODEX_MODE; delete process.env.FAKE_CODEX_MARKER;
    fs.rmSync(marker, { force: true }); db.prepare('DELETE FROM runs WHERE id=?').run(ids.runId);
  }
});
