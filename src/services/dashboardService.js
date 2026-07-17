const db = require('../db');
const recipeService = require('./recipeService');
const projectService = require('./projectService');
const appSettingsService = require('./appSettingsService');

function getProjects() {
  return projectService.getProjects();
}


function getRuns() {
  return db.prepare(`
    SELECT runs.*, recipes.name AS recipe_name, projects.name AS project_name,
           project_run_locks.owner AS lock_owner, project_run_locks.expires_at AS lock_expires_at
    FROM runs
    LEFT JOIN recipes ON recipes.id = runs.recipe_id
    LEFT JOIN projects ON projects.id = runs.project_id
    LEFT JOIN project_run_locks ON project_run_locks.project_id = runs.project_id AND project_run_locks.run_id = runs.id
    ORDER BY runs.created_at DESC, runs.id ASC
  `).all();
}

function getRunById(id) {
  const run = db.prepare(`
    SELECT runs.*, recipes.name AS recipe_name, projects.name AS project_name,
           project_run_locks.owner AS lock_owner, project_run_locks.expires_at AS lock_expires_at
    FROM runs
    LEFT JOIN recipes ON recipes.id = runs.recipe_id
    LEFT JOIN projects ON projects.id = runs.project_id
    LEFT JOIN project_run_locks ON project_run_locks.project_id = runs.project_id AND project_run_locks.run_id = runs.id
    WHERE runs.id = ?
  `).get(id);

  if (run) {
    run.steps = db.prepare(`
      SELECT run_steps.*, recipe_steps.title AS recipe_step_title, recipe_steps.prompt, recipe_steps.retry_count, recipe_steps.required_checks
      FROM run_steps
      LEFT JOIN recipe_steps ON recipe_steps.id = run_steps.recipe_step_id
      WHERE run_steps.run_id = ?
      ORDER BY run_steps.step_order ASC
    `).all(id);
  }

  return run;
}


function countAttempts(step) {
  const logs = `${step.stdout_log || ''}\n${step.stderr_log || ''}`;
  const matches = logs.match(/\[CodexRunner\] Attempt \d+ of \d+\./g);
  return matches ? matches.length : 0;
}

function calculateProgress(steps = [], runStatus = '') {
  if (runStatus === 'succeeded') return 100;
  const logs = steps.map((step) => step.stdout || step.stdout_log || '').join('\n');
  const completedItems = logs.split(/\r?\n/).reduce((count, line) => {
    try {
      return count + (JSON.parse(line).type === 'item.completed' ? 1 : 0);
    } catch {
      return count;
    }
  }, 0);
  return Math.min(completedItems * 3, 99);
}

function getCurrentStep(steps = []) {
  return steps.find((step) => ['running', 'waiting_for_quota', 'waiting_for_approval', 'paused'].includes(step.status))
    || steps.find((step) => step.status === 'pending')
    || steps[steps.length - 1]
    || null;
}

function normalizeStepForSnapshot(step) {
  return {
    id: step.id,
    order: step.step_order,
    title: step.recipe_step_title || step.title || `Step ${step.step_order}`,
    prompt: step.prompt || '',
    status: step.status,
    stdout: step.stdout_log || '',
    stderr: step.stderr_log || '',
    retryAttempts: countAttempts(step),
    maxRetries: Number(step.retry_count || 0),
    errorMessage: step.error_message || '',
    approvalPoint: step.approval_point || '',
    promptOverride: step.prompt_override || '',
    skippedAt: step.skipped_at || null,
    startedAt: step.started_at,
    completedAt: step.completed_at,
    quotaRefillAt: step.quota_refill_at,
    quotaRetryCount: Number(step.quota_retry_count || 0),
    updatedAt: step.updated_at
  };
}

function getRunSnapshot(id) {
  const run = getRunById(id);
  if (!run) return null;
  const steps = (run.steps || []).map(normalizeStepForSnapshot);
  const currentStep = getCurrentStep(steps);
  return {
    id: run.id,
    recipeName: run.recipe_name || 'Recipe run',
    projectName: run.project_name || 'a project pantry',
    status: run.status,
    commitSha: run.commit_sha,
    errorMessage: run.error_message || '',
    quotaStatus: {
      waiting: run.status === 'waiting_for_quota',
      refillAt: run.quota_refill_at,
      retryCount: Number(run.quota_retry_count || 0),
      message: run.status === 'waiting_for_quota' ? (run.error_message || 'Waiting for quota refill.') : ''
    },
    progress: calculateProgress(steps, run.status),
    currentStep,
    stdout: [run.stdout_log || '', ...steps.map((step) => step.stdout)].filter(Boolean).join('\n'),
    stderr: [run.stderr_log || '', ...steps.map((step) => step.stderr)].filter(Boolean).join('\n'),
    retryAttempts: steps.reduce((total, step) => total + step.retryAttempts, 0),
    steps,
    updatedAt: run.updated_at
  };
}

function getSettings() {
  return appSettingsService.getSettings();
}

function getDashboard() {
  const recipes = recipeService.getAllRecipes();
  const projects = getProjects();
  const runs = getRuns();
  const succeededRuns = runs.filter((run) => run.status === 'succeeded').length;
  const progress = runs.length ? Math.round((succeededRuns / runs.length) * 100) : 68;

  return {
    recipes,
    projects,
    runs,
    stats: {
      recipes: recipes.length,
      projects: projects.length,
      runs: runs.length,
      progress
    }
  };
}

module.exports = {
  calculateProgress,
  getDashboard,
  getProjects,
  getRunById,
  getRunSnapshot,
  getRuns,
  getSettings
};
