const os = require('node:os');
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

const TERMINAL_RUN_STATUSES = [STATUSES.SUCCEEDED, STATUSES.FAILED, STATUSES.CANCELLED];

function nowSql() {
  return new Date().toISOString();
}

function lockOwner() {
  return `${os.hostname()}:pid-${process.pid}`;
}

function expiresAt(ttlMs = 5 * 60 * 1000) {
  return new Date(Date.now() + ttlMs).toISOString();
}

function cleanupStaleLocks(referenceDate = new Date()) {
  return db.prepare('DELETE FROM project_run_locks WHERE expires_at <= ?').run(referenceDate.toISOString()).changes;
}

function getProjectLock(projectId) {
  if (!projectId) return null;
  cleanupStaleLocks();
  return db.prepare('SELECT * FROM project_run_locks WHERE project_id = ?').get(projectId) || null;
}

function acquireProjectLock(projectId, runId, { ttlMs, owner } = {}) {
  if (!projectId) return null;
  cleanupStaleLocks();
  const existing = db.prepare('SELECT * FROM project_run_locks WHERE project_id = ?').get(projectId);
  if (existing && Number(existing.run_id) !== Number(runId)) {
    const error = new Error(`Project ${projectId} is locked by run ${existing.run_id} (${existing.owner}).`);
    error.code = 'PROJECT_RUN_LOCKED';
    error.lock = existing;
    throw error;
  }
  const timestamp = nowSql();
  const lock = { projectId, runId, owner: owner || lockOwner(), acquiredAt: existing?.acquired_at || timestamp, heartbeatAt: timestamp, expiresAt: expiresAt(ttlMs) };
  db.prepare(`
    INSERT INTO project_run_locks (project_id, run_id, owner, acquired_at, heartbeat_at, expires_at, updated_at)
    VALUES (@projectId, @runId, @owner, @acquiredAt, @heartbeatAt, @expiresAt, @heartbeatAt)
    ON CONFLICT(project_id) DO UPDATE SET
      run_id = excluded.run_id,
      owner = excluded.owner,
      heartbeat_at = excluded.heartbeat_at,
      expires_at = excluded.expires_at,
      updated_at = excluded.updated_at
  `).run(lock);
  return getProjectLock(projectId);
}

function refreshProjectLock(projectId, runId, options = {}) {
  const lock = acquireProjectLock(projectId, runId, options);
  return lock;
}

function assertRunOwnsProjectLock(projectId, runId) {
  if (!projectId) return true;
  const lock = getProjectLock(projectId);
  if (!lock || Number(lock.run_id) !== Number(runId)) {
    const error = new Error(`Run ${runId} does not own the active project lock for project ${projectId}; git operations are blocked.`);
    error.code = 'PROJECT_RUN_LOCK_REQUIRED';
    error.lock = lock;
    throw error;
  }
  return true;
}

function releaseProjectLock(projectId, runId) {
  if (!projectId) return 0;
  return db.prepare('DELETE FROM project_run_locks WHERE project_id = ? AND run_id = ?').run(projectId, runId).changes;
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

  const nextRun = {
    ...current,
    ...patch,
    status,
    updated_at: nowSql()
  };

  db.prepare(`
    UPDATE runs
    SET status = @status,
        stdout_log = @stdout_log,
        stderr_log = @stderr_log,
        commit_sha = @commit_sha,
        error_message = @error_message,
        started_at = @started_at,
        completed_at = @completed_at,
        quota_refill_at = @quota_refill_at,
        quota_retry_count = @quota_retry_count,
        updated_at = @updated_at
    WHERE id = @id
  `).run(nextRun);

  if (TERMINAL_RUN_STATUSES.includes(status)) {
    releaseProjectLock(current.project_id, runId);
  }

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
        quota_refill_at = @quota_refill_at,
        quota_retry_count = @quota_retry_count,
        approval_point = @approval_point,
        prompt_override = @prompt_override,
        skipped_at = @skipped_at,
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
  cleanupStaleLocks();
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
  const activeLock = getProjectLock(projectId);
  if (activeLock && Number(activeLock.run_id) !== Number(exceptRunId)) {
    const error = new Error(`Project ${projectId} is locked by run ${activeLock.run_id} (${activeLock.owner}).`);
    error.code = 'PROJECT_RUN_LOCKED';
    error.lock = activeLock;
    throw error;
  }
  const activeRun = activeRunForProject(projectId, exceptRunId);
  if (activeRun) {
    const error = new Error(`Project ${projectId} already has active run ${activeRun.id}.`);
    error.code = 'PROJECT_RUN_LOCKED';
    error.activeRun = activeRun;
    throw error;
  }
}


function pauseRun(runId) {
  const run = getRun(runId);
  if (!run) {
    throw new Error(`Run ${runId} was not found.`);
  }

  const steps = getRunSteps(runId);
  steps
    .filter((step) => [STATUSES.PENDING, STATUSES.RUNNING, STATUSES.WAITING_FOR_QUOTA, STATUSES.WAITING_FOR_APPROVAL].includes(step.status))
    .forEach((step) => {
      updateRunStep(step.id, STATUSES.PAUSED, {
        error_message: step.error_message || 'Paused by user.'
      });
    });

  return updateRun(runId, STATUSES.PAUSED, {
    error_message: run.error_message || 'Paused by user.'
  });
}

function recoverInterruptedRuns() {
  const interruptedRuns = db.prepare('SELECT * FROM runs WHERE status = ?').all(STATUSES.RUNNING);
  interruptedRuns.forEach((run) => {
    getRunSteps(run.id)
      .filter((step) => step.status === STATUSES.RUNNING)
      .forEach((step) => updateRunStep(step.id, STATUSES.PAUSED, {
        completed_at: null,
        error_message: step.error_message || 'Server restarted during this step; ready to resume.'
      }));
    updateRun(run.id, STATUSES.PAUSED, {
      completed_at: null,
      error_message: run.error_message || 'Server restarted during this run; ready to resume.'
    });
  });
  return interruptedRuns.length;
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

  const cancelled = updateRun(runId, STATUSES.CANCELLED, {
    completed_at: nowSql(),
    error_message: run.error_message || 'Cancelled by user.'
  });
  releaseProjectLock(run.project_id, runId);
  return cancelled;
}

module.exports = {
  ACTIVE_RUN_STATUSES,
  STATUSES,
  TERMINAL_RUN_STATUSES,
  acquireProjectLock,
  activeRunForProject,
  assertProjectAvailable,
  assertRunOwnsProjectLock,
  cleanupStaleLocks,
  cancelRun,
  getProjectLock,
  getRun,
  getRunSteps,
  pauseRun,
  recoverInterruptedRuns,
  refreshProjectLock,
  releaseProjectLock,
  updateRun,
  updateRunStep
};
