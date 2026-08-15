const db = require('../db');
const codexRunner = require('./codexRunnerService');
const recipeService = require('./recipeService');
const runStateManager = require('./runStateManager');
const { GitManager } = require('./gitManagerService');
const appSettingsService = require('./appSettingsService');
const promptLintService = require('./promptLintService');
const failureRecoveryService = require('./failureRecoveryService');

const { STATUSES } = runStateManager;

const quotaResumeTimers = new Map();
const LOCK_HEARTBEAT_INTERVAL_MS = 60 * 1000;

async function withProjectLockHeartbeat(projectId, runId, task) {
  const heartbeat = setInterval(() => {
    // Keep a long-running Codex turn from outliving the five-minute lock lease.
    // A refresh failure is surfaced by the ownership check after Codex exits.
    try {
      runStateManager.refreshProjectLock(projectId, runId);
    } catch {
      clearInterval(heartbeat);
    }
  }, LOCK_HEARTBEAT_INTERVAL_MS);
  heartbeat.unref();
  try {
    return await task();
  } finally {
    clearInterval(heartbeat);
  }
}

function getRefillTime(settings, override) {
  if (override) return new Date(override).toISOString();
  return new Date(Date.now() + settings.defaultCooldownMinutes * 60 * 1000).toISOString();
}

function scheduleQuotaResume(runId, refillAt, options = {}) {
  const delayMs = new Date(refillAt).getTime() - Date.now();
  if (!Number.isFinite(delayMs) || delayMs <= 0) return;
  if (quotaResumeTimers.has(runId)) clearTimeout(quotaResumeTimers.get(runId));
  const timer = setTimeout(() => {
    quotaResumeTimers.delete(runId);
    resumeRun(runId, { ...options, quotaCooldownElapsed: true }).catch(() => {});
  }, delayMs);
  timer.unref();
  quotaResumeTimers.set(runId, timer);
}

function pauseForQuota({ runId, stepId, error, options }) {
  const quotaSettings = appSettingsService.getQuotaSettings(options);
  const run = runStateManager.getRun(runId);
  const retryCount = Number(run.quota_retry_count || 0);
  const refillAt = getRefillTime(quotaSettings, options.quotaRefillAt);
  const message = `${error.message} Recipe paused until quota refills.`;
  runStateManager.updateRunStep(stepId, STATUSES.WAITING_FOR_QUOTA, {
    error_message: message,
    quota_refill_at: refillAt,
    quota_retry_count: retryCount
  });
  const updated = runStateManager.updateRun(runId, STATUSES.WAITING_FOR_QUOTA, {
    error_message: message,
    quota_refill_at: refillAt,
    quota_retry_count: retryCount
  });
  if (quotaSettings.autoResumeAfterCooldown && retryCount < quotaSettings.maxRetriesAfterQuota) {
    scheduleQuotaResume(runId, refillAt, options);
  }
  return updated;
}

function nowSql() {
  return new Date().toISOString();
}




function lintPromptBeforeStep({ runId, nextStep, recipeStep, project }) {
  const stepPrompt = nextStep.prompt_override || recipeStep.prompt;
  const promptWarnings = promptLintService.lintPrompt(stepPrompt);
  if (!promptWarnings.length) return { blocked: false, nextStep, stepPrompt };

  const warningLog = `${promptLintService.formatWarnings(promptWarnings)}\n`;
  runStateManager.updateRunStep(nextStep.id, project.safe_mode ? STATUSES.FAILED : nextStep.status, {
    stdout_log: `${nextStep.stdout_log || ''}${warningLog}`,
    error_message: project.safe_mode ? 'Safe mode blocked this recipe step because prompt lint warnings were found.' : nextStep.error_message
  });
  if (project.safe_mode) {
    runStateManager.updateRun(runId, STATUSES.FAILED, {
      error_message: 'Safe mode blocked this recipe run because prompt lint warnings were found.',
      completed_at: nowSql()
    });
    return { blocked: true, nextStep, stepPrompt };
  }
  return { blocked: false, nextStep: { ...nextStep, stdout_log: `${nextStep.stdout_log || ''}${warningLog}` }, stepPrompt };
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

    const runId = run.lastInsertRowid;
    runStateManager.acquireProjectLock(recipe.project_id, runId);
    return runId;
  });

  return runStateManager.getRun(create());
}

function findResumeStep(steps) {
  return steps.find((step) => [STATUSES.FAILED, STATUSES.PAUSED, STATUSES.PENDING, STATUSES.WAITING_FOR_QUOTA, STATUSES.WAITING_FOR_APPROVAL].includes(step.status));
}

