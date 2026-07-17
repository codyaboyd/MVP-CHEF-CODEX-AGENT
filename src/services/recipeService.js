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

function parseRawTextBlocks(value = '') {
  return String(value || '')
    .split(/\n\s*(?:---+|\n)\s*/g)
    .map((block) => block.trim())
    .filter(Boolean);
}

function normalizeProjectId(projectId) {
  return projectId ? Number(projectId) : null;
}

const APPROVAL_MODES = new Set(['manual_steps', 'none', 'before_step', 'after_codex', 'before_commit', 'all']);
const STEP_APPROVAL_OVERRIDES = new Set(['inherit', 'none', 'before_step', 'after_codex', 'before_commit', 'all']);

function normalizeApprovalMode(value = 'manual_steps') {
  return APPROVAL_MODES.has(value) ? value : 'manual_steps';
}

function normalizeStepApprovalOverride(value = 'inherit') {
  return STEP_APPROVAL_OVERRIDES.has(value) ? value : 'inherit';
}

function normalizeStep(step = {}, index = 0) {
  const requiredChecks = Array.isArray(step.requiredChecks)
    ? step.requiredChecks.join('\n')
    : (step.requiredChecks || step.required_checks || '');

  return {
    id: step.id ? Number(step.id) : null,
    title: (step.title || `Step ${index + 1}`).trim(),
    prompt: (step.prompt || '').trim(),
    requiredChecks: requiredChecks.trim(),
    retryCount: Number.parseInt(step.retryCount ?? step.retry_count ?? step.maxRetries ?? 0, 10) || 0,
    humanApproval: Boolean(step.humanApproval ?? step.human_approval ?? step.requiresApproval),
    approvalOverride: normalizeStepApprovalOverride(step.approvalOverride || step.approval_override),
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
    approvalOverride: step.approval_override || 'inherit',
    orderIndex: step.step_order
  }));
}

function buildRecipeJson(recipe, steps, ingredients) {
  const approvalMode = normalizeApprovalMode(recipe.approval_mode || recipe.approvalMode);
  const recipeJson = {
    name: recipe.title,
    version: recipe.phase || '1.0.0',
    description: recipe.summary,
    steps: steps.map((step) => {
      const stepJson = {
        title: step.title,
        prompt: step.prompt,
        requiredChecks: parseLines(step.requiredChecks),
        maxRetries: step.retryCount,
        requiresApproval: step.humanApproval
      };
      if ((step.approvalOverride || 'inherit') !== 'inherit') stepJson.approvalOverride = step.approvalOverride;
      return stepJson;
    })
  };

  if (approvalMode !== 'manual_steps') recipeJson.approvalMode = approvalMode;

  if (ingredients.length) {
    recipeJson.ingredients = ingredients;
  }

  return recipeJson;
}

function validateRecipeJson(recipe) {
  const errors = [];

  if (!recipe || typeof recipe !== 'object' || Array.isArray(recipe)) {
    return ['Recipe JSON must be an object.'];
  }

  if (typeof recipe.name !== 'string' || !recipe.name.trim()) {
    errors.push('Recipe name is required and must be a non-empty string.');
  }
  if (typeof recipe.version !== 'string' || !recipe.version.trim()) {
    errors.push('Recipe version is required and must be a non-empty string.');
  }
  if (typeof recipe.description !== 'string' || !recipe.description.trim()) {
    errors.push('Recipe description is required and must be a non-empty string.');
  }
  if (recipe.ingredients !== undefined && (!Array.isArray(recipe.ingredients) || recipe.ingredients.some((item) => typeof item !== 'string'))) {
    errors.push('Recipe ingredients must be an array of strings when provided.');
  }
  if (!Array.isArray(recipe.steps) || recipe.steps.length === 0) {
    errors.push('Recipe steps must be a non-empty array.');
    return errors;
  }

  recipe.steps.forEach((step, index) => {
    const label = `Step ${index + 1}`;
    if (!step || typeof step !== 'object' || Array.isArray(step)) {
      errors.push(`${label} must be an object.`);
      return;
    }
    if (typeof step.title !== 'string' || !step.title.trim()) {
      errors.push(`${label} title is required and must be a non-empty string.`);
    }
    if (typeof step.prompt !== 'string' || !step.prompt.trim()) {
      errors.push(`${label} prompt is required and must be a non-empty string.`);
    }
    if (!Array.isArray(step.requiredChecks) || step.requiredChecks.some((check) => typeof check !== 'string')) {
      errors.push(`${label} requiredChecks must be an array of strings.`);
    }
    if (!Number.isInteger(step.maxRetries) || step.maxRetries < 0) {
      errors.push(`${label} maxRetries must be a non-negative integer.`);
    }
    if (typeof step.requiresApproval !== 'boolean') {
      errors.push(`${label} requiresApproval must be true or false.`);
    }
    if (step.approvalOverride !== undefined && !STEP_APPROVAL_OVERRIDES.has(step.approvalOverride)) {
      errors.push(`${label} approvalOverride must be inherit, none, before_step, after_codex, before_commit, or all.`);
    }
  });

  return errors;
}

function parseRecipeJson(jsonText) {
  if (!jsonText || !jsonText.trim()) {
    return { errors: ['Paste recipe JSON or choose a JSON file before importing.'] };
  }

  try {
    const recipe = JSON.parse(jsonText);
    const errors = validateRecipeJson(recipe);
    return errors.length ? { errors } : { recipe };
  } catch (error) {
    return { errors: [`Recipe JSON is malformed: ${error.message}`] };
  }
}

