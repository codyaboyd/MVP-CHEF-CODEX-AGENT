#!/usr/bin/env node
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-chef-soak-'));
process.env.DATABASE_PATH = path.join(work, 'soak.sqlite');
process.env.FAKE_CODEX_MODE = 'stream';
process.env.FAKE_CODEX_EVENTS = process.env.SOAK_EVENTS_PER_STEP || '1500';
const db = require('../src/db');
const runner = require('../src/services/codexRunnerService');
const fake = path.join(__dirname, 'fixtures', 'fake-codex.js');
const total = Number(process.env.SOAK_STEPS || 75);
const samples = [];
const started = Date.now();

function mb(bytes) { return Math.round(bytes / 1048576 * 10) / 10; }

(async () => {
  for (let number = 1; number <= total; number += 1) {
    const run = db.prepare('INSERT INTO runs(status) VALUES(\'pending\')').run();
    const step = db.prepare('INSERT INTO run_steps(run_id, step_order, status) VALUES(?, 1, \'pending\')').run(run.lastInsertRowid);
    await runner.executeStep({ runId: Number(run.lastInsertRowid), runStepId: Number(step.lastInsertRowid), repoPath: work, prompt: 'soak', codexCommand: process.execPath, codexArgs: [fake], stdoutTailBytes: 16 * 1024, stderrTailBytes: 4096, stepLogMaxBytes: 32 * 1024, logFlushBytes: 8192, maxProcessTreeRssMb: 0 });
    const memory = process.memoryUsage(); samples.push(memory.rss);
    if (number % 10 === 0 || number === total) console.log(`step=${number} rssMB=${mb(memory.rss)} heapUsedMB=${mb(memory.heapUsed)} elapsedSec=${Math.round((Date.now() - started) / 1000)} dbMB=${mb(fs.statSync(process.env.DATABASE_PATH).size)}`);
  }
  const warmup = Math.max(5, Math.floor(total / 3));
  const initial = samples[0]; const peak = Math.max(...samples); const final = samples.at(-1);
  const firstWindow = Math.max(...samples.slice(warmup, warmup + 5));
  const growth = Math.max(0, final - firstWindow);
  const envelope = Number(process.env.SOAK_MAX_GROWTH_MB || 80) * 1048576;
  console.log(`initialRSS=${mb(initial)}MB peakRSS=${mb(peak)}MB finalRSS=${mb(final)}MB growthAfterWarmup=${mb(growth)}MB envelope=${mb(envelope)}MB`);
  if (growth > envelope) throw new Error('RSS continued growing beyond the soak-test plateau envelope.');
  console.log('PASS: long-chain memory remained within the plateau envelope.');
})().catch((error) => { console.error(error.stack); process.exitCode = 1; }).finally(() => { try { fs.rmSync(work, { recursive: true, force: true }); } catch {} });