function skipRunStep(runId, runStepId) {
  runStateManager.updateRunStep(runStepId, STATUSES.SUCCEEDED, {
    completed_at: nowSql(),
    skipped_at: nowSql(),
    error_message: 'Skipped by operator.'
  });
  failureRecoveryService.recordAction(runId, runStepId, 'skip_failed_step', { reason: 'Skipped by operator.' });
  return runStateManager.updateRun(runId, STATUSES.PAUSED, { error_message: 'Step skipped by operator.' });
}


function editPromptAndRetry(runId, runStepId, prompt) {
  if (!prompt || !prompt.trim()) throw new Error('Edited prompt is required.');
  runStateManager.updateRunStep(runStepId, STATUSES.PAUSED, {
    prompt_override: prompt.trim(),
    approval_point: null,
    error_message: 'Prompt edited; ready to retry.'
  });
  failureRecoveryService.recordAction(runId, runStepId, 'edit_failed_prompt_and_retry', { prompt: prompt.trim() });
  return runStateManager.updateRun(runId, STATUSES.PAUSED, { error_message: 'Prompt edited; ready to retry.' });
}

function addPromptToRun(runId, prompt) {
  const normalizedPrompt = String(prompt || '').trim();
  if (!normalizedPrompt) throw new Error('Prompt is required.');

  const insert = db.transaction(() => {
    const run = runStateManager.getRun(runId);
    if (!run) throw new Error(`Run ${runId} was not found.`);
    if (![STATUSES.PENDING, STATUSES.RUNNING, STATUSES.PAUSED, STATUSES.WAITING_FOR_QUOTA].includes(run.status)) {
      const error = new Error(`Prompts cannot be added to a ${run.status} run.`);
      error.code = 'RUN_NOT_ACTIVE';
      throw error;
    }

    const currentOrder = db.prepare(`
      SELECT COALESCE(MAX(step_order), 0) AS step_order
      FROM run_steps
      WHERE run_id = ? AND status = ?
    `).get(runId, STATUSES.RUNNING).step_order;
    const nextOrder = db.prepare('SELECT COALESCE(MAX(step_order), 0) + 1 AS step_order FROM run_steps WHERE run_id = ?')
      .get(runId).step_order;
    if (nextOrder <= currentOrder) throw new Error('The new prompt must be placed after the currently running step.');

    const result = db.prepare(`
      INSERT INTO run_steps (run_id, recipe_step_id, step_order, status, prompt_override, created_at, updated_at)
      VALUES (?, NULL, ?, ?, ?, ?, ?)
    `).run(runId, nextOrder, STATUSES.PENDING, normalizedPrompt, nowSql(), nowSql());
    return db.prepare('SELECT * FROM run_steps WHERE id = ?').get(result.lastInsertRowid);
  });

  return insert();
}

