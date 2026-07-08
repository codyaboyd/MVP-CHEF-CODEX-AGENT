const dashboardService = require('../services/dashboardService');
const recipeService = require('../services/recipeService');
const projectService = require('../services/projectService');
const recipeRunEngine = require('../services/recipeRunEngine');
const runStateManager = require('../services/runStateManager');
const appSettingsService = require('../services/appSettingsService');

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

function getDisplayRun(id) {
  const run = dashboardService.getRunById(id);
  const fallback = dashboardService.getRuns()[0];
  const demoRun = {
    id,
    recipe_name: 'Product Brief Soufflé',
    project_name: 'Demo MVP Chef Project',
    status: 'running',
    commit_sha: null,
    pr_url: null,
    steps: [
      { step_order: 1, recipe_step_title: 'Clarify the appetite', prompt: 'Gather constraints, target users, and measurable success signals.', status: 'succeeded' },
      { step_order: 2, recipe_step_title: 'Plate the brief', prompt: 'Draft the MVP brief and prep it for review.', status: 'running' }
    ]
  };
  return run || (fallback ? { ...fallback, steps: [] } : demoRun);
}

function runDetail(req, res) {
  res.render('run-detail', {
    title: 'Run Detail',
    run: getDisplayRun(Number(req.params.id)),
    runSnapshot: dashboardService.getRunSnapshot(Number(req.params.id))
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
  recipeRunEngine.resumeRun(Number(req.params.id), { mockMode: 'auto', approved: true, quotaCooldownElapsed: req.body.ignoreQuotaCooldown === '1' }).catch(next);
  redirectToRun(req, res);
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
    settings,
  updateSettings: dashboardService.getSettings()
  });
}

function updateSettings(req, res) {
  appSettingsService.updateSettings({
    autoMergeEnabled: req.body.autoMergeEnabled === 'true' ? 'true' : 'false',
    requireHumanApprovalBeforeMerge: req.body.requireHumanApprovalBeforeMerge === 'true' ? 'true' : 'false',
    protectedMainMode: req.body.protectedMainMode === 'true' ? 'true' : 'false',
    defaultCooldownMinutes: req.body.defaultCooldownMinutes || '60',
    autoResumeAfterCooldown: req.body.autoResumeAfterCooldown === 'true' ? 'true' : 'false',
    maxRetriesAfterQuota: req.body.maxRetriesAfterQuota || '3'
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
  cancelRun,
  settings,
  updateSettings
};
