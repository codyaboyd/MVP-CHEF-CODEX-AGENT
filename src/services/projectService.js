const fs = require('node:fs');
const path = require('node:path');
const db = require('../db');

const DEFAULT_COMMANDS = {
  packageManagerCommand: 'npm install',
  testCommand: 'npm test',
  buildCommand: 'npm run build',
  lintCommand: 'npm run lint'
};

const NODE_PACKAGE_MANAGERS = [
  { lockfile: 'pnpm-lock.yaml', name: 'pnpm', install: 'pnpm install', run: (script) => `pnpm ${script}` },
  { lockfile: 'yarn.lock', name: 'yarn', install: 'yarn install', run: (script) => `yarn ${script}` },
  { lockfile: 'bun.lockb', name: 'bun', install: 'bun install', run: (script) => `bun run ${script}` },
  { lockfile: 'bun.lock', name: 'bun', install: 'bun install', run: (script) => `bun run ${script}` },
  { lockfile: 'package-lock.json', name: 'npm', install: 'npm install', run: (script) => script === 'test' ? 'npm test' : `npm run ${script}` }
];

function fileExists(repoPath, fileName) {
  return fs.existsSync(path.join(repoPath, fileName));
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function detectNodeCommands(repoPath) {
  if (!fileExists(repoPath, 'package.json')) return null;

  const packageJson = readJsonFile(path.join(repoPath, 'package.json')) || {};
  const scripts = packageJson.scripts && typeof packageJson.scripts === 'object' ? packageJson.scripts : {};
  const manager = NODE_PACKAGE_MANAGERS.find((candidate) => fileExists(repoPath, candidate.lockfile)) || {
    name: 'npm',
    install: DEFAULT_COMMANDS.packageManagerCommand,
    run: (script) => script === 'test' ? 'npm test' : `npm run ${script}`
  };

  return {
    detectedType: 'node',
    packageManagerName: manager.name,
    packageManagerCommand: manager.install,
    testCommand: scripts.test ? manager.run('test') : DEFAULT_COMMANDS.testCommand,
    buildCommand: scripts.build ? manager.run('build') : DEFAULT_COMMANDS.buildCommand,
    lintCommand: scripts.lint ? manager.run('lint') : DEFAULT_COMMANDS.lintCommand,
    availableScripts: Object.keys(scripts).sort()
  };
}

function detectPythonCommands(repoPath) {
  const hasPyproject = fileExists(repoPath, 'pyproject.toml');
  const hasRequirements = fileExists(repoPath, 'requirements.txt');
  const hasUvLock = fileExists(repoPath, 'uv.lock');
  const hasPoetryLock = fileExists(repoPath, 'poetry.lock');
  if (!hasPyproject && !hasRequirements && !hasUvLock && !hasPoetryLock) return null;

  const packageManagerCommand = hasUvLock ? 'uv sync' : hasPoetryLock ? 'poetry install' : hasRequirements ? 'python -m pip install -r requirements.txt' : 'python -m pip install -e .';
  const runner = hasUvLock ? 'uv run ' : hasPoetryLock ? 'poetry run ' : '';
  return {
    detectedType: 'python',
    packageManagerName: hasUvLock ? 'uv' : hasPoetryLock ? 'poetry' : 'pip',
    packageManagerCommand,
    testCommand: `${runner}pytest`.trim(),
    buildCommand: hasPyproject ? 'python -m build' : '',
    lintCommand: `${runner}ruff check .`.trim(),
    availableScripts: []
  };
}

function detectMakeCommands(repoPath) {
  if (!fileExists(repoPath, 'Makefile') && !fileExists(repoPath, 'makefile')) return null;
  return {
    detectedType: 'make',
    packageManagerName: 'make',
    packageManagerCommand: '',
    testCommand: 'make test',
    buildCommand: 'make build',
    lintCommand: 'make lint',
    availableScripts: []
  };
}

function detectProjectCommands(repoPath) {
  const validation = validateProjectPath(repoPath);
  if (!validation.ok) {
    return { ok: false, message: validation.message, commands: { ...DEFAULT_COMMANDS } };
  }

  const detected = detectNodeCommands(validation.repoPath) || detectPythonCommands(validation.repoPath) || detectMakeCommands(validation.repoPath) || {
    detectedType: 'generic',
    packageManagerName: 'npm',
    ...DEFAULT_COMMANDS,
    availableScripts: []
  };

  return {
    ok: true,
    repoPath: validation.repoPath,
    isGitRepository: validation.isGitRepository,
    commands: {
      packageManagerCommand: detected.packageManagerCommand,
      testCommand: detected.testCommand,
      buildCommand: detected.buildCommand,
      lintCommand: detected.lintCommand
    },
    detectedType: detected.detectedType,
    packageManagerName: detected.packageManagerName,
    availableScripts: detected.availableScripts || []
  };
}

function normalizeProjectInput(input) {
  return {
    name: String(input.name || '').trim(),
    repoPath: String(input.repoPath || input.repo_path || '').trim(),
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

function getHealthChecks(project) {
  const checks = [];
  const repoPath = project.repo_path || project.repoPath;
  checks.push({
    key: 'repo_path_exists',
    label: 'Repo path exists',
    ok: Boolean(repoPath && fs.existsSync(repoPath)),
    detail: repoPath || 'No repository path configured.'
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
  return { project, errors };
}

function withHealth(project) {
  const checks = getHealthChecks(project);
  return {
    ...project,
    health_checks: checks,
    health_status: checks.every((check) => check.ok) ? 'healthy' : 'needs_attention',
    health_score: Math.round((checks.filter((check) => check.ok).length / checks.length) * 100)
  };
}

function getProjects() {
  return db.prepare(`
    SELECT p.*, COUNT(CASE WHEN r.is_saved = 1 THEN 1 END) AS recipe_count,
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
      name, repo_path, default_branch,
      package_manager_command, test_command, build_command, lint_command, description, safe_mode
    ) VALUES (
      @name, @repoPath, @defaultBranch,
      @packageManagerCommand, @testCommand, @buildCommand, @lintCommand, @description, @safeMode
    )
  `).run(project);
}

function getOrCreateFolderProject(folderPath) {
  const validation = validateProjectPath(folderPath);
  if (!validation.ok) {
    const error = new Error(validation.message);
    error.validationErrors = [validation.message];
    throw error;
  }

  const existing = db.prepare('SELECT * FROM projects WHERE repo_path = ? ORDER BY id ASC LIMIT 1').get(validation.repoPath);
  if (existing) return existing;

  const detected = detectProjectCommands(validation.repoPath);
  const result = createProject({
    name: path.basename(validation.repoPath) || validation.repoPath,
    repoPath: validation.repoPath,
    defaultBranch: 'main',
    description: 'Added from the Codex prompt composer.',
    ...(detected.commands || {})
  });
  return db.prepare('SELECT * FROM projects WHERE id = ?').get(result.lastInsertRowid);
}

module.exports = {
  DEFAULT_COMMANDS,
  createProject,
  detectProjectCommands,
  getHealthChecks,
  getOrCreateFolderProject,
  getProjects,
  validateProjectPath,
  validateRepoPath: validateProjectPath,
  normalizeProjectInput,
  validateProject
};
