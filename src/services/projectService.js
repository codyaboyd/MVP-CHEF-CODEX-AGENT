const fs = require('node:fs');
const path = require('node:path');
const db = require('../db');

const DEFAULT_COMMANDS = {
  packageManagerCommand: 'npm install',
  testCommand: 'npm test',
  buildCommand: 'npm run build',
  lintCommand: 'npm run lint'
};

function normalizeProjectInput(input) {
  return {
    name: String(input.name || '').trim(),
    repoPath: String(input.repoPath || input.repo_path || '').trim(),
    githubRepoSlug: String(input.githubRepoSlug || input.github_repo_slug || '').trim(),
    defaultBranch: String(input.defaultBranch ?? input.default_branch ?? 'main').trim(),
    packageManagerCommand: String(input.packageManagerCommand || input.package_manager_command || DEFAULT_COMMANDS.packageManagerCommand).trim(),
    testCommand: String(input.testCommand || input.test_command || DEFAULT_COMMANDS.testCommand).trim(),
    buildCommand: String(input.buildCommand || input.build_command || DEFAULT_COMMANDS.buildCommand).trim(),
    lintCommand: String(input.lintCommand || input.lint_command || DEFAULT_COMMANDS.lintCommand).trim(),
    description: String(input.description || '').trim(),
    safeMode: (input.safeMode === true || input.safeMode === 'true' || input.safe_mode === 1) ? 1 : 0
  };
}


function validateProjectPath(repoPath) {
  if (typeof repoPath !== 'string' || !repoPath.trim() || repoPath.includes('\0')) {
    return { ok: false, message: 'Local project folder path is required.' };
  }
  if (!path.isAbsolute(repoPath)) {
    return { ok: false, message: 'Local project folder path must be an absolute path.' };
  }
  const resolved = path.resolve(repoPath);
  if (!fs.existsSync(resolved)) {
    return { ok: false, message: 'Local project folder path must exist.' };
  }
  if (!fs.statSync(resolved).isDirectory()) {
    return { ok: false, message: 'Local project folder path must be a directory.' };
  }
  return { ok: true, repoPath: resolved, isGitRepository: fs.existsSync(path.join(resolved, '.git')) };
}

function isGitHubRepoSlug(value) {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value) && !value.includes('..');
}

function getHealthChecks(project) {
  const checks = [];
  const repoPath = project.repo_path || project.repoPath;
  const githubRepoSlug = project.github_repo_slug || project.githubRepoSlug;
  const githubEnabled = project.githubAutomationEnabled !== false && project.github_automation_enabled !== 0;
  const defaultBranch = project.default_branch || project.defaultBranch;

  checks.push({
    key: 'repo_path_exists',
    label: 'Repo path exists',
    ok: Boolean(repoPath && fs.existsSync(repoPath)),
    detail: repoPath || 'No repository path configured.'
  });

  checks.push({
    key: 'repo_path_git_repository',
    label: 'Git repository available',
    ok: true,
    detail: repoPath && fs.existsSync(path.join(repoPath, '.git')) ? path.join(repoPath, '.git') : 'Not required for local-only runs.'
  });

  checks.push({
    key: 'github_repo_slug_valid',
    label: 'GitHub repo slug is valid',
    ok: !githubEnabled || !githubRepoSlug || isGitHubRepoSlug(githubRepoSlug),
    detail: githubRepoSlug || (githubEnabled ? 'Optional unless GitHub automation is used.' : 'GitHub automation disabled for local-only use.')
  });

  checks.push({
    key: 'default_branch_set',
    label: 'Default branch is set',
    ok: Boolean(defaultBranch),
    detail: defaultBranch || 'No default branch configured.'
  });

  return checks;
}

function validateProject(input) {
  const project = normalizeProjectInput(input);
  const errors = [];

  if (!project.name) errors.push('Project name is required.');
  const repoPathValidation = validateProjectPath(project.repoPath);
  if (!repoPathValidation.ok) {
    errors.push(repoPathValidation.message);
  } else {
    project.repoPath = repoPathValidation.repoPath;
  }
  if (project.githubRepoSlug && !isGitHubRepoSlug(project.githubRepoSlug)) errors.push('GitHub repo slug must use owner/repo format.');
  if (!project.defaultBranch) errors.push('Default branch is required.');

  return { project, errors };
}

function withHealth(project) {
  const checks = getHealthChecks(project);
  return {
    ...project,
    health_checks: checks,
    health_status: checks.every((check) => check.ok) ? 'healthy' : 'needs_attention',
    health_score: Math.round((checks.filter((check) => check.ok).length / checks.length) * 100),
    github_repo_url: project.github_repo_slug ? `https://github.com/${project.github_repo_slug}` : project.github_repo_url
  };
}

function getProjects() {
  return db.prepare(`
    SELECT p.*, COUNT(r.id) AS recipe_count,
           l.run_id AS lock_run_id, l.owner AS lock_owner, l.expires_at AS lock_expires_at, l.heartbeat_at AS lock_heartbeat_at
    FROM projects p
    LEFT JOIN recipes r ON r.project_id = p.id
    LEFT JOIN project_run_locks l ON l.project_id = p.id AND l.expires_at > datetime('now')
    GROUP BY p.id
    ORDER BY p.updated_at DESC, p.id ASC
  `).all().map(withHealth);
}

function createProject(input) {
  const { project, errors } = validateProject(input);
  if (errors.length) {
    const error = new Error(errors.join(' '));
    error.validationErrors = errors;
    error.project = project;
    throw error;
  }

  return db.prepare(`
    INSERT INTO projects (
      name, repo_path, github_repo_slug, default_branch,
      package_manager_command, test_command, build_command, lint_command, description, safe_mode, github_repo_url
    ) VALUES (
      @name, @repoPath, @githubRepoSlug, @defaultBranch,
      @packageManagerCommand, @testCommand, @buildCommand, @lintCommand, @description, @safeMode, @githubRepoUrl
    )
  `).run({ ...project, githubRepoUrl: project.githubRepoSlug ? `https://github.com/${project.githubRepoSlug}` : '' });
}

module.exports = {
  DEFAULT_COMMANDS,
  createProject,
  getHealthChecks,
  getProjects,
  isGitHubRepoSlug,
  validateProjectPath,
  validateRepoPath: validateProjectPath,
  normalizeProjectInput,
  validateProject
};