function serializeRecipe(row) {
  const recipeJson = parseJson(row.exported_json || row.imported_json, {});
  const steps = getRecipeSteps(row.id);
  const ingredients = Array.isArray(recipeJson.ingredients) ? recipeJson.ingredients : [];

  return {
    ...row,
    projectName: row.project_name,
    projectRepoPath: row.project_repo_path,
    projectId: row.project_id,
    title: row.name,
    approvalMode: row.approval_mode || 'manual_steps',
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
    SELECT recipes.*, projects.name AS project_name, projects.repo_path AS project_repo_path
    FROM recipes
    LEFT JOIN projects ON projects.id = recipes.project_id
    ORDER BY recipes.id ASC
  `).all().map(serializeRecipe);
}

function getRecipeById(id) {
  const recipe = db.prepare(`
    SELECT recipes.*, projects.name AS project_name, projects.repo_path AS project_repo_path
    FROM recipes
    LEFT JOIN projects ON projects.id = recipes.project_id
    WHERE recipes.id = ?
  `).get(id);
  return recipe ? serializeRecipe(recipe) : null;
}

function getProjects() {
  return db.prepare('SELECT id, name FROM projects ORDER BY name ASC').all();
}

function createRecipe({ title, phase, summary, ingredients = '', projectId = null, approvalMode = 'manual_steps', steps = [], instructions = '', rawTextBlocks = '' }) {
  const rawSteps = parseRawTextBlocks(rawTextBlocks).map((prompt, index) => ({ title: `Text block ${index + 1}`, prompt }));
  const normalizedSteps = normalizeSteps(rawSteps.length ? rawSteps : (steps.length ? steps : parseLines(instructions).map((prompt, index) => ({ title: `Step ${index + 1}`, prompt }))));
  const ingredientList = parseLines(ingredients);
  const recipeJson = buildRecipeJson({ title, phase, summary, projectId: normalizeProjectId(projectId), approvalMode: normalizeApprovalMode(approvalMode) }, normalizedSteps, ingredientList);

  const create = db.transaction(() => {
    const result = db.prepare(`
      INSERT INTO recipes (project_id, name, version, description, approval_mode, imported_json, exported_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(normalizeProjectId(projectId), title, phase, summary, normalizeApprovalMode(approvalMode), JSON.stringify(recipeJson, null, 2), JSON.stringify(recipeJson, null, 2));

    saveSteps(result.lastInsertRowid, normalizedSteps);
    return result.lastInsertRowid;
  });

  return getRecipeById(create());
}

function importRecipeFromJson(jsonText, projectId = null) {
  const parsed = parseRecipeJson(jsonText);
  if (parsed.errors) {
    const error = new Error(parsed.errors.join(' '));
    error.validationErrors = parsed.errors;
    throw error;
  }

  const recipe = parsed.recipe;
  return createRecipe({
    title: recipe.name.trim(),
    phase: recipe.version.trim(),
    summary: recipe.description.trim(),
    ingredients: (recipe.ingredients || []).join('\n'),
    projectId,
    approvalMode: normalizeApprovalMode(recipe.approvalMode),
    steps: recipe.steps.map((step) => ({
      title: step.title,
      prompt: step.prompt,
      requiredChecks: step.requiredChecks,
      retryCount: step.maxRetries,
      humanApproval: step.requiresApproval,
      approvalOverride: step.approvalOverride || 'inherit'
    }))
  });
}

function getRecipeExport(id) {
  const recipe = getRecipeById(id);
  if (!recipe) return null;

  return buildRecipeJson({
    title: recipe.title,
    phase: recipe.phase,
    summary: recipe.summary,
    approvalMode: recipe.approvalMode
  }, recipe.steps.map((step) => ({
    title: step.title,
    prompt: step.prompt,
    requiredChecks: step.requiredChecks,
    retryCount: step.retryCount,
    humanApproval: step.humanApproval,
    approvalOverride: step.approvalOverride || 'inherit'
  })), recipe.ingredientsList);
}

function saveSteps(recipeId, steps) {
  const insertStep = db.prepare(`
    INSERT INTO recipe_steps (recipe_id, step_order, title, prompt, required_checks, retry_count, human_approval, approval_override)
    VALUES (@recipeId, @stepOrder, @title, @prompt, @requiredChecks, @retryCount, @humanApproval, @approvalOverride)
  `);

  steps.forEach((step) => {
    insertStep.run({ ...step, recipeId, humanApproval: step.humanApproval ? 1 : 0 });
  });
}

function updateRecipe(id, { title, phase, summary, ingredients = '', projectId = null, approvalMode = 'manual_steps', steps = [], rawTextBlocks = '' }) {
  const rawSteps = parseRawTextBlocks(rawTextBlocks).map((prompt, index) => ({ title: `Text block ${index + 1}`, prompt }));
  const normalizedSteps = normalizeSteps(rawSteps.length ? rawSteps : steps);
  const ingredientList = parseLines(ingredients);
  const recipeJson = buildRecipeJson({ title, phase, summary, projectId: normalizeProjectId(projectId), approvalMode: normalizeApprovalMode(approvalMode) }, normalizedSteps, ingredientList);

  const update = db.transaction(() => {
    db.prepare(`
      UPDATE recipes
      SET project_id = ?, name = ?, version = ?, description = ?, approval_mode = ?, exported_json = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(normalizeProjectId(projectId), title, phase, summary, normalizeApprovalMode(approvalMode), JSON.stringify(recipeJson, null, 2), id);
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
    approvalMode: normalizeApprovalMode(recipe.approvalMode),
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
  getRecipeExport,
  importRecipeFromJson,
  parseRawTextBlocks,
  parseRecipeJson,
  normalizeApprovalMode,
  normalizeStepApprovalOverride,
  updateRecipe
};
