const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_MAX_DEPTH = 4;
const IGNORED_DIRECTORIES = new Set([
  '.cache', '.git', '.next', '.npm', '.pnpm-store', '.venv',
  'build', 'coverage', 'dist', 'node_modules', 'target', 'vendor'
]);

function defaultRoots() {
  const home = os.homedir();
  const configured = String(process.env.PROJECT_BROWSER_ROOTS || '')
    .split(path.delimiter)
    .map((root) => root.trim())
    .filter(Boolean);

  return configured.length ? configured : [
    path.join(home, 'Documents'),
    path.join(home, 'Desktop'),
    path.join(home, 'Downloads'),
    '/workspace'
  ];
}

function isDirectory(folderPath) {
  try {
    return fs.statSync(folderPath).isDirectory();
  } catch {
    return false;
  }
}

function scanProjectFolders(options = {}) {
  const maxDepth = Number.isInteger(options.maxDepth) ? options.maxDepth : DEFAULT_MAX_DEPTH;
  const roots = [...new Set((options.roots || defaultRoots()).map((root) => path.resolve(root)))]
    .filter(isDirectory);
  const folders = [];

  function visit(folderPath, rootPath, depth) {
    folders.push({
      name: path.basename(folderPath) || folderPath,
      path: folderPath,
      root: rootPath,
      depth
    });
    if (depth >= maxDepth) return;

    let entries;
    try {
      entries = fs.readdirSync(folderPath, { withFileTypes: true });
    } catch {
      return;
    }

    entries
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .filter((entry) => !entry.name.startsWith('.') && !IGNORED_DIRECTORIES.has(entry.name.toLowerCase()))
      .sort((left, right) => left.name.localeCompare(right.name))
      .forEach((entry) => visit(path.join(folderPath, entry.name), rootPath, depth + 1));
  }

  roots.forEach((root) => visit(root, root, 0));
  return { folders, roots, maxDepth };
}

function createProjectFolder(parentPath, folderName) {
  const parent = String(parentPath || '').trim();
  const name = String(folderName || '').trim();

  if (!parent || parent.includes('\0') || !path.isAbsolute(parent)) {
    const error = new Error('Choose an existing absolute parent folder.');
    error.code = 'INVALID_PARENT_FOLDER';
    throw error;
  }
  if (!name || name === '.' || name === '..' || name.includes('\0') || path.basename(name) !== name) {
    const error = new Error('Directory name must be a single folder name without slashes.');
    error.code = 'INVALID_FOLDER_NAME';
    throw error;
  }

  const resolvedParent = path.resolve(parent);
  if (!isDirectory(resolvedParent)) {
    const error = new Error('The parent folder does not exist or is not a directory.');
    error.code = 'INVALID_PARENT_FOLDER';
    throw error;
  }

  const folderPath = path.join(resolvedParent, name);
  try {
    fs.mkdirSync(folderPath);
  } catch (error) {
    if (error.code === 'EEXIST') {
      const conflict = new Error('A file or directory with that name already exists.');
      conflict.code = 'FOLDER_EXISTS';
      throw conflict;
    }
    if (error.code === 'EACCES' || error.code === 'EPERM' || error.code === 'EROFS') {
      const denied = new Error('The application cannot create a directory in that parent folder.');
      denied.code = 'FOLDER_PERMISSION_DENIED';
      throw denied;
    }
    throw error;
  }

  return { name, path: folderPath, parent: resolvedParent };
}

module.exports = { createProjectFolder, DEFAULT_MAX_DEPTH, IGNORED_DIRECTORIES, defaultRoots, scanProjectFolders };
