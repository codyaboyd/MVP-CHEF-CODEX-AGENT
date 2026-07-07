const express = require('express');
const pageController = require('../controllers/pageController');
const recipeController = require('../controllers/recipeController');

const router = express.Router();

router.get('/', pageController.dashboard);
router.get('/projects', pageController.projects);
router.get('/recipes', pageController.recipes);
router.get('/recipes/new', recipeController.newRecipeForm);
router.post('/recipes', recipeController.createRecipe);
router.get('/recipes/:id', recipeController.showRecipe);
router.get('/runs/:id', pageController.runDetail);
router.get('/settings', pageController.settings);

module.exports = router;
