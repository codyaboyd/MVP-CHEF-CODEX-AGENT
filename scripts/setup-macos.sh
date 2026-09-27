#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

command -v node >/dev/null 2>&1 || { echo "Node.js 20 or newer is required. Install it with: brew install node" >&2; exit 1; }
command -v npm >/dev/null 2>&1 || { echo "npm is required and should be installed with Node.js." >&2; exit 1; }
command -v git >/dev/null 2>&1 || { echo "Git is required. Install it with: xcode-select --install" >&2; exit 1; }

NODE_MAJOR="$(node -p 'Number(process.versions.node.split(`.`)[0])')"
if [[ "${NODE_MAJOR}" -lt 20 ]]; then
  echo "Node.js 20 or newer is required; found $(node --version). Install it with: brew install node" >&2
  exit 1
fi

if [[ ! -f .env ]]; then
  cp .env.example .env
  echo "Created .env from .env.example."
fi
mkdir -p data backups

echo "Installing exact dependencies from package-lock.json..."
npm ci

if command -v codex >/dev/null 2>&1; then
  echo "Codex CLI: $(codex --version 2>&1 | head -n 1)"
  codex login status || echo "Codex is installed but not authenticated. Run: codex login"
else
  echo "Warning: Codex CLI is not on PATH. Install and authenticate it before starting a recipe run." >&2
fi

echo "Setup complete. Start MVP Chef Codex with: npm start"
echo "Then open: http://localhost:${PORT:-3000}"
