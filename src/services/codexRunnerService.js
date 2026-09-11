const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const dotenv = require('dotenv');
const db = require('../db');

const DEFAULT_CODEX_COMMAND = process.env.CODEX_CLI_COMMAND || 'codex';
const DEFAULT_SANDBOX_MODE = process.env.CODEX_SANDBOX_MODE || 'workspace-write';
const SECRET_KEY_PATTERN = /(SECRET|TOKEN|KEY|PASSWORD|PASS|PWD|AUTH|COOKIE|SESSION|PRIVATE|CREDENTIAL)/i;
const QUOTA_LIMIT_PATTERN = /(quota|rate[ -]?limit|usage[ -]?limit|refill|too many requests|exhausted)/i;
const QUOTA_REMAINING_PATTERN = /(?:^|\s)(100|\d{1,2})%\s+left\b/i;
const TRUNCATION_MARKER = '[MVP Chef: earlier log output truncated to maintain bounded memory/storage]\n';
const activeProcesses = new Map();
const cancelledSteps = new Set();
const DEFAULT_RETRY_DELAY_MS = integerSetting('CODEX_RETRY_DELAY_MS', 300000, 0);

function integerSetting(name, fallback, minimum = 1) {
  const parsed = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(parsed) && parsed >= minimum ? parsed : fallback;
}

function reliabilitySettings(overrides = {}) {
  const totalMb = os.totalmem() / 1024 / 1024;
  const derivedMb = Math.max(512, Math.min(8192, Math.floor(totalMb * 0.5)));
  return {
    stdoutTailBytes: overrides.stdoutTailBytes ?? integerSetting('CODEX_STDOUT_MEMORY_TAIL_BYTES', 256 * 1024),
    stderrTailBytes: overrides.stderrTailBytes ?? integerSetting('CODEX_STDERR_MEMORY_TAIL_BYTES', 128 * 1024),
    stepLogMaxBytes: overrides.stepLogMaxBytes ?? integerSetting('CODEX_STEP_LOG_MAX_BYTES', 2 * 1024 * 1024),
    logFlushBytes: overrides.logFlushBytes ?? integerSetting('CODEX_LOG_FLUSH_BYTES', 64 * 1024),
    logFlushIntervalMs: overrides.logFlushIntervalMs ?? integerSetting('CODEX_LOG_FLUSH_INTERVAL_MS', 250),
    maxProcessTreeRssMb: overrides.maxProcessTreeRssMb ?? integerSetting('CODEX_MAX_PROCESS_TREE_RSS_MB', derivedMb, 0),
    memoryPollIntervalMs: overrides.memoryPollIntervalMs ?? integerSetting('CODEX_MEMORY_POLL_INTERVAL_MS', 1000),
    killGraceMs: overrides.killGraceMs ?? integerSetting('CODEX_KILL_GRACE_MS', 2000, 0),
    telemetry: overrides.telemetry ?? process.env.CODEX_MEMORY_TELEMETRY === '1'
  };
}

function byteTail(value, maxBytes, marker = '') {
  const buffer = Buffer.from(String(value || ''));
  if (buffer.length <= maxBytes) return buffer.toString();
  const markerBuffer = Buffer.from(marker);
  const available = Math.max(0, maxBytes - markerBuffer.length);
  return marker + buffer.subarray(buffer.length - available).toString('utf8').replace(/^\uFFFD+/, '');
}

function detectQuotaLimit(...parts) { return QUOTA_LIMIT_PATTERN.test(parts.filter(Boolean).join('\n')); }

