const dashboardService = require('../services/dashboardService');
const recipeService = require('../services/recipeService');
const projectService = require('../services/projectService');

function dashboard(req, res) {
  res.render('dashboard', {
    title: 'Dashboard',
    ...dashboardService.getDashboard()
  });
}

function projects(req, res) {
  res.render('projects', {
    title: 'Projects',
    projects: dashboardService.getProjects(),
    form: projectService.normalizeProjectInput({}),
    errors: []
  });
}

function createProject(req, res) {
  try {
    projectService.createProject(req.body);
    res.redirect('/projects');
  } catch (error) {
    if (!error.validationErrors) {
      throw error;
    }

    res.status(400).render('projects', {
      title: 'Projects',
      projects: dashboardService.getProjects(),
      form: error.project,
      errors: error.validationErrors
    });
  }
}

function recipes(req, res) {
  res.render('recipes', {
    title: 'Recipes',
    recipes: recipeService.getAllRecipes()
  });
}

function runDetail(req, res) {
  const run = dashboardService.getRunById(Number(req.params.id));
  const fallback = dashboardService.getRuns()[0];
  const demoRun = {
    id: Number(req.params.id),
    recipe_name: 'Product Brief Soufflé',
    project_name: 'Demo MVP Chef Project',
    status: 'baking',
    commit_sha: null,
    pr_url: null,
    steps: [
      { step_order: 1, recipe_step_title: 'Clarify the appetite', prompt: 'Gather constraints, target users, and measurable success signals.', status: 'completed' },
      { step_order: 2, recipe_step_title: 'Plate the brief', prompt: 'Draft the MVP brief and prep it for review.', status: 'baking' }
    ]
  };

  res.render('run-detail', {
    title: 'Run Detail',
    run: run || (fallback ? { ...fallback, steps: [] } : demoRun)
  });
}

function settings(req, res) {
  res.render('settings', {
    title: 'Settings',
    settings: dashboardService.getSettings()
  });
}

module.exports = {
  dashboard,
  projects,
  createProject,
  recipes,
  runDetail,
  settings
};
