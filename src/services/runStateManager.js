const db = require('../db');
const codexRunner = require('./codexRunnerService');

const STATUSES = Object.freeze({
  PENDING: 'pending',
  RUNNING: 'running',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  PAUSED: 'paused',
  CANCELLED: 'cancelled',
  WAITING_FOR_QUOTA: 'waiting_for_quota',
  WAITING_FOR_APPROVAL: 'waiting_for_approval'
});

const ACTIVE_RUN_STATUSES = [
  STATUSES.PENDING,
  STATUSES.RUNNING,
  STATUSES.PAUSED,
  STATUSES.WAITING_FOR_QUOTA,
  STATUSES.WAITING_FOR_APPROVAL
];

function nowSql() {
  return new Date().toISOString();
}

function assertStatus(status) {
  if (!Object.values(STATUSES).includes(status)) {
    throw new Error(`Unsupported run status: ${status}`);
  }
}

function getRun(runId) {
  return db.prepare('SELECT * FROM runs WHERE id = ?').get(runId);
}

function getRunSteps(runId) {
  return db.prepare('SELECT * FROM run_steps WHERE run_id = ? ORDER BY step_order ASC').all(runId);
}

function updateRun(runId, status, patch = {}) {
  assertStatus(status);
  const current = getRun(runId);
  if (!current) {
    throw new Error(`Run ${runId} was not found.`);
  }

  db.prepare(`
    UPDATE runs
    SET status = @status,
        stdout_log = @stdout_log,
        stderr_log = @stderr_log,
        commit_sha = @commit_sha,
        pr_url = @pr_url,
        error_message = @error_message,
        started_at = @started_at,
        completed_at = @completed_at,
        updated_at = @updated_at
    WHERE id = @id
  `).run({
    ...current,
    ...patch,
    status,
    updated_at: nowSql()
  });

  return getRun(runId);
}

function updateRunStep(runStepId, status, patch = {}) {
  assertStatus(status);
  const current = db.prepare('SELECT * FROM run_steps WHERE id = ?').get(runStepId);
  if (!current) {
    throw new Error(`Run step ${runStepId} was not found.`);
  }

  db.prepare(`
    UPDATE run_steps
    SET status = @status,
        stdout_log = @stdout_log,
        stderr_log = @stderr_log,
        commit_sha = @commit_sha,
        error_message = @error_message,
        started_at = @started_at,
        completed_at = @completed_at,
        updated_at = @updated_at
    WHERE id = @id
  `).run({
    ...current,
    ...patch,
    status,
    updated_at: nowSql()
  });
}

function activeRunForProject(projectId, exceptRunId = null) {
  if (!projectId) return null;
  const placeholders = ACTIVE_RUN_STATUSES.map(() => '?').join(', ');
  const params = [projectId, ...ACTIVE_RUN_STATUSES];
  let sql = `SELECT * FROM runs WHERE project_id = ? AND status IN (${placeholders})`;
  if (exceptRunId) {
    sql += ' AND id != ?';
    params.push(exceptRunId);
  }
  sql += ' ORDER BY created_at ASC, id ASC LIMIT 1';
  return db.prepare(sql).get(...params) || null;
}

function assertProjectAvailable(projectId, exceptRunId = null) {
  const activeRun = activeRunForProject(projectId, exceptRunId);
  if (activeRun) {
    const error = new Error(`Project ${projectId} already has active run ${activeRun.id}.`);
    error.code = 'PROJECT_RUN_LOCKED';
    error.activeRun = activeRun;
    throw error;
  }
}

function cancelRun(runId) {
  const run = getRun(runId);
  if (!run) {
    throw new Error(`Run ${runId} was not found.`);
  }

  const steps = getRunSteps(runId);
  steps
    .filter((step) => [STATUSES.PENDING, STATUSES.RUNNING, STATUSES.PAUSED, STATUSES.WAITING_FOR_QUOTA, STATUSES.WAITING_FOR_APPROVAL].includes(step.status))
    .forEach((step) => {
      codexRunner.cancel(step.id);
      updateRunStep(step.id, STATUSES.CANCELLED, {
        completed_at: nowSql(),
        error_message: step.error_message || 'Cancelled by user.'
      });
    });

  return updateRun(runId, STATUSES.CANCELLED, {
    completed_at: nowSql(),
    error_message: run.error_message || 'Cancelled by user.'
  });
}

module.exports = {
  ACTIVE_RUN_STATUSES,
  STATUSES,
  activeRunForProject,
  assertProjectAvailable,
  cancelRun,
  getRun,
  getRunSteps,
  updateRun,
  updateRunStep
};
