const recipeService = require('../services/recipeService');

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

function newRecipeForm(req, res) {
  res.render('new-recipe', {
    title: 'Add a Recipe',
    values: {},
    error: null
  });
}

function createRecipe(req, res) {
  const { title, phase, summary, ingredients, instructions } = req.body;
  const values = { title, phase, summary, ingredients, instructions };

  if (!title || !phase || !summary || !ingredients || !instructions) {
    res.status(400).render('new-recipe', {
      title: 'Add a Recipe',
      values,
      error: 'Every recipe card needs a title, phase, summary, ingredients, and instructions.'
    });
    return;
  }

  const recipe = recipeService.createRecipe(values);
  res.redirect(`/recipes/${recipe.id}`);
}

module.exports = {
  createRecipe,
  home,
  newRecipeForm,
  showRecipe
};
