#!/usr/bin/env bash
set -euo pipefail

APP_NAME="${APP_NAME:-mvp-chef-codex}"
APP_DIR="${APP_DIR:-/opt/${APP_NAME}}"
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"
DRY_RUN="${DRY_RUN:-0}"

run() {
  if [[ "${DRY_RUN}" == "1" ]]; then
    printf 'Would run:'
    printf ' %q' "$@"
    printf '\n'
  else
    "$@"
  fi
}

echo "Disk usage before cleanup:"
df -h "${APP_DIR}" 2>/dev/null || df -h /

if command -v docker >/dev/null 2>&1; then
  echo "Removing unused Docker containers, networks, images, and build cache older than 7 days..."
  run docker system prune --all --force --filter 'until=168h'
  run docker builder prune --all --force --filter 'until=168h'
else
  echo "Docker is not installed; skipping Docker cleanup."
fi

if [[ -d "${APP_DIR}/backups" ]]; then
  echo "Removing database backups older than ${BACKUP_RETENTION_DAYS} days..."
  if [[ "${DRY_RUN}" == "1" ]]; then
    find "${APP_DIR}/backups" -type f -mtime "+${BACKUP_RETENTION_DAYS}" -print
  else
    find "${APP_DIR}/backups" -type f -mtime "+${BACKUP_RETENTION_DAYS}" -delete
  fi
fi

if command -v npm >/dev/null 2>&1; then
  echo "Verifying and compacting the npm cache..."
  run npm cache verify
fi

echo "Disk usage after cleanup:"
df -h "${APP_DIR}" 2>/dev/null || df -h /
