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

function parseLines(value) {
  return value.split('\n').map((line) => line.trim()).filter(Boolean);
}

function getRecipeSteps(recipeId) {
  return db.prepare(`
    SELECT *
    FROM recipe_steps
    WHERE recipe_id = ?
    ORDER BY step_order ASC
  `).all(recipeId);
}

function serializeRecipe(row) {
  const recipeJson = parseJson(row.exported_json || row.imported_json, {});
  const steps = getRecipeSteps(row.id);
  const ingredients = Array.isArray(recipeJson.ingredients) ? recipeJson.ingredients : [];

  return {
    ...row,
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
  return db.prepare('SELECT * FROM recipes ORDER BY id ASC').all().map(serializeRecipe);
}

function getRecipeById(id) {
  const recipe = db.prepare('SELECT * FROM recipes WHERE id = ?').get(id);
  return recipe ? serializeRecipe(recipe) : null;
}

function createRecipe({ title, phase, summary, ingredients, instructions }) {
  const recipeJson = {
    name: title,
    version: phase,
    description: summary,
    ingredients: parseLines(ingredients),
    steps: parseLines(instructions).map((prompt, index) => ({
      title: `Step ${index + 1}`,
      prompt
    }))
  };

  const create = db.transaction(() => {
    const result = db.prepare(`
      INSERT INTO recipes (name, version, description, imported_json, exported_json)
      VALUES (?, ?, ?, ?, ?)
    `).run(title, phase, summary, JSON.stringify(recipeJson, null, 2), JSON.stringify(recipeJson, null, 2));

    const insertStep = db.prepare(`
      INSERT INTO recipe_steps (recipe_id, step_order, title, prompt)
      VALUES (?, ?, ?, ?)
    `);

    recipeJson.steps.forEach((step, index) => {
      insertStep.run(result.lastInsertRowid, index + 1, step.title, step.prompt);
    });

    return result.lastInsertRowid;
  });

  return getRecipeById(create());
}

module.exports = {
  createRecipe,
  getAllRecipes,
  getRecipeById
};