async function executeRun(runId, options = {}) {
  const run = runStateManager.getRun(runId);
  if (!run) throw new Error(`Run ${runId} was not found.`);
  runStateManager.assertProjectAvailable(run.project_id, runId);
  runStateManager.refreshProjectLock(run.project_id, runId);

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

  const gitManager = options.gitEnabled ? new GitManager({ repoPath: project.repo_path, mainBranch: project.default_branch }) : null;
  if (gitManager) {
    runStateManager.assertRunOwnsProjectLock(run.project_id, runId);
    await gitManager.assertCleanWorkingTree();
  }

  while (nextStep) {
    const latestRun = runStateManager.getRun(runId);
    if (latestRun.status === STATUSES.CANCELLED) return latestRun;

    const recipeStep = recipe.steps.find((step) => step.id === nextStep.recipe_step_id) || {
      id: null,
      title: `Added prompt ${nextStep.step_order}`,
      prompt: nextStep.prompt_override,
      retryCount: 0
    };


    const lintResult = lintPromptBeforeStep({ runId, nextStep, recipeStep, project });
    if (lintResult.blocked) return runStateManager.getRun(runId);
    nextStep = lintResult.nextStep;
    const stepPrompt = lintResult.stepPrompt;


    // Automatically continue runs saved with the retired approval status.
    if (nextStep.status === STATUSES.WAITING_FOR_APPROVAL) {
      runStateManager.updateRunStep(nextStep.id, STATUSES.PAUSED, { approval_point: null, error_message: null });
      nextStep = { ...nextStep, status: STATUSES.PAUSED, approval_point: null };
    }

    let checkpointSha = null;

    try {
      if (gitManager) {
        runStateManager.refreshProjectLock(run.project_id, runId);
        runStateManager.assertRunOwnsProjectLock(run.project_id, runId);
        checkpointSha = await gitManager.getCurrentSha();
        await gitManager.createBranchForStep({ runId, stepId: nextStep.id, stepTitle: recipeStep.title });
      }

      await withProjectLockHeartbeat(run.project_id, runId, () => codexRunner.executeStep({
        runId,
        runStepId: nextStep.id,
        repoPath: project.repo_path,
        prompt: stepPrompt,
        retries: recipeStep.retryCount,
        codexCommand: options.codexCommand ?? appSettingsService.getSetting('codexCommandPath')?.value,
        codexArgs: options.codexArgs,
        codexModel: options.codexModel ?? appSettingsService.getSetting('codexModel')?.value,
        codexReasoningEffort: options.codexReasoningEffort ?? appSettingsService.getSetting('codexReasoningEffort')?.value,
        codexSandboxMode: options.codexSandboxMode ?? appSettingsService.getSetting('codexSandboxMode')?.value
      }));


      if (gitManager) runStateManager.assertRunOwnsProjectLock(run.project_id, runId);
      const gitResult = gitManager
        ? await gitManager.commitStep({ runId, stepId: nextStep.id, stepTitle: recipeStep.title })
        : null;
      if (gitManager && gitResult.committed) {
        await gitManager.assertNoSecretsInCommit(gitResult.commitSha);
      }
      runStateManager.updateRunStep(nextStep.id, STATUSES.SUCCEEDED, {
        completed_at: nowSql(),
        error_message: null,
        commit_sha: gitResult?.commitSha || nextStep.commit_sha || null
      });
      runStateManager.updateRun(runId, STATUSES.RUNNING, {
        completed_at: null,
        error_message: null,
        commit_sha: gitResult?.commitSha || latestRun.commit_sha || null
      });
    } catch (error) {
      if (gitManager && checkpointSha) {
        try {
          await gitManager.rollbackToCheckpoint(checkpointSha);
        } catch (rollbackError) {
          error.message = `${error.message}
Rollback failed: ${rollbackError.message}`;
        }
      }
      if (error.code === 'QUOTA_LIMIT_DETECTED' || codexRunner.detectQuotaLimit(error.message, error.result?.stdout, error.result?.stderr)) {
        return pauseForQuota({ runId, stepId: nextStep.id, error, options });
      }
      runStateManager.updateRunStep(nextStep.id, STATUSES.FAILED, { completed_at: nowSql(), error_message: error.message });
      const failed = runStateManager.updateRun(runId, STATUSES.FAILED, { completed_at: nowSql(), error_message: error.message });
      runStateManager.releaseProjectLock(run.project_id, runId);
      return failed;
    }

    runSteps = runStateManager.getRunSteps(runId);
    nextStep = findResumeStep(runSteps);
  }

  const succeeded = runStateManager.updateRun(runId, STATUSES.SUCCEEDED, { completed_at: nowSql(), error_message: null });
  runStateManager.releaseProjectLock(run.project_id, runId);
  return succeeded;
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
  if (step.status === STATUSES.WAITING_FOR_QUOTA) {
    const quotaSettings = appSettingsService.getQuotaSettings(options);
    const retryCount = Number(run.quota_retry_count || 0);
    const refillDue = !run.quota_refill_at || new Date(run.quota_refill_at).getTime() <= Date.now();
    if (!options.quotaCooldownElapsed && !refillDue) {
      if (quotaSettings.autoResumeAfterCooldown && retryCount < quotaSettings.maxRetriesAfterQuota) scheduleQuotaResume(runId, run.quota_refill_at, options);
      return runStateManager.updateRun(runId, STATUSES.WAITING_FOR_QUOTA, { error_message: run.error_message || 'Waiting for quota refill.' });
    }
    if (retryCount >= quotaSettings.maxRetriesAfterQuota) {
      return runStateManager.updateRun(runId, STATUSES.WAITING_FOR_QUOTA, { error_message: 'Maximum quota retry attempts reached.' });
    }
    runStateManager.updateRunStep(step.id, STATUSES.PAUSED, { error_message: null, quota_retry_count: retryCount + 1 });
    runStateManager.updateRun(runId, STATUSES.PAUSED, { error_message: null, quota_retry_count: retryCount + 1 });
  }
  if (step.status === STATUSES.WAITING_FOR_APPROVAL) {
    runStateManager.updateRunStep(step.id, STATUSES.PAUSED, { error_message: null });
  }
  return executeRun(runId, options);
}

module.exports = {
  RecipeRunEngine: { addPromptToRun, editPromptAndRetry, executeRun, resumeRun, skipRunStep, startRunFromRecipe },
  addPromptToRun,
  editPromptAndRetry,
  executeRun,
  resumeRun,
  skipRunStep,
  startRunFromRecipe
};
