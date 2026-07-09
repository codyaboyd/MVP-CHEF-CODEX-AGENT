const dashboardService = require('../services/dashboardService');
const recipeService = require('../services/recipeService');
const projectService = require('../services/projectService');
const recipeRunEngine = require('../services/recipeRunEngine');
const runStateManager = require('../services/runStateManager');
const appSettingsService = require('../services/appSettingsService');
const failureRecoveryService = require('../services/failureRecoveryService');

function dashboard(req, res) {
  res.render('dashboard', {
    title: 'Dashboard',
    ...dashboardService.getDashboard()
  });
}

function projects(req, res) {
  res.render('projects', {
    title: 'Projects',
    projects: dashboardService.getProjects(),
    form: projectService.normalizeProjectInput({}),
    errors: []
  });
}

function createProject(req, res) {
  try {
    projectService.createProject(req.body);
    res.redirect('/projects');
  } catch (error) {
    if (!error.validationErrors) {
      throw error;
    }

    res.status(400).render('projects', {
      title: 'Projects',
      projects: dashboardService.getProjects(),
      form: error.project,
      errors: error.validationErrors
    });
  }
}

function recipes(req, res) {
  res.render('recipes', {
    title: 'Recipes',
    recipes: recipeService.getAllRecipes()
  });
}

function runDetail(req, res, next) {
  const runId = Number(req.params.id);
  const run = dashboardService.getRunById(runId);
  if (!Number.isInteger(runId) || runId <= 0 || !run) {
    next();
    return;
  }
  res.render('run-detail', {
    title: 'Run Detail',
    run,
    runSnapshot: dashboardService.getRunSnapshot(runId)
  });
}

function runEvents(req, res) {
  const runId = Number(req.params.id);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  let lastPayload = '';
  const send = () => {
    const snapshot = dashboardService.getRunSnapshot(runId);
    if (!snapshot) {
      res.write('event: error\n');
      res.write(`data: ${JSON.stringify({ message: 'Run not found.' })}\n\n`);
      return;
    }
    const payload = JSON.stringify(snapshot);
    if (payload !== lastPayload) {
      res.write(`id: ${Date.now()}\n`);
      res.write('event: run-update\n');
      res.write(`data: ${payload}\n\n`);
      lastPayload = payload;
    } else {
      res.write(': keep-alive\n\n');
    }
  };

  send();
  const interval = setInterval(send, 1000);
  req.on('close', () => clearInterval(interval));
}

function redirectToRun(req, res) {
  res.redirect(`/runs/${Number(req.params.id)}`);
}

function pauseRun(req, res) {
  runStateManager.pauseRun(Number(req.params.id));
  redirectToRun(req, res);
}

function resumeRun(req, res, next) {
  recipeRunEngine.resumeRun(Number(req.params.id), { mockMode: 'auto', approved: true, approvedPoint: req.body.approvalPoint, quotaCooldownElapsed: req.body.ignoreQuotaCooldown === '1' }).catch(next);
  redirectToRun(req, res);
}

function approveRunStep(req, res, next) {
  recipeRunEngine.resumeRun(Number(req.params.id), { mockMode: 'auto', approved: true, approvedPoint: req.body.approvalPoint }).catch(next);
  redirectToRun(req, res);
}

function rejectRunStep(req, res, next) {
  try {
    recipeRunEngine.rejectRunStep(Number(req.params.id), Number(req.params.stepId), req.body.reason);
    redirectToRun(req, res);
  } catch (error) {
    next(error);
  }
}

function editPromptAndRetry(req, res, next) {
  try {
    recipeRunEngine.editPromptAndRetry(Number(req.params.id), Number(req.params.stepId), req.body.prompt);
    recipeRunEngine.resumeRun(Number(req.params.id), { mockMode: 'auto' }).catch(next);
    redirectToRun(req, res);
  } catch (error) {
    next(error);
  }
}

function skipRunStep(req, res, next) {
  try {
    recipeRunEngine.skipRunStep(Number(req.params.id), Number(req.params.stepId));
    recipeRunEngine.resumeRun(Number(req.params.id), { mockMode: 'auto' }).catch(next);
    redirectToRun(req, res);
  } catch (error) {
    next(error);
  }
}

function retryRunStep(req, res, next) {
  try {
    failureRecoveryService.retryFailedStep(Number(req.params.id), Number(req.params.stepId));
    recipeRunEngine.resumeRun(Number(req.params.id), { mockMode: 'auto' }).catch(next);
    redirectToRun(req, res);
  } catch (error) {
    next(error);
  }
}

function continueFromStep(req, res, next) {
  try {
    failureRecoveryService.continueFromStep(Number(req.params.id), Number(req.params.stepId));
    recipeRunEngine.resumeRun(Number(req.params.id), { mockMode: 'auto' }).catch(next);
    redirectToRun(req, res);
  } catch (error) {
    next(error);
  }
}

