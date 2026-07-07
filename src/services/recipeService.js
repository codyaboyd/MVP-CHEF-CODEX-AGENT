const db = require('../db');

function parseLines(value) {
  return value.split('\n').map((line) => line.trim()).filter(Boolean);
}

function serializeRecipe(row) {
  return {
    ...row,
    ingredientsList: parseLines(row.ingredients),
    instructionSteps: parseLines(row.instructions)
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
  const result = db.prepare(`
    INSERT INTO recipes (title, phase, summary, ingredients, instructions)
    VALUES (?, ?, ?, ?, ?)
  `).run(title, phase, summary, ingredients, instructions);

  return getRecipeById(result.lastInsertRowid);
}

module.exports = {
  createRecipe,
  getAllRecipes,
  getRecipeById
};
