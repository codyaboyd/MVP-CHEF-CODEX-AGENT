const db = require('../db');
const recipeService = require('./recipeService');
const projectService = require('./projectService');

function getProjects() {
  return projectService.getProjects();
}


function getRuns() {
  return db.prepare(`
    SELECT runs.*, recipes.name AS recipe_name, projects.name AS project_name
    FROM runs
    LEFT JOIN recipes ON recipes.id = runs.recipe_id
    LEFT JOIN projects ON projects.id = runs.project_id
    ORDER BY runs.created_at DESC, runs.id ASC
  `).all();
}

function getRunById(id) {
  const run = db.prepare(`
    SELECT runs.*, recipes.name AS recipe_name, projects.name AS project_name
    FROM runs
    LEFT JOIN recipes ON recipes.id = runs.recipe_id
    LEFT JOIN projects ON projects.id = runs.project_id
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
    const checks = db.prepare('SELECT * FROM run_step_checks WHERE run_id = ? ORDER BY id ASC').all(id);
    const checksByStep = checks.reduce((groups, check) => {
      groups[check.run_step_id] = groups[check.run_step_id] || [];
      groups[check.run_step_id].push(check);
      return groups;
    }, {});
    run.steps = run.steps.map((step) => ({ ...step, checks: checksByStep[step.id] || [] }));
  }

  return run;
}


function countAttempts(step) {
  const logs = `${step.stdout_log || ''}\n${step.stderr_log || ''}`;
  const matches = logs.match(/\[CodexRunner\] Attempt \d+ of \d+\./g);
  return matches ? matches.length : 0;
}

function calculateProgress(steps = []) {
  if (!steps.length) return 0;
  const completed = steps.filter((step) => ['succeeded', 'failed', 'cancelled'].includes(step.status)).length;
  return Math.round((completed / steps.length) * 100);
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
    requiredChecks: step.required_checks || '',
    qualityGateOverride: Boolean(step.quality_gate_override),
    qualityGateOverrideReason: step.quality_gate_override_reason || '',
    checks: (step.checks || []).map((check) => ({
      id: check.id,
      name: check.check_name,
      command: check.command,
      required: Boolean(check.required),
      status: check.status,
      exitCode: check.exit_code,
      stdout: check.stdout_log || '',
      stderr: check.stderr_log || '',
      startedAt: check.started_at,
      completedAt: check.completed_at
    })),
    startedAt: step.started_at,
    completedAt: step.completed_at,
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
    prUrl: run.pr_url,
    errorMessage: run.error_message || '',
    progress: calculateProgress(steps),
    currentStep,
    stdout: [run.stdout_log || '', ...steps.map((step) => step.stdout)].filter(Boolean).join('\n'),
    stderr: [run.stderr_log || '', ...steps.map((step) => step.stderr)].filter(Boolean).join('\n'),
    retryAttempts: steps.reduce((total, step) => total + step.retryAttempts, 0),
    steps,
    updatedAt: run.updated_at
  };
}

function getSettings() {
  return db.prepare('SELECT * FROM app_settings ORDER BY key ASC').all();
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
  getDashboard,
  getProjects,
  getRunById,
  getRunSnapshot,
  getRuns,
  getSettings
};
