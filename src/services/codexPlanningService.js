const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const codexRunner = require('./codexRunnerService');

const active = new Map();

function planningArgs({ cwd, outputFile, model, reasoningEffort }) {
  // Approval policy is a top-level Codex option, so it must precede the `exec`
  // subcommand. Passing it after `exec` makes newer Codex CLIs reject the
  // planning invocation before the architecture pass can start.
  const args = ['--search', '--ask-for-approval', 'never', 'exec', '--cd', cwd, '--sandbox', 'read-only', '--skip-git-repo-check', '--json', '--output-last-message', outputFile];
  if (model) args.push('--model', model);
  if (['minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(reasoningEffort)) args.push('-c', `model_reasoning_effort=${reasoningEffort}`);
  args.push('-');
  return args;
}

async function executePlanning({ sessionId, cwd, prompt, command = 'codex', model = '', reasoningEffort = 'medium', timeoutMs = 45 * 60 * 1000, spawnProcess = spawn }) {
  const safeCwd = codexRunner.validateRepoPath(cwd);
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-chef-wizard-'));
  const outputFile = path.join(temporaryDirectory, 'last-message.txt');
  const args = planningArgs({ cwd: safeCwd, outputFile, model, reasoningEffort });
  const redact = codexRunner.createRedactor(safeCwd);
  try {
    const result = await new Promise((resolve, reject) => {
      let stderr = '';
      let stdout = '';
      let settled = false;
      const child = spawnProcess(command, args, { cwd: safeCwd, env: process.env, shell: false, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
      active.set(Number(sessionId), child);
      const finish = (error, code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        active.delete(Number(sessionId));
        if ((error || code !== 0) && child.pid) {
          try { codexRunner.terminateProcessTree(child, 'SIGTERM'); } catch { /* already exited */ }
        }
        if (error) reject(error); else resolve({ code, stderr, stdout });
      };
      const timer = setTimeout(() => {
        const error = new Error('Codex planning pass timed out.');
        error.code = 'PLANNING_TIMEOUT';
        codexRunner.terminateProcessTree?.(child, 'SIGTERM') || child.kill('SIGTERM');
        finish(error);
      }, timeoutMs);
      timer.unref();
      child.stdout.on('data', (chunk) => { stdout = codexRunner.byteTail ? codexRunner.byteTail(stdout + redact(chunk), 128 * 1024) : (stdout + redact(chunk)).slice(-131072); });
      child.stderr.on('data', (chunk) => { stderr = (stderr + redact(chunk)).slice(-131072); });
      child.once('error', finish);
      child.once('close', (code) => finish(null, code));
      child.stdin.end(prompt);
    });
    if (result.code !== 0) throw new Error(`Codex planning failed with exit code ${result.code}: ${result.stderr.slice(-2000)}`);
    if (/failed to (?:write|save).*(?:last|output)|output-last-message.*(?:fail|error)/i.test(result.stderr)) throw new Error(`Codex could not save its planning result: ${result.stderr.slice(-2000)}`);
    if (!fs.existsSync(outputFile) || !fs.statSync(outputFile).isFile()) throw new Error('Codex completed without creating the final planning result file.');
    if (fs.statSync(outputFile).size > 10 * 1024 * 1024) throw new Error('Codex planning result exceeded the 10 MB artifact safety limit.');
    const answer = fs.readFileSync(outputFile, 'utf8');
    if (!answer.trim()) throw new Error('Codex returned an empty planning result.');
    return { answer, args, stderr: result.stderr };
  } finally {
    active.delete(Number(sessionId));
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function cancel(sessionId) {
  const child = active.get(Number(sessionId));
  if (!child) return false;
  try { if (process.platform !== 'win32') process.kill(-child.pid, 'SIGTERM'); else child.kill('SIGTERM'); } catch { /* exited */ }
  active.delete(Number(sessionId));
  return true;
}
function shutdown() {
  for (const child of active.values()) {
    try { codexRunner.terminateProcessTree(child, 'SIGTERM'); } catch { /* already exited */ }
  }
  active.clear();
}

module.exports = { cancel, executePlanning, planningArgs, shutdown, _active: active };
