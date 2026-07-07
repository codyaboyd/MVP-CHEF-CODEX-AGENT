const { spawn } = require('node:child_process');
const db = require('../db');

const CHECKS = Object.freeze({ lint: 'lint', test: 'test', build: 'build' });
const COMMAND_FIELDS = Object.freeze({
  lint: 'lint_command',
  test: 'test_command',
  build: 'build_command'
});

function nowSql() { return new Date().toISOString(); }

function parseRequiredChecks(value) {
  if (!value || !String(value).trim()) return Object.values(CHECKS);
  const tokens = String(value).split(/[\n,]+/).map((token) => token.trim().toLowerCase()).filter(Boolean);
  const selected = tokens.filter((token) => CHECKS[token]);
  return selected.length ? [...new Set(selected)] : Object.values(CHECKS);
}

function hasManualOverride(runStepId) {
  return Boolean(db.prepare('SELECT quality_gate_override FROM run_steps WHERE id = ?').get(runStepId)?.quality_gate_override);
}

function saveManualOverride(runStepId, reason = 'Manual quality gate override.') {
  db.prepare(`
    UPDATE run_steps
    SET quality_gate_override = 1,
        quality_gate_override_reason = ?,
        quality_gate_override_at = ?,
        status = CASE WHEN status = 'failed' THEN 'paused' ELSE status END,
        error_message = NULL,
        updated_at = ?
    WHERE id = ?
  `).run(String(reason || 'Manual quality gate override.').trim(), nowSql(), nowSql(), runStepId);
}

function runCommand({ checkName, command, cwd, runId, runStepId, required }) {
  return new Promise((resolve) => {
    const startedAt = nowSql();
    let stdout = '';
    let stderr = '';
    if (!command || !command.trim()) {
      const output = `No ${checkName} command configured; skipping.\n`;
      db.prepare(`
        INSERT INTO run_step_checks (run_id, run_step_id, check_name, command, required, status, exit_code, stdout_log, stderr_log, started_at, completed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(runId, runStepId, checkName, '', required ? 1 : 0, 'skipped', 0, output, '', startedAt, nowSql());
      resolve({ checkName, command: '', required, status: 'skipped', exitCode: 0, stdout: output, stderr: '' });
      return;
    }

    const child = spawn(command, { cwd, shell: true, env: process.env });
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => { stderr += `${error.message}\n`; });
    child.on('close', (code) => {
      const status = code === 0 ? 'passed' : 'failed';
      db.prepare(`
        INSERT INTO run_step_checks (run_id, run_step_id, check_name, command, required, status, exit_code, stdout_log, stderr_log, started_at, completed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(runId, runStepId, checkName, command, required ? 1 : 0, status, code, stdout, stderr, startedAt, nowSql());
      resolve({ checkName, command, required, status, exitCode: code, stdout, stderr });
    });
  });
}

async function runQualityGates({ runId, runStepId, project, recipeStep }) {
  const requiredChecks = parseRequiredChecks(recipeStep.requiredChecks || recipeStep.required_checks);
  db.prepare('DELETE FROM run_step_checks WHERE run_step_id = ?').run(runStepId);
  const results = [];
  for (const checkName of Object.values(CHECKS)) {
    results.push(await runCommand({
      checkName,
      command: project[COMMAND_FIELDS[checkName]],
      cwd: project.repo_path,
      runId,
      runStepId,
      required: requiredChecks.includes(checkName)
    }));
  }
  const failedRequired = results.filter((result) => result.required && result.status === 'failed');
  if (failedRequired.length && !hasManualOverride(runStepId)) {
    const labels = failedRequired.map((result) => `${result.checkName} (${result.command})`).join(', ');
    throw new Error(`Required quality gate failed: ${labels}. Use manual override only after reviewing the check output.`);
  }
  return results;
}

function getChecksForRun(runId) {
  return db.prepare('SELECT * FROM run_step_checks WHERE run_id = ? ORDER BY id ASC').all(runId);
}

module.exports = { CHECKS, getChecksForRun, parseRequiredChecks, runQualityGates, saveManualOverride };
