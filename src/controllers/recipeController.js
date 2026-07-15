const recipeService = require('../services/recipeService');
const promptLintService = require('../services/promptLintService');
const recipeRunEngine = require('../services/recipeRunEngine');

function parseSteps(body) {
  const titles = Array.isArray(body.stepTitles) ? body.stepTitles : [body.stepTitles];
  const prompts = Array.isArray(body.stepPrompts) ? body.stepPrompts : [body.stepPrompts];
  const checks = Array.isArray(body.stepRequiredChecks) ? body.stepRequiredChecks : [body.stepRequiredChecks];
  const retries = Array.isArray(body.stepRetryCounts) ? body.stepRetryCounts : [body.stepRetryCounts];
  const approvals = Array.isArray(body.stepHumanApprovals) ? body.stepHumanApprovals : [body.stepHumanApprovals];
  const approvalOverrides = Array.isArray(body.stepApprovalOverrides) ? body.stepApprovalOverrides : [body.stepApprovalOverrides];

  return titles.map((title, index) => ({
    title,
    prompt: prompts[index],
    requiredChecks: checks[index],
    retryCount: retries[index],
    humanApproval: approvals[index] === '1',
    approvalOverride: approvalOverrides[index] || 'inherit'
  }));
}

function home(req, res) {
  const recipes = recipeService.getAllRecipes();
  res.render('index', {
    title: 'MVP Chef Codex',
    recipes
  });
}

function showRecipe(req, res, next) {
  const recipe = recipeService.getRecipeById(Number(req.params.id));

  if (!recipe) {
    next();
    return;
  }

  res.render('recipe', {
    title: recipe.title,
    recipe
  });
}

function recipeForm(res, { pageTitle, action, values = {}, error = null }) {
  res.render('recipe-form', {
    title: pageTitle,
    pageTitle,
    action,
    values,
    projects: recipeService.getProjects(),
    error
  });
}

function newRecipeForm(req, res) {
  recipeForm(res, {
    pageTitle: 'Add a Recipe',
    action: '/recipes',
    values: { approvalMode: 'manual_steps', steps: [{ title: 'Step 1', prompt: '', requiredChecks: '', retryCount: 0, humanApproval: false, approvalOverride: 'inherit' }] }
  });
}

function importRecipeForm(req, res) {
  res.render('recipe-import', {
    title: 'Import Recipe',
    projects: recipeService.getProjects(),
    values: { recipeJson: '', projectId: '' },
    errors: []
  });
}

function editRecipeForm(req, res, next) {
  const recipe = recipeService.getRecipeById(Number(req.params.id));
  if (!recipe) {
    next();
    return;
  }

  recipeForm(res, {
    pageTitle: `Edit ${recipe.title}`,
    action: `/recipes/${recipe.id}`,
    values: recipe
  });
}

function validate(values) {
  if (!values.title || !values.phase || !values.summary) {
    return 'Every recipe needs a title, version, and summary.';
  }

  const hasRawTextBlocks = recipeService.parseRawTextBlocks(values.rawTextBlocks || '').length > 0;
  const hasStructuredStep = values.steps.some((step) => String(step.title || '').trim() && String(step.prompt || '').trim());
  if (!hasStructuredStep && !hasRawTextBlocks) {
    return 'Add at least one prompt step or paste one or more raw text blocks.';
  }

  return null;
}

function createRecipe(req, res) {
  const values = { ...req.body, projectId: req.body.projectId, steps: parseSteps(req.body) };
  const error = validate(values);
  if (error) {
    recipeForm(res.status(400), { pageTitle: 'Add a Recipe', action: '/recipes', values, error });
    return;
  }

  const recipe = recipeService.createRecipe(values);
  res.redirect(`/recipes/${recipe.id}`);
}

function importRecipe(req, res) {
  try {
    const recipe = recipeService.importRecipeFromJson(req.body.recipeJson, req.body.projectId);
    res.redirect(`/recipes/${recipe.id}`);
  } catch (error) {
    res.status(400).render('recipe-import', {
      title: 'Import Recipe',
      projects: recipeService.getProjects(),
      values: { recipeJson: req.body.recipeJson || '', projectId: req.body.projectId || '' },
      errors: error.validationErrors || [error.message]
    });
  }
}

function exportRecipe(req, res, next) {
  const recipe = recipeService.getRecipeExport(Number(req.params.id));
  if (!recipe) {
    next();
    return;
  }

  const filename = `${recipe.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'recipe'}.json`;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(`${JSON.stringify(recipe, null, 2)}\n`);
}

function exportRecipePreview(req, res, next) {
  const recipe = recipeService.getRecipeExport(Number(req.params.id));
  if (!recipe) {
    next();
    return;
  }

  res.type('application/json').send(`${JSON.stringify(recipe, null, 2)}\n`);
}

function improvePrompt(req, res) {
  res.json({ improvedPrompt: promptLintService.improvePrompt(req.body.prompt || '') });
}

function updateRecipe(req, res, next) {
  const id = Number(req.params.id);
  if (!recipeService.getRecipeById(id)) {
    next();
    return;
  }

  const values = { ...req.body, projectId: req.body.projectId, steps: parseSteps(req.body) };
  const error = validate(values);
  if (error) {
    values.id = id;
    recipeForm(res.status(400), { pageTitle: 'Edit Recipe', action: `/recipes/${id}`, values, error });
    return;
  }

  recipeService.updateRecipe(id, values);
  res.redirect(`/recipes/${id}`);
}

function duplicateRecipe(req, res, next) {
  const recipe = recipeService.duplicateRecipe(Number(req.params.id));
  if (!recipe) {
    next();
    return;
  }
  res.redirect(`/recipes/${recipe.id}/edit`);
}


function runRecipe(req, res, next) {
  recipeRunEngine.startRunFromRecipe(Number(req.params.id), {
    mockMode: 'auto',
    gitEnabled: req.body.gitEnabled === '1',
    githubAutomation: false,
    gitPush: false
  })
    .then((run) => res.redirect(`/runs/${run.id}`))
    .catch(next);
}

function deleteRecipe(req, res, next) {
  if (!recipeService.deleteRecipe(Number(req.params.id))) {
    next();
    return;
  }
  res.redirect('/recipes');
}

module.exports = {
  createRecipe,
  deleteRecipe,
  duplicateRecipe,
  editRecipeForm,
  exportRecipe,
  exportRecipePreview,
  home,
  importRecipe,
  importRecipeForm,
  improvePrompt,
  newRecipeForm,
  runRecipe,
  showRecipe,
  updateRecipe
};
