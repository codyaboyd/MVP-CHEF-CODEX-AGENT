const db = require('../db');
const codexRunner = require('./codexRunnerService');
const recipeService = require('./recipeService');
const runStateManager = require('./runStateManager');
const qualityGateService = require('./qualityGateService');
const { GitManager } = require('./gitManagerService');
const { GitHubManager } = require('./githubManagerService');
const appSettingsService = require('./appSettingsService');

const { STATUSES } = runStateManager;

const quotaResumeTimers = new Map();

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

function getProject(projectId) {
  if (!projectId) return null;
  return db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) || null;
}


async function completePendingMerge({ runStep, gitManager, githubManager, automationSettings, squash }) {
  if (!gitManager || !githubManager || !runStep.pr_url || runStep.merge_commit_sha) return null;
  if (!automationSettings.autoMergeEnabled) return { prUrl: runStep.pr_url, mergeCommitSha: null, skipped: 'Auto-merge is disabled.' };
  const mergeCommitSha = await githubManager.mergePullRequest(runStep.pr_url, { squash });
  const pullResult = await gitManager.pullLatestMain();
  return { prUrl: runStep.pr_url, mergeCommitSha, pullResult };
}

async function createPrAndMaybeMerge({ runId, runStepId, branchName, title, body, gitManager, githubManager, automationSettings, squash, approved }) {
  if (!githubManager) return null;
  const { prUrl } = await githubManager.createPullRequestAfterChecks({ branchName, title, body });
  if (!prUrl) throw new Error('GitHub PR was not created successfully; auto-merge is blocked.');
  if (!automationSettings.autoMergeEnabled) return { prUrl, mergeCommitSha: null, skipped: 'Auto-merge is disabled.' };
  if (automationSettings.protectedMainMode && !githubManager) {
    throw new Error('Protected main mode requires GitHub PR automation before auto-merge.');
  }
  if (automationSettings.requireHumanApprovalBeforeMerge && !approved) {
    runStateManager.updateRunStep(runStepId, STATUSES.WAITING_FOR_APPROVAL, {
      pr_url: prUrl,
      error_message: 'Waiting for human approval before merge.'
    });
    runStateManager.updateRun(runId, STATUSES.WAITING_FOR_APPROVAL, {
      pr_url: prUrl,
      error_message: 'Waiting for human approval before merge.'
    });
    return { prUrl, mergeCommitSha: null, waitingForApproval: true };
  }
  const mergeCommitSha = await githubManager.mergePullRequest(prUrl, { squash });
  const pullResult = await gitManager.pullLatestMain();
  return { prUrl, mergeCommitSha, pullResult };
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

  const automationSettings = appSettingsService.getAutomationSettings(options);
  const gitManager = options.gitEnabled ? new GitManager({ repoPath: project.repo_path, mainBranch: project.default_branch }) : null;
  const githubManager = gitManager && options.githubAutomation !== false
    ? new GitHubManager({
      repoPath: project.repo_path,
      mainBranch: project.default_branch,
      ghCommand: options.ghCommand,
      checkPollIntervalMs: options.githubCheckPollIntervalMs,
      checkTimeoutMs: options.githubCheckTimeoutMs
    })
    : null;
  if (gitManager) {
    await gitManager.assertCleanWorkingTree();
    if (githubManager) await githubManager.verifyCli();
    await gitManager.pullLatestMain();
  }

  while (nextStep) {
    const latestRun = runStateManager.getRun(runId);
    if (latestRun.status === STATUSES.CANCELLED) return latestRun;

    const recipeStep = recipe.steps.find((step) => step.id === nextStep.recipe_step_id);
    if (!recipeStep) throw new Error(`Recipe step ${nextStep.recipe_step_id} was not found.`);

    if (nextStep.status === STATUSES.WAITING_FOR_APPROVAL && nextStep.pr_url && !nextStep.merge_commit_sha) {
      try {
        const mergeResult = await completePendingMerge({
          runStep: nextStep,
          gitManager,
          githubManager,
          automationSettings,
          squash: options.githubSquashMerge !== false
        });
        if (mergeResult?.skipped) {
          return runStateManager.updateRun(runId, STATUSES.WAITING_FOR_APPROVAL, { error_message: mergeResult.skipped });
        }
        runStateManager.updateRunStep(nextStep.id, STATUSES.SUCCEEDED, {
          completed_at: nowSql(),
          error_message: null,
          merge_commit_sha: mergeResult?.mergeCommitSha || nextStep.merge_commit_sha || null
        });
        runStateManager.updateRun(runId, STATUSES.RUNNING, {
          completed_at: null,
          error_message: null,
          commit_sha: mergeResult?.mergeCommitSha || latestRun.commit_sha || null,
          pr_url: nextStep.pr_url
        });
        runSteps = runStateManager.getRunSteps(runId);
        nextStep = findResumeStep(runSteps);
        continue;
      } catch (error) {
        runStateManager.updateRunStep(nextStep.id, STATUSES.FAILED, { completed_at: nowSql(), error_message: error.message });
        return runStateManager.updateRun(runId, STATUSES.FAILED, { completed_at: nowSql(), error_message: error.message });
      }
    }

    if (recipeStep.humanApproval && nextStep.status === STATUSES.PENDING) {
      runStateManager.updateRunStep(nextStep.id, STATUSES.WAITING_FOR_APPROVAL, { started_at: nowSql() });
      return runStateManager.updateRun(runId, STATUSES.WAITING_FOR_APPROVAL, { error_message: 'Waiting for human approval.' });
    }

    let branchName = null;
    let checkpointSha = null;

    try {
      if (gitManager) {
        checkpointSha = await gitManager.getCurrentSha();
        branchName = await gitManager.createBranchForStep({ runId, stepId: nextStep.id, stepTitle: recipeStep.title });
      }

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

      await qualityGateService.runQualityGates({
        runId,
        runStepId: nextStep.id,
        project,
        recipeStep
      });

      const gitResult = gitManager
        ? await gitManager.commitStep({ runId, stepId: nextStep.id, stepTitle: recipeStep.title })
        : null;
      let githubResult = null;
      if (gitManager && gitResult.committed) {
        await gitManager.assertNoSecretsInCommit(gitResult.commitSha);
      }
      if (gitManager && gitResult.committed && options.gitPush !== false) {
        await gitManager.pushBranch(branchName);
        if (githubManager) {
          githubResult = await createPrAndMaybeMerge({
            runId,
            runStepId: nextStep.id,
            branchName,
            title: `MVP Chef run ${runId}: ${recipeStep.title || `step ${nextStep.id}`}`,
            body: `Run ID: ${runId}
Step ID: ${nextStep.id}

${gitResult.diffSummary || 'Automated MVP Chef step changes.'}`,
            gitManager,
            githubManager,
            automationSettings,
            squash: options.githubSquashMerge !== false,
            approved: options.approved
          });
          if (githubResult?.waitingForApproval) return runStateManager.getRun(runId);
        }
      }
      runStateManager.updateRunStep(nextStep.id, STATUSES.SUCCEEDED, {
        completed_at: nowSql(),
        error_message: null,
        commit_sha: gitResult?.commitSha || nextStep.commit_sha || null,
        pr_url: githubResult?.prUrl || nextStep.pr_url || null,
        merge_commit_sha: githubResult?.mergeCommitSha || nextStep.merge_commit_sha || null
      });
      runStateManager.updateRun(runId, STATUSES.RUNNING, {
        completed_at: null,
        error_message: null,
        commit_sha: githubResult?.mergeCommitSha || gitResult?.commitSha || latestRun.commit_sha || null,
        pr_url: githubResult?.prUrl || latestRun.pr_url || null
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
      return runStateManager.updateRun(runId, STATUSES.FAILED, { completed_at: nowSql(), error_message: error.message });
    }

    runSteps = runStateManager.getRunSteps(runId);
    nextStep = findResumeStep(runSteps);
  }

  if (gitManager && !githubManager) await gitManager.pullLatestMain();

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
  if (step.status === STATUSES.WAITING_FOR_APPROVAL && !options.approved) {
    return runStateManager.updateRun(runId, STATUSES.WAITING_FOR_APPROVAL, { error_message: 'Waiting for human approval.' });
  }
  if (step.status === STATUSES.WAITING_FOR_APPROVAL && options.approved && !step.pr_url) {
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
