const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const dotenv = require('dotenv');
const db = require('../db');

const DEFAULT_CODEX_COMMAND = process.env.CODEX_CLI_COMMAND || 'codex';
const DEFAULT_TIMEOUT_MS = Number.parseInt(process.env.CODEX_RUN_TIMEOUT_MS || '600000', 10);
const DEFAULT_SANDBOX_MODE = 'workspace-write';
const SECRET_KEY_PATTERN = /(SECRET|TOKEN|KEY|PASSWORD|PASS|PWD|AUTH|COOKIE|SESSION|PRIVATE|CREDENTIAL)/i;
const activeProcesses = new Map();
const cancelledSteps = new Set();

const QUOTA_LIMIT_PATTERN = /(quota|rate[ -]?limit|usage[ -]?limit|refill|too many requests|exhausted)/i;
const QUOTA_REMAINING_PATTERN = /(?:^|\s)(100|\d{1,2})%\s+left\b/i;
const QUOTA_PROBE_TIMEOUT_MS = 5000;

function detectQuotaLimit(...parts) {
  const text = parts.filter(Boolean).join('\n');
  return QUOTA_LIMIT_PATTERN.test(text);
}

function parseQuotaRemaining(output = '') {
  // The interactive UI includes ANSI control sequences, so allow arbitrary
  // terminal styling between the percentage and its label.
  const plainText = String(output).replace(/\x1B(?:[@-_][0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g, '');
  const match = plainText.match(QUOTA_REMAINING_PATTERN);
  return match ? Number.parseInt(match[1], 10) : null;
}

function shellQuote(value) {
  const quote = String.fromCharCode(39);
  return quote + String(value).replaceAll(quote, `${quote}\\${quote}${quote}`) + quote;
}

function shouldProbeInteractiveQuota(command, extraArgs) {
  return extraArgs.length === 0 && path.basename(command) === 'codex' && process.platform !== 'win32';
}

function probeInteractiveQuota({ command, repoPath, timeoutMs = QUOTA_PROBE_TIMEOUT_MS }) {
  return new Promise((resolve) => {
    let output = '';
    let settled = false;
    const finish = (remaining = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      terminateProcessTree(child, 'SIGTERM');
      resolve(remaining);
    };
    // `script` supplies the pseudo-terminal required for Codex to render the
    // account percentage. A normal piped spawn never shows this UI value.
    const child = spawn('script', ['-qfec', shellQuote(command), '/dev/null'], {
      cwd: repoPath,
      shell: false,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env
    });
    const inspect = (chunk) => {
      output += chunk.toString();
      const remaining = parseQuotaRemaining(output);
      if (remaining !== null) finish(remaining);
    };
    child.stdout.on('data', inspect);
    child.stderr.on('data', inspect);
    child.on('error', () => finish(null));
    child.on('close', () => finish(parseQuotaRemaining(output)));
    const timer = setTimeout(() => finish(parseQuotaRemaining(output)), timeoutMs);
    timer.unref();
  });
}

function parseCodexJsonOutput(output = '') {
  const events = [];
  const invalidLines = [];

  String(output).split(/\r?\n/).forEach((line) => {
    if (!line.trim()) return;
    try {
      const event = JSON.parse(line);
      if (event && typeof event === 'object') events.push(event);
    } catch {
      invalidLines.push(line);
    }
  });

  const completedItems = events.filter((event) => event.type === 'item.completed').length;
  const turn = [...events].reverse().find((event) => event.type === 'turn.completed');
  return {
    events,
    invalidLines,
    progress: {
      completedItems,
      turnCompleted: Boolean(turn),
      usage: turn?.usage || null
    }
  };
}

function quotaEvidence(result) {
  // A successful Codex turn is authoritative. Agent messages and prompts can
  // legitimately discuss quotas, so scanning all JSON text creates false positives.
  if (result.code === 0) return '';

  const parsed = parseCodexJsonOutput(result.stdout);
  const errorEvents = parsed.events.filter((event) => {
    const type = String(event.type || '').toLowerCase();
    return type.includes('error') || type.includes('fail');
  });
  const structuredErrors = errorEvents.map((event) => JSON.stringify(event)).join('\n');

  // Preserve compatibility with non-JSON/custom commands, but only inspect their
  // stdout when no valid Codex JSON events were emitted.
  const unstructuredStdout = parsed.events.length === 0 ? result.stdout : '';
  return [result.stderr, structuredErrors, unstructuredStdout].filter(Boolean).join('\n');
}

function nowSql() {
  return new Date().toISOString();
}

function appendText(existing, next) {
  return [existing, next].filter(Boolean).join('');
}

function getStep(runStepId) {
  return db.prepare('SELECT * FROM run_steps WHERE id = ?').get(runStepId);
}

function updateRunStep(runStepId, patch) {
  const current = getStep(runStepId);
  if (!current) {
    throw new Error(`Run step ${runStepId} was not found.`);
  }

  const next = { ...current, ...patch, updated_at: nowSql() };
  db.prepare(`
    UPDATE run_steps
    SET status = @status,
        stdout_log = @stdout_log,
        stderr_log = @stderr_log,
        error_message = @error_message,
        started_at = @started_at,
        completed_at = @completed_at,
        updated_at = @updated_at
    WHERE id = @id
  `).run(next);
}

function appendRunStepLog(runStepId, streamName, text) {
  if (!text) return;
  const column = streamName === 'stderr' ? 'stderr_log' : 'stdout_log';
  const current = getStep(runStepId);
  if (!current) return;
  db.prepare(`UPDATE run_steps SET ${column} = ?, updated_at = ? WHERE id = ?`)
    .run(appendText(current[column], text), nowSql(), runStepId);
}

function updateRunStatus(runId, status, patch = {}) {
  if (!runId) return;
  const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(runId);
  if (!run) return;
  db.prepare(`
    UPDATE runs
    SET status = @status,
        stdout_log = @stdout_log,
        stderr_log = @stderr_log,
        error_message = @error_message,
        started_at = @started_at,
        completed_at = @completed_at,
        updated_at = @updated_at
    WHERE id = @id
  `).run({
    ...run,
    ...patch,
    status,
    updated_at: nowSql()
  });
}

function parseEnvFile(repoPath) {
  const envPath = path.join(repoPath, '.env');
  if (!fs.existsSync(envPath)) return {};
  return dotenv.parse(fs.readFileSync(envPath));
}

function collectSecretValues(repoPath) {
  const values = [];
  const envSources = { ...process.env, ...parseEnvFile(repoPath) };
  Object.entries(envSources).forEach(([key, value]) => {
    if (SECRET_KEY_PATTERN.test(key) && typeof value === 'string' && value.length >= 4) {
      values.push({ key, value });
    }
  });
  return values.sort((a, b) => b.value.length - a.value.length);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function createRedactor(repoPath) {
  const secrets = collectSecretValues(repoPath);
  return (input = '') => secrets.reduce((output, secret) => {
    return output.replace(new RegExp(escapeRegExp(secret.value), 'g'), `[REDACTED:${secret.key}]`);
  }, String(input));
}

function validateRepoPath(repoPath) {
  if (typeof repoPath !== 'string' || !repoPath.trim() || repoPath.includes('\0')) {
    throw new Error('A valid project folder path is required.');
  }
  const resolved = path.resolve(repoPath);
  if (!path.isAbsolute(repoPath) || !fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error('A valid project folder path is required.');
  }
  return resolved;
}

function buildCodexArgs(prompt, extraArgs = [], model = '', repoPath) {
  // Recipe projects may be new local folders rather than trusted Git repositories.
  // Read the prompt from stdin and explicitly allow Codex to run in those folders.
  if (extraArgs.length) return extraArgs;
  const args = [
    'exec',
    '--cd', repoPath,
    '--sandbox', DEFAULT_SANDBOX_MODE,
    '--json',
    '-c', 'sandbox_workspace_write.network_access=true',
    '--skip-git-repo-check'
  ];
  if (typeof model === 'string' && model.trim()) args.push('--model', model.trim());
  args.push('-');
  return args;
}

function spawnCodex({ command, args, repoPath, prompt, timeoutMs, runStepId, redactor }) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    const child = spawn(command, args, {
      cwd: repoPath,
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env
    });

    activeProcesses.set(runStepId, child);

    const timer = setTimeout(() => {
      timedOut = true;
      terminateProcessTree(child, 'SIGTERM');
      setTimeout(() => {
        if (!child.killed) terminateProcessTree(child, 'SIGKILL');
      }, 5000).unref();
    }, timeoutMs);
    timer.unref();

    child.stdout.on('data', (chunk) => {
      const text = redactor(chunk.toString());
      stdout += text;
      appendRunStepLog(runStepId, 'stdout', text);
    });

    child.stderr.on('data', (chunk) => {
      const text = redactor(chunk.toString());
      stderr += text;
      appendRunStepLog(runStepId, 'stderr', text);
    });

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      activeProcesses.delete(runStepId);
      reject(error);
    });

    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      activeProcesses.delete(runStepId);
      resolve({ code, signal, stdout, stderr, timedOut });
    });

    child.stdin.end(prompt);
  });
}

