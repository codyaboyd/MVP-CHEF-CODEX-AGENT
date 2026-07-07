const db = require('../db');
const recipeService = require('./recipeService');
const projectService = require('./projectService');

function getProjects() {
  return projectService.getProjects();
}


function getRuns() {
  return db.prepare(`
    SELECT runs.*, recipes.name AS recipe_name, projects.name AS project_name
    FROM runs
    LEFT JOIN recipes ON recipes.id = runs.recipe_id
    LEFT JOIN projects ON projects.id = runs.project_id
    ORDER BY runs.created_at DESC, runs.id ASC
  `).all();
}

function getRunById(id) {
  const run = db.prepare(`
    SELECT runs.*, recipes.name AS recipe_name, projects.name AS project_name
    FROM runs
    LEFT JOIN recipes ON recipes.id = runs.recipe_id
    LEFT JOIN projects ON projects.id = runs.project_id
    WHERE runs.id = ?
  `).get(id);

  if (run) {
    run.steps = db.prepare(`
      SELECT run_steps.*, recipe_steps.title AS recipe_step_title, recipe_steps.prompt
      FROM run_steps
      LEFT JOIN recipe_steps ON recipe_steps.id = run_steps.recipe_step_id
      WHERE run_steps.run_id = ?
      ORDER BY run_steps.step_order ASC
    `).all(id);
  }

  return run;
}

function getSettings() {
  return db.prepare('SELECT * FROM app_settings ORDER BY key ASC').all();
}

function getDashboard() {
  const recipes = recipeService.getAllRecipes();
  const projects = getProjects();
  const runs = getRuns();
  const completedRuns = runs.filter((run) => run.status === 'completed').length;
  const progress = runs.length ? Math.round((completedRuns / runs.length) * 100) : 68;

  return {
    recipes,
    projects,
    runs,
    stats: {
      recipes: recipes.length,
      projects: projects.length,
      runs: runs.length,
      progress
    }
  };
}

module.exports = {
  getDashboard,
  getProjects,
  getRunById,
  getRuns,
  getSettings
};
