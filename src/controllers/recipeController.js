const recipeService = require('../services/recipeService');

function parseSteps(body) {
  const titles = Array.isArray(body.stepTitles) ? body.stepTitles : [body.stepTitles];
  const prompts = Array.isArray(body.stepPrompts) ? body.stepPrompts : [body.stepPrompts];
  const checks = Array.isArray(body.stepRequiredChecks) ? body.stepRequiredChecks : [body.stepRequiredChecks];
  const retries = Array.isArray(body.stepRetryCounts) ? body.stepRetryCounts : [body.stepRetryCounts];
  const approvals = Array.isArray(body.stepHumanApprovals) ? body.stepHumanApprovals : [body.stepHumanApprovals];

  return titles.map((title, index) => ({
    title,
    prompt: prompts[index],
    requiredChecks: checks[index],
    retryCount: retries[index],
    humanApproval: approvals[index] === '1'
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
    values: { steps: [{ title: 'Step 1', prompt: '', requiredChecks: '', retryCount: 0, humanApproval: false }] }
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

  if (!values.steps.length) {
    return 'Add at least one prompt step with a title and prompt text.';
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
  home,
  newRecipeForm,
  showRecipe,
  updateRecipe
};
