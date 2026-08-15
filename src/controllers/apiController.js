const dashboardService = require('../services/dashboardService');
const recipeRunEngine = require('../services/recipeRunEngine');

function apiError(res, status, message) {
  return res.status(status).json({ error: { message } });
}

async function startJob(req, res) {
  const recipeId = Number(req.body.recipeId);
  if (!Number.isInteger(recipeId) || recipeId <= 0) return apiError(res, 400, 'recipeId must be a positive integer.');

  try {
    const run = await recipeRunEngine.startRunFromRecipe(recipeId, { autoExecute: false });
    recipeRunEngine.resumeRun(run.id, { gitEnabled: req.body.gitEnabled === true }).catch((error) => {
      console.error(`API job ${run.id} failed:`, error);
    });
    return res.status(202).location(`/api/jobs/${run.id}`).json({ jobId: run.id, status: run.status, statusUrl: `/api/jobs/${run.id}` });
  } catch (error) {
    if (/was not found/.test(error.message)) return apiError(res, 404, error.message);
    if (error.code === 'PROJECT_RUN_LOCKED') return apiError(res, 409, error.message);
    return apiError(res, 400, error.message);
  }
}

function getJob(req, res) {
  const jobId = Number(req.params.id);
  const snapshot = Number.isInteger(jobId) && jobId > 0 ? dashboardService.getRunSnapshot(jobId) : null;
  if (!snapshot) return apiError(res, 404, `Job ${req.params.id} was not found.`);
  return res.json(snapshot);
}

function addJobPrompt(req, res) {
  try {
    const step = recipeRunEngine.addPromptToRun(Number(req.params.id), req.body.prompt);
    return res.status(201).json({ jobId: Number(req.params.id), step: { id: step.id, order: step.step_order, status: step.status, prompt: step.prompt_override } });
  } catch (error) {
    if (/was not found/.test(error.message)) return apiError(res, 404, error.message);
    if (error.code === 'RUN_NOT_ACTIVE') return apiError(res, 409, error.message);
    return apiError(res, 400, error.message);
  }
}

module.exports = { addJobPrompt, getJob, startJob };
