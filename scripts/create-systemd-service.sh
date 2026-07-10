#!/usr/bin/env bash
set -euo pipefail

SERVICE_NAME="${1:-${SERVICE_NAME:-mvp-chef-codex}}"
APP_DIR="${2:-${APP_DIR:-/opt/mvp-chef-codex}}"
APP_USER="${3:-${APP_USER:-www-data}}"
NPM_BIN="${4:-${NPM_BIN:-$(command -v npm || true)}}"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Please run this script with sudo." >&2
  exit 1
fi

if [[ -z "${NPM_BIN}" || ! -x "${NPM_BIN}" ]]; then
  echo "Unable to find an executable npm binary. Set NPM_BIN=/path/to/npm and rerun." >&2
  exit 1
fi

cat > "${SERVICE_FILE}" <<SERVICEEOF
[Unit]
Description=MVP Chef Codex Node.js application
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${APP_USER}
Group=${APP_USER}
WorkingDirectory=${APP_DIR}
Environment=NODE_ENV=production
Environment=HOST=0.0.0.0
Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
EnvironmentFile=-${APP_DIR}/.env
ExecStart=${NPM_BIN} start
Restart=always
RestartSec=5
SyslogIdentifier=${SERVICE_NAME}

[Install]
WantedBy=multi-user.target
SERVICEEOF

chmod 0644 "${SERVICE_FILE}"
echo "Created ${SERVICE_FILE}"
