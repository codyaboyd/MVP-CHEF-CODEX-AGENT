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

module.exports = { DEFAULT_MAX_DEPTH, IGNORED_DIRECTORIES, defaultRoots, scanProjectFolders };
