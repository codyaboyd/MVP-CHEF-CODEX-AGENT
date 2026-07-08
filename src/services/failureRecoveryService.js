const db = require('../db');
const { GitManager, runGit } = require('./gitManagerService');
const runStateManager = require('./runStateManager');

const { STATUSES } = runStateManager;

function nowSql() { return new Date().toISOString(); }

function getRunWithProject(runId) {
  const run = db.prepare(`
    SELECT runs.*, projects.repo_path, projects.default_branch, recipes.name AS recipe_name, projects.name AS project_name
    FROM runs
    LEFT JOIN projects ON projects.id = runs.project_id
    LEFT JOIN recipes ON recipes.id = runs.recipe_id
    WHERE runs.id = ?
  `).get(runId);
  if (!run) throw new Error(`Run ${runId} was not found.`);
  return run;
}

function getStep(runId, stepId) {
  const step = db.prepare('SELECT * FROM run_steps WHERE id = ? AND run_id = ?').get(stepId, runId);
  if (!step) throw new Error(`Run step ${stepId} was not found.`);
  return step;
}

function recordAction(runId, runStepId, action, details = {}) {
  db.prepare(`
    INSERT INTO run_recovery_actions (run_id, run_step_id, action, details_json, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(runId, runStepId || null, action, JSON.stringify(details, null, 2), nowSql());
}

function retryFailedStep(runId, stepId) {
  const step = getStep(runId, stepId);
  if (![STATUSES.FAILED, STATUSES.PAUSED, STATUSES.WAITING_FOR_QUOTA].includes(step.status)) {
    throw new Error('Only failed, paused, or quota-waiting steps can be retried.');
  }
  runStateManager.updateRunStep(stepId, STATUSES.PAUSED, { completed_at: null, approval_point: null, error_message: 'Retry requested by human reviewer.' });
  recordAction(runId, stepId, 'retry_failed_step', { previousStatus: step.status });
  return runStateManager.updateRun(runId, STATUSES.PAUSED, { completed_at: null, error_message: 'Retry requested by human reviewer.' });
}

function continueFromStep(runId, stepId) {
  const selected = getStep(runId, stepId);
  const steps = runStateManager.getRunSteps(runId);
  steps.forEach((step) => {
    if (step.step_order < selected.step_order && ![STATUSES.SUCCEEDED, STATUSES.CANCELLED].includes(step.status)) {
      runStateManager.updateRunStep(step.id, STATUSES.SUCCEEDED, { completed_at: nowSql(), skipped_at: nowSql(), error_message: 'Skipped while continuing from selected step.' });
    }
    if (step.step_order >= selected.step_order && [STATUSES.FAILED, STATUSES.CANCELLED].includes(step.status)) {
      runStateManager.updateRunStep(step.id, STATUSES.PAUSED, { completed_at: null, approval_point: null, error_message: 'Ready to continue from selected step.' });
    }
  });
  recordAction(runId, stepId, 'continue_from_selected_step', { stepOrder: selected.step_order });
  return runStateManager.updateRun(runId, STATUSES.PAUSED, { completed_at: null, error_message: 'Ready to continue from selected step.' });
}

async function rollbackLastStep(runId) {
  const run = getRunWithProject(runId);
  const lastStep = db.prepare(`
    SELECT * FROM run_steps
    WHERE run_id = ? AND status = ? AND commit_sha IS NOT NULL
    ORDER BY step_order DESC LIMIT 1
  `).get(runId, STATUSES.SUCCEEDED);
  if (!lastStep) throw new Error('No committed successful step is available to roll back.');
  if (!run.repo_path) throw new Error('Rollback requires a project repository path.');
  const manager = new GitManager({ repoPath: run.repo_path, mainBranch: run.default_branch });
  await manager.rollbackToCheckpoint(`${lastStep.commit_sha}^`);
  runStateManager.updateRunStep(lastStep.id, STATUSES.PAUSED, { completed_at: null, error_message: 'Rolled back by human reviewer.' });
  recordAction(runId, lastStep.id, 'rollback_last_step', { commitSha: lastStep.commit_sha });
  return runStateManager.updateRun(runId, STATUSES.PAUSED, { completed_at: null, commit_sha: null, error_message: 'Last committed step rolled back.' });
}

async function getDiff(runId, stepId = null) {
  const run = getRunWithProject(runId);
  if (!run.repo_path) return 'No project repository path is configured.';
  const step = stepId ? getStep(runId, stepId) : null;
  if (step?.commit_sha) return (await runGit(run.repo_path, ['show', '--stat', '--patch', '--no-ext-diff', step.commit_sha])).stdout;
  return (await runGit(run.repo_path, ['diff', '--stat', '--patch', '--no-ext-diff'], { allowFailure: true })).stdout || 'No working tree diff is available.';
}

function getLogs(runId, stepId = null) {
  if (stepId) {
    const step = getStep(runId, stepId);
    return { stdout: step.stdout_log || '', stderr: step.stderr_log || '', error: step.error_message || '' };
  }
  const run = runStateManager.getRun(runId);
  const steps = runStateManager.getRunSteps(runId);
  return {
    stdout: [run.stdout_log || '', ...steps.map((step) => step.stdout_log || '')].filter(Boolean).join('\n'),
    stderr: [run.stderr_log || '', ...steps.map((step) => step.stderr_log || '')].filter(Boolean).join('\n'),
    error: run.error_message || ''
  };
}

function exportFailureReport(runId) {
  const run = getRunWithProject(runId);
  const steps = runStateManager.getRunSteps(runId);
  const actions = db.prepare('SELECT * FROM run_recovery_actions WHERE run_id = ? ORDER BY created_at ASC, id ASC').all(runId);
  return { exportedAt: nowSql(), run, steps, recoveryActions: actions, logs: getLogs(runId) };
}

module.exports = { continueFromStep, exportFailureReport, getDiff, getLogs, recordAction, retryFailedStep, rollbackLastStep };
