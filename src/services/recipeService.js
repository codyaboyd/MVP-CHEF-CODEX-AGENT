const db = require('../db');

function parseJson(value, fallback) {
  if (!value) {
    return fallback;
  }

  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function parseLines(value = '') {
  return value.split('\n').map((line) => line.trim()).filter(Boolean);
}

function normalizeProjectId(projectId) {
  return projectId ? Number(projectId) : null;
}

function normalizeStep(step = {}, index = 0) {
  return {
    id: step.id ? Number(step.id) : null,
    title: (step.title || `Step ${index + 1}`).trim(),
    prompt: (step.prompt || '').trim(),
    requiredChecks: (step.requiredChecks || step.required_checks || '').trim(),
    retryCount: Number.parseInt(step.retryCount || step.retry_count || 0, 10) || 0,
    humanApproval: Boolean(step.humanApproval || step.human_approval),
    stepOrder: index + 1
  };
}

function normalizeSteps(steps = []) {
  return steps.map(normalizeStep).filter((step) => step.title && step.prompt);
}

function getRecipeSteps(recipeId) {
  return db.prepare(`
    SELECT *
    FROM recipe_steps
    WHERE recipe_id = ?
    ORDER BY step_order ASC
  `).all(recipeId).map((step) => ({
    ...step,
    requiredChecks: step.required_checks || '',
    retryCount: step.retry_count || 0,
    humanApproval: Boolean(step.human_approval),
    orderIndex: step.step_order
  }));
}

function buildRecipeJson(recipe, steps, ingredients) {
  return {
    name: recipe.title,
    version: recipe.phase,
    description: recipe.summary,
    ingredients,
    project_id: recipe.projectId,
    steps: steps.map((step) => ({
      title: step.title,
      prompt: step.prompt,
      required_checks: step.requiredChecks,
      retry_count: step.retryCount,
      human_approval: step.humanApproval,
      order_index: step.stepOrder
    }))
  };
}

function serializeRecipe(row) {
  const recipeJson = parseJson(row.exported_json || row.imported_json, {});
  const steps = getRecipeSteps(row.id);
  const ingredients = Array.isArray(recipeJson.ingredients) ? recipeJson.ingredients : [];

  return {
    ...row,
    projectName: row.project_name,
    projectId: row.project_id,
    title: row.name,
    phase: row.version,
    summary: row.description,
    ingredients: ingredients.join('\n'),
    instructions: steps.map((step) => step.prompt).join('\n'),
    ingredientsList: ingredients,
    instructionSteps: steps.map((step) => step.prompt),
    steps
  };
}

function getAllRecipes() {
  return db.prepare(`
    SELECT recipes.*, projects.name AS project_name
    FROM recipes
    LEFT JOIN projects ON projects.id = recipes.project_id
    ORDER BY recipes.id ASC
  `).all().map(serializeRecipe);
}

function getRecipeById(id) {
  const recipe = db.prepare(`
    SELECT recipes.*, projects.name AS project_name
    FROM recipes
    LEFT JOIN projects ON projects.id = recipes.project_id
    WHERE recipes.id = ?
  `).get(id);
  return recipe ? serializeRecipe(recipe) : null;
}

function getProjects() {
  return db.prepare('SELECT id, name FROM projects ORDER BY name ASC').all();
}

function createRecipe({ title, phase, summary, ingredients = '', projectId = null, steps = [], instructions = '' }) {
  const normalizedSteps = normalizeSteps(steps.length ? steps : parseLines(instructions).map((prompt, index) => ({ title: `Step ${index + 1}`, prompt })));
  const ingredientList = parseLines(ingredients);
  const recipeJson = buildRecipeJson({ title, phase, summary, projectId: normalizeProjectId(projectId) }, normalizedSteps, ingredientList);

  const create = db.transaction(() => {
    const result = db.prepare(`
      INSERT INTO recipes (project_id, name, version, description, imported_json, exported_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(normalizeProjectId(projectId), title, phase, summary, JSON.stringify(recipeJson, null, 2), JSON.stringify(recipeJson, null, 2));

    saveSteps(result.lastInsertRowid, normalizedSteps);
    return result.lastInsertRowid;
  });

  return getRecipeById(create());
}

function saveSteps(recipeId, steps) {
  const insertStep = db.prepare(`
    INSERT INTO recipe_steps (recipe_id, step_order, title, prompt, required_checks, retry_count, human_approval)
    VALUES (@recipeId, @stepOrder, @title, @prompt, @requiredChecks, @retryCount, @humanApproval)
  `);

  steps.forEach((step) => {
    insertStep.run({ ...step, recipeId, humanApproval: step.humanApproval ? 1 : 0 });
  });
}

function updateRecipe(id, { title, phase, summary, ingredients = '', projectId = null, steps = [] }) {
  const normalizedSteps = normalizeSteps(steps);
  const ingredientList = parseLines(ingredients);
  const recipeJson = buildRecipeJson({ title, phase, summary, projectId: normalizeProjectId(projectId) }, normalizedSteps, ingredientList);

  const update = db.transaction(() => {
    db.prepare(`
      UPDATE recipes
      SET project_id = ?, name = ?, version = ?, description = ?, exported_json = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(normalizeProjectId(projectId), title, phase, summary, JSON.stringify(recipeJson, null, 2), id);
    db.prepare('DELETE FROM recipe_steps WHERE recipe_id = ?').run(id);
    saveSteps(id, normalizedSteps);
  });

  update();
  return getRecipeById(id);
}

function duplicateRecipe(id) {
  const recipe = getRecipeById(id);
  if (!recipe) return null;
  return createRecipe({
    title: `${recipe.title} Copy`,
    phase: recipe.phase,
    summary: recipe.summary,
    ingredients: recipe.ingredients,
    projectId: recipe.projectId,
    steps: recipe.steps.map((step) => ({ ...step }))
  });
}

function deleteRecipe(id) {
  return db.prepare('DELETE FROM recipes WHERE id = ?').run(id).changes > 0;
}

module.exports = {
  createRecipe,
  deleteRecipe,
  duplicateRecipe,
  getAllRecipes,
  getProjects,
  getRecipeById,
  updateRecipe
};
