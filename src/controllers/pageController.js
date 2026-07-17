const dashboardService = require('../services/dashboardService');
const recipeService = require('../services/recipeService');
const projectService = require('../services/projectService');
const recipeRunEngine = require('../services/recipeRunEngine');
const runStateManager = require('../services/runStateManager');
const appSettingsService = require('../services/appSettingsService');
const failureRecoveryService = require('../services/failureRecoveryService');
const setupValidationService = require('../services/setupValidationService');
const folderBrowserService = require('../services/folderBrowserService');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function dashboard(req, res) {
  res.render('dashboard', {
    title: 'Dashboard',
    ...dashboardService.getDashboard(),
    composer: { folderPath: '', prompts: [''] },
    composerErrors: []
  });
}

async function quickRun(req, res, next) {
  const prompts = (Array.isArray(req.body.prompts) ? req.body.prompts : [req.body.prompts])
    .map((prompt) => String(prompt || '').trim())
    .filter(Boolean);
  const composer = { folderPath: String(req.body.folderPath || '').trim(), prompts: prompts.length ? prompts : [''] };
  const validation = projectService.validateProjectPath(composer.folderPath);
  const errors = [!validation.ok ? validation.message : null, !prompts.length ? 'Type at least one prompt.' : null].filter(Boolean);

  if (errors.length) {
    res.status(400).render('dashboard', {
      title: 'Dashboard',
      ...dashboardService.getDashboard(),
      composer,
      composerErrors: errors
    });
    return;
  }

  try {
    const project = projectService.getOrCreateFolderProject(validation.repoPath);
    const recipe = recipeService.createRecipe({
      title: `Prompt run · ${path.basename(validation.repoPath)}`,
      phase: '1.0.0',
      summary: prompts.length === 1 ? prompts[0].slice(0, 160) : `${prompts.length} chained prompts`,
      projectId: project.id,
      approvalMode: 'none',
      steps: prompts.map((prompt, index) => ({ title: `Prompt ${index + 1}`, prompt }))
    });
    const run = await recipeRunEngine.startRunFromRecipe(recipe.id, { autoExecute: false });
    recipeRunEngine.resumeRun(run.id, { mockMode: 'auto', gitEnabled: false, githubAutomation: false }).catch((error) => console.error(error));
    res.redirect(`/runs/${run.id}`);
  } catch (error) {
    next(error);
  }
}

function projects(req, res) {
  res.render('projects', {
    title: 'Projects',
    projects: dashboardService.getProjects(),
    form: projectService.normalizeProjectInput({}),
    errors: []
  });
}

function candidateProjectRoots() {
  return [...new Set([
    process.cwd(),
    path.dirname(process.cwd()),
    '/workspace',
    os.homedir()
  ].filter(Boolean))];
}

function inspectProjectPath(req, res) {
  const result = projectService.detectProjectCommands(String(req.query.path || ''));
  res.status(result.ok ? 200 : 400).json(result);
}

function browseProjectFolders(req, res) {
  res.json(folderBrowserService.scanProjectFolders());
}

function resolveProjectFolder(req, res) {
  const requestedPath = String(req.query.path || '').trim();
  if (requestedPath) {
    const validation = projectService.validateProjectPath(requestedPath);
    if (!validation.ok) {
      res.status(400).json({ ok: false, message: validation.message, path: '', matches: [] });
      return;
    }
    res.json({ ok: true, path: validation.repoPath, matches: [validation.repoPath] });
    return;
  }

  const folderName = path.basename(String(req.query.name || '').trim());
  if (!folderName || folderName === '.' || folderName === path.sep) {
    res.status(400).json({ ok: false, message: 'Folder name is required.' });
    return;
  }

  const matches = candidateProjectRoots()
    .map((root) => path.resolve(root, folderName))
    .filter((candidate, index, candidates) => candidates.indexOf(candidate) === index)
    .filter((candidate) => {
      try {
        return fs.statSync(candidate).isDirectory();
      } catch {
        return false;
      }
    });

  res.json({ ok: matches.length === 1, path: matches.length === 1 ? matches[0] : '', matches });
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

function cancelRun(req, res) {
  runStateManager.cancelRun(Number(req.params.id));
  redirectToRun(req, res);
}

function help(req, res) {
  res.render('help', {
    title: 'Help'
  });
}

async function settings(req, res, next) {
  try {
    res.render('settings', {
      title: 'Settings',
      settings: dashboardService.getSettings(),
      setupValidation: await setupValidationService.validateSetup()
    });
  } catch (error) {
    next(error);
  }
}

function updateSettings(req, res) {
  appSettingsService.updateSettings({
    codexCommandPath: req.body.codexCommandPath || 'codex',
    codexAuthMode: ['environment', 'api_key', 'config_dir'].includes(req.body.codexAuthMode) ? req.body.codexAuthMode : 'environment',
    codexApiKey: req.body.codexApiKey || '',
    codexConfigDir: req.body.codexConfigDir || '',
    codexModel: req.body.codexModel || '',
    codexApprovalPolicy: ['suggest', 'on-request', 'never'].includes(req.body.codexApprovalPolicy) ? req.body.codexApprovalPolicy : 'suggest',
    codexSandboxMode: ['workspace-write', 'read-only', 'danger-full-access'].includes(req.body.codexSandboxMode) ? req.body.codexSandboxMode : 'workspace-write',
    mockRunnerMode: ['true', 'false', 'auto'].includes(req.body.mockRunnerMode) ? req.body.mockRunnerMode : 'auto',
    defaultCooldownMinutes: req.body.defaultCooldownMinutes || '60',
    autoResumeAfterCooldown: req.body.autoResumeAfterCooldown === 'true' ? 'true' : 'false',
    autoMergeEnabled: req.body.autoMergeEnabled === 'true' ? 'true' : 'false',
    requireHumanApprovalBeforeMerge: req.body.requireHumanApprovalBeforeMerge === 'true' ? 'true' : 'false',
    maxParallelRuns: req.body.maxParallelRuns || '1',
    maxStepRuntimeMinutes: req.body.maxStepRuntimeMinutes || '30',
    defaultBranch: req.body.defaultBranch || 'main',
    githubToken: req.body.githubToken || '',
    githubUsername: req.body.githubUsername || '',
    githubCliPath: req.body.githubCliPath || 'gh',
    githubDefaultOrg: req.body.githubDefaultOrg || '',
    githubAutomationEnabled: req.body.githubAutomationEnabled === 'true' ? 'true' : 'false',
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
  quickRun,
  projects,
  createProject,
  resolveProjectFolder,
  browseProjectFolders,
  inspectProjectPath,
  recipes,
  runDetail,
  runEvents,
  setQuotaRefill,
  pauseRun,
  resumeRun,
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
  help,
  settings,
  updateSettings
};
