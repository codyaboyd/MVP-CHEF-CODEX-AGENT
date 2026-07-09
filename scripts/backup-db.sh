#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
ENV_FILE="${ENV_FILE:-${APP_DIR}/.env}"
BACKUP_DIR="${BACKUP_DIR:-${APP_DIR}/backups}"

if [[ -z "${DATABASE_PATH:-}" && -f "${ENV_FILE}" ]]; then
  DATABASE_PATH="$(awk -F= '/^DATABASE_PATH=/ { sub(/^[^=]*=/, ""); print; exit }' "${ENV_FILE}")"
fi

DATABASE_PATH="${DATABASE_PATH:-./data/mvp-chef-codex.sqlite}"
if [[ "${DATABASE_PATH}" != /* ]]; then
  DATABASE_PATH="${APP_DIR}/${DATABASE_PATH}"
fi

if [[ ! -f "${DATABASE_PATH}" ]]; then
  echo "Database not found: ${DATABASE_PATH}" >&2
  exit 1
fi

mkdir -p "${BACKUP_DIR}"
BACKUP_FILE="${BACKUP_DIR}/$(basename "${DATABASE_PATH}" .sqlite)-$(date +%Y%m%d-%H%M%S).sqlite"
sqlite3 "${DATABASE_PATH}" ".backup '${BACKUP_FILE}'"
echo "Database backup created: ${BACKUP_FILE}"