async function executeStep(options) {
  const {
    runId,
    runStepId,
    repoPath,
    prompt,
    codexCommand = DEFAULT_CODEX_COMMAND,
    codexArgs = [],
    codexModel = '',
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retries = 0
  } = options;

  const safeRepoPath = validateRepoPath(repoPath);
  if (!runStepId) throw new Error('runStepId is required.');
  if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('Prompt text is required.');

  const redactor = createRedactor(repoPath);
  const maxAttempts = Math.max(1, Number.parseInt(retries, 10) + 1);
  const args = buildCodexArgs(prompt, codexArgs, codexModel, safeRepoPath);

  updateRunStatus(runId, 'running', { started_at: nowSql() });
  updateRunStep(runStepId, { status: 'running', started_at: nowSql(), completed_at: null, error_message: null });

  if (shouldProbeInteractiveQuota(codexCommand, codexArgs)) {
    const quotaRemaining = await probeInteractiveQuota({ command: codexCommand, repoPath: safeRepoPath });
    if (quotaRemaining === 0) {
      const quotaError = new Error('Codex interactive CLI reports 0% quota left.');
      quotaError.code = 'QUOTA_LIMIT_DETECTED';
      updateRunStep(runStepId, { status: 'waiting_for_quota', completed_at: null, error_message: quotaError.message });
      updateRunStatus(runId, 'waiting_for_quota', { completed_at: null, error_message: quotaError.message });
      throw quotaError;
    }
    if (quotaRemaining !== null) {
      appendRunStepLog(runStepId, 'stdout', `[CodexRunner] Interactive quota check: ${quotaRemaining}% left.\n`);
    }
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    appendRunStepLog(runStepId, 'stdout', redactor(`\n[CodexRunner] Attempt ${attempt} of ${maxAttempts}.\n`));

    try {
      const result = await spawnCodex({ command: codexCommand, args, repoPath: safeRepoPath, prompt, timeoutMs, runStepId, redactor });

      const structuredOutput = parseCodexJsonOutput(result.stdout);
      result.structuredOutput = structuredOutput;

      if (detectQuotaLimit(quotaEvidence(result))) {
        const quotaError = new Error('Codex quota or rate limit detected.');
        quotaError.code = 'QUOTA_LIMIT_DETECTED';
        quotaError.result = result;
        throw quotaError;
      }

      const requiresCompletedTurn = codexArgs.length === 0 && path.basename(codexCommand) === 'codex';
      if (result.code === 0 && (!requiresCompletedTurn || structuredOutput.progress.turnCompleted)) {
        updateRunStep(runStepId, { status: 'succeeded', completed_at: nowSql(), error_message: null });
        updateRunStatus(runId, 'succeeded', { completed_at: nowSql(), error_message: null });
        return { ...result, attempt };
      }

      if (result.code === 0 && requiresCompletedTurn) {
        const error = new Error('Codex exited without a turn.completed event.');
        error.result = result;
        throw error;
      }

      if (cancelledSteps.has(runStepId)) {
        cancelledSteps.delete(runStepId);
        updateRunStep(runStepId, { status: 'cancelled', completed_at: nowSql(), error_message: 'Cancelled by user.' });
        updateRunStatus(runId, 'cancelled', { completed_at: nowSql(), error_message: 'Cancelled by user.' });
        return { ...result, cancelled: true, attempt };
      }

      const error = new Error(result.timedOut ? 'Codex run timed out.' : `Codex exited with code ${result.code}${result.signal ? ` (${result.signal})` : ''}.`);
      error.result = result;
      throw error;
    } catch (error) {
      const quotaDetected = error.code === 'QUOTA_LIMIT_DETECTED'
        || (error.result && detectQuotaLimit(error.message, quotaEvidence(error.result)));
      const runnerMessage = error.code === 'ENOENT'
        ? `Codex CLI executable "${codexCommand}" was not found. Configure an executable command or absolute path in Settings, and ensure it is available to the app service user.`
        : error.message;
      const message = redactor(runnerMessage);
      if (error.code === 'ENOENT') error.message = message;
      appendRunStepLog(runStepId, 'stderr', `[CodexRunner] ${message}\n`);
      if (quotaDetected || attempt === maxAttempts) {
        if (quotaDetected) {
          error.code = 'QUOTA_LIMIT_DETECTED';
          updateRunStep(runStepId, { status: 'waiting_for_quota', completed_at: null, error_message: message });
          updateRunStatus(runId, 'waiting_for_quota', { completed_at: null, error_message: message });
        } else {
          updateRunStep(runStepId, { status: 'failed', completed_at: nowSql(), error_message: message });
          updateRunStatus(runId, 'failed', { completed_at: nowSql(), error_message: message });
        }
        throw error;
      }
    }
  }

  throw new Error('Codex runner ended unexpectedly.');
}

function terminateProcessTree(child, signal) {
  if (!child || child.killed) return;
  try {
    if (process.platform !== 'win32' && child.pid) {
      process.kill(-child.pid, signal);
    } else {
      child.kill(signal);
    }
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

function cancel(runStepId) {
  const child = activeProcesses.get(runStepId);
  if (!child) return false;
  cancelledSteps.add(runStepId);
  terminateProcessTree(child, 'SIGTERM');
  updateRunStep(runStepId, { status: 'cancelled', completed_at: nowSql(), error_message: 'Cancelled by user.' });
  return true;
}

module.exports = {
  cancel,
  collectSecretValues,
  createRedactor,
  detectQuotaLimit,
  parseQuotaRemaining,
  parseCodexJsonOutput,
  probeInteractiveQuota,
  validateRepoPath,
  executeStep
};
