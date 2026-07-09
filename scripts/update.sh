#!/usr/bin/env bash
set -euo pipefail

APP_NAME="${APP_NAME:-mvp-chef-codex}"
SERVICE_NAME="${SERVICE_NAME:-${APP_NAME}}"
APP_DIR="${APP_DIR:-/opt/${APP_NAME}}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_USER="${APP_USER:-${SUDO_USER:-$USER}}"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Please run this updater with sudo: sudo $0" >&2
  exit 1
fi

if [[ -f "${APP_DIR}/scripts/backup-db.sh" ]]; then
  "${APP_DIR}/scripts/backup-db.sh"
fi

rsync -a --delete \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude 'data' \
  --exclude 'backups' \
  --exclude '.env' \
  "${REPO_DIR}/" "${APP_DIR}/"
chown -R "${APP_USER}:${APP_USER}" "${APP_DIR}"

sudo -u "${APP_USER}" bash -lc "cd '${APP_DIR}' && npm ci --omit=dev"
systemctl daemon-reload
systemctl restart "${SERVICE_NAME}"

echo "Update complete. Service status:"
systemctl --no-pager --lines=10 status "${SERVICE_NAME}"
