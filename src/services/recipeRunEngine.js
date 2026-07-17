const db = require('../db');
const codexRunner = require('./codexRunnerService');
const recipeService = require('./recipeService');
const runStateManager = require('./runStateManager');
const { GitManager } = require('./gitManagerService');
const { GitHubManager } = require('./githubManagerService');
const appSettingsService = require('./appSettingsService');
const promptLintService = require('./promptLintService');
const failureRecoveryService = require('./failureRecoveryService');

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


const APPROVAL_POINTS = Object.freeze({
  BEFORE_STEP: 'before_step',
  AFTER_CODEX: 'after_codex',
  BEFORE_COMMIT: 'before_commit',
  BEFORE_MERGE: 'before_merge'
});

function approvalModeForStep(recipe, recipeStep, project) {
  if (project.safe_mode) return 'all';
  if (recipeStep.approvalOverride && recipeStep.approvalOverride !== 'inherit') return recipeStep.approvalOverride;
  if (recipeStep.humanApproval) return 'before_step';
  return recipe.approvalMode || recipe.approval_mode || 'manual_steps';
}

function requiresApprovalAt(recipe, recipeStep, project, point) {
  const mode = approvalModeForStep(recipe, recipeStep, project);
  if (mode === 'none' || mode === 'manual_steps') return false;
  return mode === 'all' || mode === point;
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

function waitForApproval(runId, runStepId, point, message) {
  runStateManager.updateRunStep(runStepId, STATUSES.WAITING_FOR_APPROVAL, {
    approval_point: point,
    error_message: message,
    started_at: nowSql()
  });
  return runStateManager.updateRun(runId, STATUSES.WAITING_FOR_APPROVAL, { error_message: message });
}

function approvalSatisfied(nextStep, point, options) {
  return nextStep.approval_point !== point || options.approvedPoint === point || options.approved === true;
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

async function createPrAndMaybeMerge({ runId, runStepId, branchName, title, body, gitManager, githubManager, automationSettings, squash, approved, requireApproval }) {
  if (!githubManager) return null;
  const { prUrl } = await githubManager.createPullRequestAfterChecks({ branchName, title, body });
  if (!prUrl) throw new Error('GitHub PR was not created successfully; auto-merge is blocked.');
  if (!automationSettings.autoMergeEnabled) return { prUrl, mergeCommitSha: null, skipped: 'Auto-merge is disabled.' };
  if (automationSettings.protectedMainMode && !githubManager) {
    throw new Error('Protected main mode requires GitHub PR automation before auto-merge.');
  }
  if ((automationSettings.requireHumanApprovalBeforeMerge || requireApproval) && !approved) {
    runStateManager.updateRunStep(runStepId, STATUSES.WAITING_FOR_APPROVAL, {
      pr_url: prUrl,
      approval_point: APPROVAL_POINTS.BEFORE_MERGE,
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
    error_message: 'Skipped by human reviewer.'
  });
  failureRecoveryService.recordAction(runId, runStepId, 'skip_failed_step', { reason: 'Skipped by human reviewer.' });
  return runStateManager.updateRun(runId, STATUSES.PAUSED, { error_message: 'Step skipped by human reviewer.' });
}

function rejectRunStep(runId, runStepId, reason = '') {
  const message = reason || 'Rejected by human reviewer.';
  runStateManager.updateRunStep(runStepId, STATUSES.FAILED, { completed_at: nowSql(), error_message: message });
  return runStateManager.updateRun(runId, STATUSES.FAILED, { completed_at: nowSql(), error_message: message });
}

function editPromptAndRetry(runId, runStepId, prompt) {
  if (!prompt || !prompt.trim()) throw new Error('Edited prompt is required.');
  runStateManager.updateRunStep(runStepId, STATUSES.PAUSED, {
    prompt_override: prompt.trim(),
    approval_point: null,
    error_message: 'Prompt edited by human reviewer; ready to retry.'
  });
  failureRecoveryService.recordAction(runId, runStepId, 'edit_failed_prompt_and_retry', { prompt: prompt.trim() });
  return runStateManager.updateRun(runId, STATUSES.PAUSED, { error_message: 'Prompt edited by human reviewer; ready to retry.' });
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

  const automationSettings = appSettingsService.getAutomationSettings(options);
  const githubAutomationEnabled = options.githubAutomation !== undefined
    ? options.githubAutomation !== false
    : automationSettings.githubAutomationEnabled;
  const gitManager = options.gitEnabled ? new GitManager({ repoPath: project.repo_path, mainBranch: project.default_branch }) : null;
  const githubManager = gitManager && githubAutomationEnabled
    ? new GitHubManager({
      repoPath: project.repo_path,
      mainBranch: project.default_branch,
      ghCommand: options.ghCommand,
      checkPollIntervalMs: options.githubCheckPollIntervalMs,
      checkTimeoutMs: options.githubCheckTimeoutMs
    })
    : null;
  if (gitManager) {
    runStateManager.assertRunOwnsProjectLock(run.project_id, runId);
    await gitManager.assertCleanWorkingTree();
    if (githubManager) {
      await githubManager.verifyCli();
      await gitManager.pullLatestMain();
    }
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
        const failed = runStateManager.updateRun(runId, STATUSES.FAILED, { completed_at: nowSql(), error_message: error.message });
        runStateManager.releaseProjectLock(run.project_id, runId);
        return failed;
      }
    }

    if (nextStep.status === STATUSES.WAITING_FOR_APPROVAL && nextStep.approval_point && !approvalSatisfied(nextStep, nextStep.approval_point, options)) {
      return runStateManager.updateRun(runId, STATUSES.WAITING_FOR_APPROVAL, { error_message: nextStep.error_message || 'Waiting for human approval.' });
    }

    const lintResult = lintPromptBeforeStep({ runId, nextStep, recipeStep, project });
    if (lintResult.blocked) return runStateManager.getRun(runId);
    nextStep = lintResult.nextStep;
    const stepPrompt = lintResult.stepPrompt;

    if (requiresApprovalAt(recipe, recipeStep, project, APPROVAL_POINTS.BEFORE_STEP) && nextStep.status === STATUSES.PENDING) {
      return waitForApproval(runId, nextStep.id, APPROVAL_POINTS.BEFORE_STEP, 'Waiting for approval before running step.');
    }

    if (nextStep.status === STATUSES.WAITING_FOR_APPROVAL) {
      runStateManager.updateRunStep(nextStep.id, STATUSES.PAUSED, { approval_point: null, error_message: null });
      nextStep = { ...nextStep, status: STATUSES.PAUSED, approval_point: null };
    }

    let branchName = null;
    let checkpointSha = null;

    try {
      if (gitManager) {
        runStateManager.refreshProjectLock(run.project_id, runId);
        runStateManager.assertRunOwnsProjectLock(run.project_id, runId);
        checkpointSha = await gitManager.getCurrentSha();
        branchName = await gitManager.createBranchForStep({ runId, stepId: nextStep.id, stepTitle: recipeStep.title });
      }

      await codexRunner.executeStep({
        runId,
        runStepId: nextStep.id,
        repoPath: project.repo_path,
        prompt: stepPrompt,
        retries: recipeStep.retryCount,
        codexCommand: options.codexCommand ?? appSettingsService.getSetting('codexCommandPath')?.value,
        codexArgs: options.codexArgs,
        codexModel: options.codexModel ?? appSettingsService.getSetting('codexModel')?.value,
        timeoutMs: options.timeoutMs
      });

      if (requiresApprovalAt(recipe, recipeStep, project, APPROVAL_POINTS.AFTER_CODEX) && !approvalSatisfied(nextStep, APPROVAL_POINTS.AFTER_CODEX, options)) {
        return waitForApproval(runId, nextStep.id, APPROVAL_POINTS.AFTER_CODEX, 'Waiting for approval after Codex.');
      }

      if (requiresApprovalAt(recipe, recipeStep, project, APPROVAL_POINTS.BEFORE_COMMIT) && !approvalSatisfied(nextStep, APPROVAL_POINTS.BEFORE_COMMIT, options)) {
        return waitForApproval(runId, nextStep.id, APPROVAL_POINTS.BEFORE_COMMIT, 'Waiting for approval before commit.');
      }

      if (gitManager) runStateManager.assertRunOwnsProjectLock(run.project_id, runId);
      const gitResult = gitManager
        ? await gitManager.commitStep({ runId, stepId: nextStep.id, stepTitle: recipeStep.title })
        : null;
      let githubResult = null;
      if (gitManager && gitResult.committed) {
        await gitManager.assertNoSecretsInCommit(gitResult.commitSha);
      }
      if (gitManager && gitResult.committed && options.gitPush !== false && githubManager) {
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
            approved: options.approved,
            requireApproval: requiresApprovalAt(recipe, recipeStep, project, APPROVAL_POINTS.BEFORE_MERGE) && !approvalSatisfied(nextStep, APPROVAL_POINTS.BEFORE_MERGE, options)
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
  if (step.status === STATUSES.WAITING_FOR_APPROVAL && !options.approved) {
    return runStateManager.updateRun(runId, STATUSES.WAITING_FOR_APPROVAL, { error_message: 'Waiting for human approval.' });
  }
  if (step.status === STATUSES.WAITING_FOR_APPROVAL && (options.approved || options.approvedPoint) && !step.pr_url) {
    runStateManager.updateRunStep(step.id, STATUSES.PAUSED, { error_message: null });
  }
  return executeRun(runId, options);
}

module.exports = {
  RecipeRunEngine: { editPromptAndRetry, executeRun, rejectRunStep, resumeRun, skipRunStep, startRunFromRecipe },
  editPromptAndRetry,
  executeRun,
  rejectRunStep,
  resumeRun,
  skipRunStep,
  startRunFromRecipe
};
