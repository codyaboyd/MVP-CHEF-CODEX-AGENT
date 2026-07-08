const express = require('express');
const pageController = require('../controllers/pageController');
const recipeController = require('../controllers/recipeController');

const router = express.Router();

router.get('/', pageController.dashboard);
router.get('/projects', pageController.projects);
router.post('/projects', pageController.createProject);
router.get('/recipes', pageController.recipes);
router.get('/recipes/new', recipeController.newRecipeForm);
router.get('/recipes/import', recipeController.importRecipeForm);
router.post('/recipes/import', recipeController.importRecipe);
router.post('/recipes', recipeController.createRecipe);
router.get('/recipes/:id', recipeController.showRecipe);
router.get('/recipes/:id/export', recipeController.exportRecipe);
router.get('/recipes/:id/export/preview', recipeController.exportRecipePreview);
router.get('/recipes/:id/edit', recipeController.editRecipeForm);
router.post('/recipes/:id', recipeController.updateRecipe);
router.post('/recipes/:id/duplicate', recipeController.duplicateRecipe);
router.post('/recipes/:id/delete', recipeController.deleteRecipe);
router.get('/runs/:id', pageController.runDetail);
router.get('/runs/:id/events', pageController.runEvents);
router.post('/runs/:id/pause', pageController.pauseRun);
router.post('/runs/:id/resume', pageController.resumeRun);
router.post('/runs/:id/quota-refill', pageController.setQuotaRefill);
router.post('/runs/:id/steps/:stepId/quality-gate-override', pageController.overrideQualityGate);
router.post('/runs/:id/cancel', pageController.cancelRun);
router.get('/settings', pageController.settings);
router.post('/settings', pageController.updateSettings);

module.exports = router;
