const db = require('../db');
const codexRunner = require('./codexRunnerService');
const recipeService = require('./recipeService');
const runStateManager = require('./runStateManager');

const { STATUSES } = runStateManager;

function nowSql() {
  return new Date().toISOString();
}

function getProject(projectId) {
  if (!projectId) return null;
  return db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) || null;
}

function createRunRecords(recipe) {
  runStateManager.assertProjectAvailable(recipe.project_id);

  const create = db.transaction(() => {
    const run = db.prepare(`
      INSERT INTO runs (project_id, recipe_id, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(recipe.project_id, recipe.id, STATUSES.PENDING, nowSql(), nowSql());

    const insertStep = db.prepare(`
      INSERT INTO run_steps (run_id, recipe_step_id, step_order, status, created_at, updated_at)
      VALUES (@runId, @recipeStepId, @stepOrder, @status, @createdAt, @updatedAt)
    `);

    recipe.steps.forEach((step) => {
      insertStep.run({
        runId: run.lastInsertRowid,
        recipeStepId: step.id,
        stepOrder: step.step_order || step.orderIndex,
        status: STATUSES.PENDING,
        createdAt: nowSql(),
        updatedAt: nowSql()
      });
    });

    return run.lastInsertRowid;
  });

  return runStateManager.getRun(create());
}

function findResumeStep(steps) {
  return steps.find((step) => [STATUSES.FAILED, STATUSES.PAUSED, STATUSES.PENDING, STATUSES.WAITING_FOR_QUOTA, STATUSES.WAITING_FOR_APPROVAL].includes(step.status));
}

async function executeRun(runId, options = {}) {
  const run = runStateManager.getRun(runId);
  if (!run) throw new Error(`Run ${runId} was not found.`);
  runStateManager.assertProjectAvailable(run.project_id, runId);

  const recipe = recipeService.getRecipeById(run.recipe_id);
  if (!recipe) throw new Error(`Recipe ${run.recipe_id} was not found.`);
  const project = getProject(run.project_id);
  if (!project) throw new Error(`Project ${run.project_id} was not found.`);

  let runSteps = runStateManager.getRunSteps(runId);
  let nextStep = findResumeStep(runSteps);
  if (!nextStep) {
    return runStateManager.updateRun(runId, STATUSES.SUCCEEDED, { completed_at: nowSql(), error_message: null });
  }

  runStateManager.updateRun(runId, STATUSES.RUNNING, { started_at: run.started_at || nowSql(), completed_at: null, error_message: null });

  while (nextStep) {
    const latestRun = runStateManager.getRun(runId);
    if (latestRun.status === STATUSES.CANCELLED) return latestRun;

    const recipeStep = recipe.steps.find((step) => step.id === nextStep.recipe_step_id);
    if (!recipeStep) throw new Error(`Recipe step ${nextStep.recipe_step_id} was not found.`);

    if (recipeStep.humanApproval && nextStep.status === STATUSES.PENDING) {
      runStateManager.updateRunStep(nextStep.id, STATUSES.WAITING_FOR_APPROVAL, { started_at: nowSql() });
      return runStateManager.updateRun(runId, STATUSES.WAITING_FOR_APPROVAL, { error_message: 'Waiting for human approval.' });
    }

    try {
      await codexRunner.executeStep({
        runId,
        runStepId: nextStep.id,
        repoPath: project.repo_path,
        prompt: recipeStep.prompt,
        retries: recipeStep.retryCount,
        mockMode: options.mockMode ?? 'auto',
        codexCommand: options.codexCommand,
        codexArgs: options.codexArgs,
        timeoutMs: options.timeoutMs
      });
      runStateManager.updateRunStep(nextStep.id, STATUSES.SUCCEEDED, { completed_at: nowSql(), error_message: null });
      runStateManager.updateRun(runId, STATUSES.RUNNING, { completed_at: null, error_message: null });
    } catch (error) {
      if (/quota|rate limit/i.test(error.message)) {
        runStateManager.updateRunStep(nextStep.id, STATUSES.WAITING_FOR_QUOTA, { error_message: error.message });
        return runStateManager.updateRun(runId, STATUSES.WAITING_FOR_QUOTA, { error_message: error.message });
      }
      runStateManager.updateRunStep(nextStep.id, STATUSES.FAILED, { completed_at: nowSql(), error_message: error.message });
      return runStateManager.updateRun(runId, STATUSES.FAILED, { completed_at: nowSql(), error_message: error.message });
    }

    runSteps = runStateManager.getRunSteps(runId);
    nextStep = findResumeStep(runSteps);
  }

  return runStateManager.updateRun(runId, STATUSES.SUCCEEDED, { completed_at: nowSql(), error_message: null });
}

async function startRunFromRecipe(recipeId, options = {}) {
  const recipe = recipeService.getRecipeById(Number(recipeId));
  if (!recipe) throw new Error(`Recipe ${recipeId} was not found.`);
  if (!recipe.project_id) throw new Error('Recipe must be associated with a project before it can run.');

  const run = createRunRecords(recipe);
  if (options.autoExecute === false) return run;
  return executeRun(run.id, options);
}

async function resumeRun(runId, options = {}) {
  const run = runStateManager.getRun(runId);
  if (!run) throw new Error(`Run ${runId} was not found.`);
  const step = findResumeStep(runStateManager.getRunSteps(runId));
  if (!step) return run;
  if (step.status === STATUSES.WAITING_FOR_APPROVAL && !options.approved) {
    return runStateManager.updateRun(runId, STATUSES.WAITING_FOR_APPROVAL, { error_message: 'Waiting for human approval.' });
  }
  if (step.status === STATUSES.WAITING_FOR_APPROVAL && options.approved) {
    runStateManager.updateRunStep(step.id, STATUSES.PAUSED, { error_message: null });
  }
  return executeRun(runId, options);
}

module.exports = {
  RecipeRunEngine: { executeRun, resumeRun, startRunFromRecipe },
  executeRun,
  resumeRun,
  startRunFromRecipe
};