function parseQuotaRemaining(output = '') {
  const plainText = String(output).replace(/\x1B(?:[@-_][0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g, '');
  const match = plainText.match(QUOTA_REMAINING_PATTERN);
  return match ? Number.parseInt(match[1], 10) : null;
}

function createNdjsonAggregator({ invalidEvidenceBytes = 32 * 1024, errorEvidenceBytes = 64 * 1024 } = {}) {
  const state = { incomplete: '', validEventCount: 0, invalidLines: [], completedItems: 0, turnCompleted: false, usage: null, errorEvidence: '' };
  function processLine(line) {
    if (!line.trim()) return;
    try {
      const event = JSON.parse(line);
      if (!event || typeof event !== 'object') return;
      state.validEventCount += 1;
      if (event.type === 'item.completed') state.completedItems += 1;
      if (event.type === 'turn.completed') {
        state.turnCompleted = true;
        state.usage = event.usage || null;
      }
      const type = String(event.type || '').toLowerCase();
      if (type.includes('error') || type.includes('fail')) {
        state.errorEvidence = byteTail(`${state.errorEvidence}${JSON.stringify(event)}\n`, errorEvidenceBytes, TRUNCATION_MARKER);
      }
    } catch {
      state.invalidLines.push(byteTail(line, invalidEvidenceBytes));
      while (Buffer.byteLength(state.invalidLines.join('\n')) > invalidEvidenceBytes) state.invalidLines.shift();
    }
  }
  return {
    push(text) {
      state.incomplete += text;
      let newline;
      while ((newline = state.incomplete.indexOf('\n')) !== -1) {
        const line = state.incomplete.slice(0, newline).replace(/\r$/, '');
        state.incomplete = state.incomplete.slice(newline + 1);
        processLine(line);
      }
      // A malicious/non-NDJSON worker must not turn the parser fragment into another unbounded log.
      state.incomplete = byteTail(state.incomplete, invalidEvidenceBytes, TRUNCATION_MARKER);
    },
    finish() { if (state.incomplete) processLine(state.incomplete); state.incomplete = ''; },
    result() {
      return {
        validEventCount: state.validEventCount,
        invalidLines: [...state.invalidLines],
        errorEvidence: state.errorEvidence,
        progress: { completedItems: state.completedItems, turnCompleted: state.turnCompleted, usage: state.usage }
      };
    }
  };
}

// Compatibility helper for small inputs and tests. Production uses createNdjsonAggregator directly.
function parseCodexJsonOutput(output = '') {
  const events = [];
  const invalidLines = [];
  String(output).split(/\r?\n/).forEach((line) => {
    if (!line.trim()) return;
    try { const event = JSON.parse(line); if (event && typeof event === 'object') events.push(event); } catch { invalidLines.push(line); }
  });
  const turn = [...events].reverse().find((event) => event.type === 'turn.completed');
  return { events, invalidLines, progress: { completedItems: events.filter((event) => event.type === 'item.completed').length, turnCompleted: Boolean(turn), usage: turn?.usage || null } };
}

function nowSql() { return new Date().toISOString(); }
function retryDelayMs(value = DEFAULT_RETRY_DELAY_MS) { const parsed = Number.parseInt(value, 10); return Number.isFinite(parsed) && parsed >= 0 ? parsed : 300000; }
function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function updateRunStep(runStepId, patch) {
  const current = db.prepare('SELECT id FROM run_steps WHERE id = ?').get(runStepId);
  if (!current) throw new Error(`Run step ${runStepId} was not found.`);
  const allowed = new Set(['status', 'error_message', 'started_at', 'completed_at']);
  const entries = Object.entries(patch).filter(([key]) => allowed.has(key));
  const values = { id: runStepId, updated_at: nowSql() };
  const assignments = ['updated_at=@updated_at'];
  entries.forEach(([key, value]) => { assignments.push(`${key}=@${key}`); values[key] = value; });
  db.prepare(`UPDATE run_steps SET ${assignments.join(', ')} WHERE id=@id`).run(values);
}

function appendBoundedRunStepLog(runStepId, streamName, text, maxBytes) {
  if (!text) return;
  const column = streamName === 'stderr' ? 'stderr_log' : 'stdout_log';
  const markerBytes = Buffer.byteLength(TRUNCATION_MARKER);
  // Concatenation and tail selection remain inside SQLite; the old TEXT is never deserialized in Node.
  db.prepare(`
    UPDATE run_steps SET ${column} = CASE
      WHEN length(CAST(COALESCE(${column}, '') || @text AS BLOB)) <= @maxBytes THEN COALESCE(${column}, '') || @text
      ELSE @marker || CAST(substr(CAST(COALESCE(${column}, '') || @text AS BLOB), -(@maxBytes - @markerBytes)) AS TEXT)
    END, updated_at=@updatedAt WHERE id=@id
  `).run({ text: String(text), maxBytes, markerBytes, marker: TRUNCATION_MARKER, updatedAt: nowSql(), id: runStepId });
}

function createLogWriter(runStepId, settings) {
  const pending = { stdout: '', stderr: '' };
  let closed = false;
  let flushing = false;
  const flush = () => {
    if (flushing) return;
    flushing = true;
    try {
      for (const stream of ['stdout', 'stderr']) {
        const text = pending[stream];
        pending[stream] = '';
        appendBoundedRunStepLog(runStepId, stream, text, settings.stepLogMaxBytes);
      }
    } finally { flushing = false; }
  };
  const timer = setInterval(flush, settings.logFlushIntervalMs);
  timer.unref();
  return {
    write(stream, text) {
      if (closed || !text) return;
      pending[stream] += text;
      if (Buffer.byteLength(pending[stream]) >= settings.logFlushBytes) flush();
    },
    close() { if (closed) return; closed = true; clearInterval(timer); flush(); }
  };
}

function updateRunStatus(runId, status, patch = {}) {
  if (!runId) return;
  const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(runId);
  if (!run) return;
  db.prepare('UPDATE runs SET status=@status, stdout_log=@stdout_log, stderr_log=@stderr_log, error_message=@error_message, started_at=@started_at, completed_at=@completed_at, updated_at=@updated_at WHERE id=@id')
    .run({ ...run, ...patch, status, updated_at: nowSql() });
}

function parseEnvFile(repoPath) { const envPath = path.join(repoPath, '.env'); return fs.existsSync(envPath) ? dotenv.parse(fs.readFileSync(envPath)) : {}; }
function collectSecretValues(repoPath) {
  return Object.entries({ ...process.env, ...parseEnvFile(repoPath) })
    .filter(([key, value]) => SECRET_KEY_PATTERN.test(key) && typeof value === 'string' && value.length >= 4)
    .map(([key, value]) => ({ key, value })).sort((a, b) => b.value.length - a.value.length);
}
function escapeRegExp(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function createRedactor(repoPath) { const secrets = collectSecretValues(repoPath); return (input = '') => secrets.reduce((output, secret) => output.replace(new RegExp(escapeRegExp(secret.value), 'g'), `[REDACTED:${secret.key}]`), String(input)); }
function validateRepoPath(repoPath) {
  if (typeof repoPath !== 'string' || !repoPath.trim() || repoPath.includes('\0')) throw new Error('A valid project folder path is required.');
  const resolved = path.resolve(repoPath);
  if (!path.isAbsolute(repoPath) || !fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) throw new Error('A valid project folder path is required.');
  return resolved;
}
function buildCodexArgs(prompt, extraArgs = [], model = '', reasoningEffort = '', repoPath) {
  if (extraArgs.length) return extraArgs;
  const args = ['exec', '--cd', repoPath, '--sandbox', DEFAULT_SANDBOX_MODE, '--json', '--search', '-c', 'sandbox_workspace_write.network_access=true', '--skip-git-repo-check'];
  if (typeof model === 'string' && model.trim()) args.push('--model', model.trim());
  if (['minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(reasoningEffort)) args.push('-c', `model_reasoning_effort=${reasoningEffort}`);
  args.push('-'); return args;
}

function terminateProcessTree(child, signal) {
  if (!child?.pid) return;
  try { if (process.platform !== 'win32') process.kill(-child.pid, signal); else child.kill(signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
}
function groupAlive(pid) { try { process.kill(-pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; return true; } }
function readProcessTreeRssBytes(rootPid) {
  if (process.platform !== 'linux' || !rootPid) return null;
  let entries;
  try { entries = fs.readdirSync('/proc').filter((name) => /^\d+$/.test(name)); } catch { return null; }
  const processes = new Map();
  for (const entry of entries) {
    try {
      const stat = fs.readFileSync(`/proc/${entry}/stat`, 'utf8');
      const end = stat.lastIndexOf(')');
      const fields = stat.slice(end + 2).split(' ');
      const status = fs.readFileSync(`/proc/${entry}/status`, 'utf8');
      const rss = Number(status.match(/^VmRSS:\s+(\d+)\s+kB$/m)?.[1] || 0) * 1024;
      processes.set(Number(entry), { ppid: Number(fields[1]), rss });
    } catch { /* process exited during the snapshot */ }
  }
  const descendants = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [pid, info] of processes) if (!descendants.has(pid) && descendants.has(info.ppid)) { descendants.add(pid); changed = true; }
  }
  if (!processes.has(rootPid)) return null;
  return [...descendants].reduce((sum, pid) => sum + (processes.get(pid)?.rss || 0), 0);
}
function telemetry(label, context, workerRssBytes = null) {
  if (!context.settings.telemetry && label !== 'watchdog') return;
  const memory = process.memoryUsage();
  console.log('[CodexRunner:memory]', JSON.stringify({ label, runId: context.runId, stepId: context.runStepId, attempt: context.attempt, workerPid: context.child?.pid || null, workerTreeRssMb: workerRssBytes == null ? null : Math.round(workerRssBytes / 1048576), nodeRssMb: Math.round(memory.rss / 1048576), heapUsedMb: Math.round(memory.heapUsed / 1048576), heapTotalMb: Math.round(memory.heapTotal / 1048576), externalMb: Math.round(memory.external / 1048576) }));
}

function spawnCodex({ command, args, repoPath, prompt, runId, runStepId, attempt = 1, redactor, settings = reliabilitySettings() }) {
  return new Promise((resolve, reject) => {
    const parser = createNdjsonAggregator();
    const logWriter = createLogWriter(runStepId, settings);
    let stdoutTail = '';
    let stderrTail = '';
    let settled = false;
    let memoryError = null;
    let watchdog = null;
    let killTimer = null;
    const child = spawn(command, args, { cwd: repoPath, shell: false, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
    const context = { child, runId, runStepId, attempt, settings };
    activeProcesses.set(runStepId, { child, logWriter, settings });
    telemetry('before-launch', context);

    const requestTermination = () => {
      terminateProcessTree(child, 'SIGTERM');
      if (!killTimer && settings.killGraceMs >= 0) {
        killTimer = setTimeout(() => { if (groupAlive(child.pid)) terminateProcessTree(child, 'SIGKILL'); }, settings.killGraceMs);
        killTimer.unref();
      }
    };
    const cleanup = async (abnormal) => {
      if (watchdog) clearInterval(watchdog);
      if (killTimer) clearTimeout(killTimer);
      if (abnormal || (child.pid && groupAlive(child.pid))) requestTermination();
      logWriter.close();
      activeProcesses.delete(runStepId);
      child.stdin?.destroy();
      telemetry('after-cleanup', context, readProcessTreeRssBytes(child.pid));
    };
    const finish = async (error, code, signal) => {
      if (settled) return;
      settled = true;
      parser.finish();
      await cleanup(Boolean(error || code !== 0 || signal));
      const structuredOutput = parser.result();
      const result = { code, signal, workerPid: child.pid, stdout: stdoutTail, stderr: stderrTail, structuredOutput };
      if (memoryError) { memoryError.result = result; reject(memoryError); }
      else if (error) reject(error);
      else resolve(result);
    };
    child.stdout.on('data', (chunk) => {
      const text = redactor(chunk.toString());
      parser.push(text);
      stdoutTail = byteTail(stdoutTail + text, settings.stdoutTailBytes, TRUNCATION_MARKER);
      logWriter.write('stdout', text);
    });
    child.stderr.on('data', (chunk) => {
      const text = redactor(chunk.toString());
      stderrTail = byteTail(stderrTail + text, settings.stderrTailBytes, TRUNCATION_MARKER);
      logWriter.write('stderr', text);
    });
    child.once('error', (error) => finish(error, null, null));
    child.once('close', (code, signal) => finish(null, code, signal));
    if (process.platform === 'linux' && settings.maxProcessTreeRssMb > 0) {
      watchdog = setInterval(() => {
        const rss = readProcessTreeRssBytes(child.pid);
        if (rss != null && rss > settings.maxProcessTreeRssMb * 1048576 && !memoryError) {
          const nodeRss = process.memoryUsage().rss;
          const diagnostic = `[CodexRunner] CODEX_MEMORY_LIMIT: Codex worker/process-tree RSS ${Math.round(rss / 1048576)} MB exceeded ${settings.maxProcessTreeRssMb} MB; MVP Chef Node RSS is ${Math.round(nodeRss / 1048576)} MB. Terminating isolated worker.\n`;
          memoryError = new Error(diagnostic.trim()); memoryError.code = 'CODEX_MEMORY_LIMIT';
          stderrTail = byteTail(stderrTail + diagnostic, settings.stderrTailBytes, TRUNCATION_MARKER);
          logWriter.write('stderr', diagnostic); telemetry('watchdog', context, rss); requestTermination();
        }
      }, settings.memoryPollIntervalMs);
      watchdog.unref();
    }
    child.stdin.end(prompt);
  });
}

function quotaEvidence(result) {
  if (result.code === 0) return '';
  const structured = result.structuredOutput;
  const unstructuredStdout = !structured?.validEventCount ? result.stdout : '';
  return [result.stderr, structured?.errorEvidence, unstructuredStdout].filter(Boolean).join('\n');
}

async function executeStep(options) {
  const { runId, runStepId, repoPath, prompt, codexCommand = DEFAULT_CODEX_COMMAND, codexArgs = [], codexModel = '', codexReasoningEffort = '', retries = 0, retryDelay = DEFAULT_RETRY_DELAY_MS } = options;
  const safeRepoPath = validateRepoPath(repoPath);
  if (!runStepId) throw new Error('runStepId is required.');
  if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('Prompt text is required.');
  const redactor = createRedactor(repoPath);
  const settings = reliabilitySettings(options);
  const maxAttempts = Math.max(1, Number.parseInt(retries, 10) + 1);
  const args = buildCodexArgs(prompt, codexArgs, codexModel, codexReasoningEffort, safeRepoPath);
  const delayBetweenAttemptsMs = retryDelayMs(retryDelay);
  updateRunStatus(runId, 'running', { started_at: nowSql() });
  updateRunStep(runStepId, { status: 'running', started_at: nowSql(), completed_at: null, error_message: null });
  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      appendBoundedRunStepLog(runStepId, 'stdout', redactor(`\n[CodexRunner] Attempt ${attempt} of ${maxAttempts}.\n`), settings.stepLogMaxBytes);
      try {
        const result = await spawnCodex({ command: codexCommand, args, repoPath: safeRepoPath, prompt, runId, runStepId, attempt, redactor, settings });
        const structuredOutput = result.structuredOutput;
        if (detectQuotaLimit(quotaEvidence(result))) { const error = new Error('Codex quota or rate limit detected.'); error.code = 'QUOTA_LIMIT_DETECTED'; error.result = result; throw error; }
        const requiresCompletedTurn = codexArgs.length === 0 && path.basename(codexCommand) === 'codex';
        if (result.code === 0 && (!requiresCompletedTurn || structuredOutput.progress.turnCompleted)) {
          updateRunStep(runStepId, { status: 'succeeded', completed_at: nowSql(), error_message: null }); updateRunStatus(runId, 'succeeded', { completed_at: nowSql(), error_message: null }); return { ...result, attempt };
        }
        if (result.code === 0 && requiresCompletedTurn) { const error = new Error('Codex exited without a turn.completed event.'); error.result = result; throw error; }
        if (cancelledSteps.has(runStepId)) {
          updateRunStep(runStepId, { status: 'cancelled', completed_at: nowSql(), error_message: 'Cancelled by user.' }); updateRunStatus(runId, 'cancelled', { completed_at: nowSql(), error_message: 'Cancelled by user.' }); return { ...result, cancelled: true, attempt };
        }
        const error = new Error(`Codex exited with code ${result.code}${result.signal ? ` (${result.signal})` : ''}.`); error.result = result; throw error;
      } catch (error) {
        const quotaDetected = error.code === 'QUOTA_LIMIT_DETECTED' || (error.result && detectQuotaLimit(error.message, quotaEvidence(error.result)));
        const runnerMessage = error.code === 'ENOENT' ? `Codex CLI executable "${codexCommand}" was not found. Configure an executable command or absolute path in Settings, and ensure it is available to the app service user.` : error.message;
        const message = redactor(runnerMessage); if (error.code === 'ENOENT') error.message = message;
        appendBoundedRunStepLog(runStepId, 'stderr', `[CodexRunner] ${message}\n`, settings.stepLogMaxBytes);
        if (quotaDetected || attempt === maxAttempts || cancelledSteps.has(runStepId)) {
          if (quotaDetected) { error.code = 'QUOTA_LIMIT_DETECTED'; updateRunStep(runStepId, { status: 'waiting_for_quota', completed_at: null, error_message: message }); updateRunStatus(runId, 'waiting_for_quota', { completed_at: null, error_message: message }); }
          else if (cancelledSteps.has(runStepId)) { updateRunStep(runStepId, { status: 'cancelled', completed_at: nowSql(), error_message: 'Cancelled by user.' }); }
          else { updateRunStep(runStepId, { status: 'failed', completed_at: nowSql(), error_message: message }); updateRunStatus(runId, 'failed', { completed_at: nowSql(), error_message: message }); }
          throw error;
        }
        if (error.code === 'CODEX_MEMORY_LIMIT') appendBoundedRunStepLog(runStepId, 'stdout', '[CodexRunner] Starting retry with a fresh isolated Codex worker after memory-limit cleanup.\n', settings.stepLogMaxBytes);
        appendBoundedRunStepLog(runStepId, 'stdout', `[CodexRunner] Waiting ${Math.round(delayBetweenAttemptsMs / 1000)} seconds before retrying the prompt.\n`, settings.stepLogMaxBytes);
        await wait(delayBetweenAttemptsMs);
      }
    }
  } finally { cancelledSteps.delete(runStepId); }
  throw new Error('Codex runner ended unexpectedly.');
}

function cancel(runStepId) {
  const active = activeProcesses.get(runStepId);
  if (!active) return false;
  cancelledSteps.add(runStepId); terminateProcessTree(active.child, 'SIGTERM');
  const timer = setTimeout(() => terminateProcessTree(active.child, 'SIGKILL'), active.settings.killGraceMs); timer.unref();
  updateRunStep(runStepId, { status: 'cancelled', completed_at: nowSql(), error_message: 'Cancelled by user.' }); return true;
}
function shutdown() {
  for (const { child, settings } of activeProcesses.values()) {
    terminateProcessTree(child, 'SIGTERM');
    const timer = setTimeout(() => terminateProcessTree(child, 'SIGKILL'), settings.killGraceMs);
    timer.unref();
  }
}

module.exports = { byteTail, cancel, collectSecretValues, createNdjsonAggregator, createRedactor, detectQuotaLimit, parseQuotaRemaining, parseCodexJsonOutput, readProcessTreeRssBytes, reliabilitySettings, retryDelayMs, terminateProcessTree, validateRepoPath, executeStep, spawnCodex, shutdown, _activeProcesses: activeProcesses, TRUNCATION_MARKER };