function rollbackLastStep(req, res, next) {
  failureRecoveryService.rollbackLastStep(Number(req.params.id))
    .then(() => redirectToRun(req, res))
    .catch(next);
}

function runDiff(req, res, next) {
  failureRecoveryService.getDiff(Number(req.params.id), req.query.stepId ? Number(req.query.stepId) : null)
    .then((diff) => res.type('text/plain').send(diff))
    .catch(next);
}

function runLogs(req, res, next) {
  try {
    const logs = failureRecoveryService.getLogs(Number(req.params.id), req.query.stepId ? Number(req.query.stepId) : null);
    res.type('text/plain').send([logs.error && `Error: ${logs.error}`, logs.stdout, logs.stderr].filter(Boolean).join('\n'));
  } catch (error) {
    next(error);
  }
}

function exportFailureReport(req, res, next) {
  try {
    const report = failureRecoveryService.exportFailureReport(Number(req.params.id));
    res.setHeader('Content-Disposition', `attachment; filename="run-${req.params.id}-failure-report.json"`);
    res.type('application/json').send(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    next(error);
  }
}

function setQuotaRefill(req, res, next) {
  try {
    const runId = Number(req.params.id);
    const refillAt = req.body.quotaRefillAt ? new Date(req.body.quotaRefillAt).toISOString() : null;
    if (!refillAt) throw new Error('Quota refill time is required.');
    const run = runStateManager.updateRun(runId, runStateManager.STATUSES.WAITING_FOR_QUOTA, { quota_refill_at: refillAt });
    const step = runStateManager.getRunSteps(runId).find((candidate) => candidate.status === runStateManager.STATUSES.WAITING_FOR_QUOTA);
    if (step) runStateManager.updateRunStep(step.id, runStateManager.STATUSES.WAITING_FOR_QUOTA, { quota_refill_at: refillAt });
    recipeRunEngine.resumeRun(run.id, { mockMode: 'auto', approved: true }).catch(next);
    redirectToRun(req, res);
  } catch (error) {
    next(error);
  }
}

function overrideQualityGate(req, res, next) {
  try {
    const run = dashboardService.getRunById(Number(req.params.id));
    const step = run?.steps.find((candidate) => candidate.id === Number(req.params.stepId));
    if (!step) {
      next();
      return;
    }
    require('../services/qualityGateService').saveManualOverride(step.id, req.body.reason);
    recipeRunEngine.resumeRun(Number(req.params.id), { mockMode: 'auto', approved: true }).catch(next);
    redirectToRun(req, res);
  } catch (error) {
    next(error);
  }
}

function cancelRun(req, res) {
  runStateManager.cancelRun(Number(req.params.id));
  redirectToRun(req, res);
}

function settings(req, res) {
  res.render('settings', {
    title: 'Settings',
    settings: dashboardService.getSettings()
  });
}

function updateSettings(req, res) {
  appSettingsService.updateSettings({
    codexCommandPath: req.body.codexCommandPath || 'codex',
    mockRunnerMode: ['true', 'false', 'auto'].includes(req.body.mockRunnerMode) ? req.body.mockRunnerMode : 'auto',
    defaultCooldownMinutes: req.body.defaultCooldownMinutes || '60',
    autoResumeAfterCooldown: req.body.autoResumeAfterCooldown === 'true' ? 'true' : 'false',
    autoMergeEnabled: req.body.autoMergeEnabled === 'true' ? 'true' : 'false',
    requireHumanApprovalBeforeMerge: req.body.requireHumanApprovalBeforeMerge === 'true' ? 'true' : 'false',
    maxParallelRuns: req.body.maxParallelRuns || '1',
    maxStepRuntimeMinutes: req.body.maxStepRuntimeMinutes || '30',
    defaultBranch: req.body.defaultBranch || 'main',
    protectedMainMode: req.body.protectedMainMode === 'true' ? 'true' : 'false',
    compactUiMode: req.body.compactUiMode === 'true' ? 'true' : 'false',
    showAdvancedSettings: req.body.showAdvancedSettings === 'true' ? 'true' : 'false',
    maxRetriesAfterQuota: req.body.maxRetriesAfterQuota || '3',
    projectSafeModeDefault: req.body.projectSafeModeDefault === 'true' ? 'true' : 'false',
    secretScannerAllowOverride: req.body.secretScannerAllowOverride === 'true' ? 'true' : 'false'
  });
  res.redirect('/settings');
}

module.exports = {
  dashboard,
  projects,
  createProject,
  recipes,
  runDetail,
  runEvents,
  setQuotaRefill,
  pauseRun,
  resumeRun,
  overrideQualityGate,
  approveRunStep,
  rejectRunStep,
  retryRunStep,
  continueFromStep,
  rollbackLastStep,
  runDiff,
  runLogs,
  exportFailureReport,
  editPromptAndRetry,
  skipRunStep,
  cancelRun,
  settings,
  updateSettings
};
