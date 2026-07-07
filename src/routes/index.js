const express = require('express');
const recipeController = require('../controllers/recipeController');

const router = express.Router();

router.get('/', recipeController.home);
router.get('/recipes/new', recipeController.newRecipeForm);
router.post('/recipes', recipeController.createRecipe);
router.get('/recipes/:id', recipeController.showRecipe);

module.exports = router;
