#!/usr/bin/env bash
set -euo pipefail

APP_NAME="${APP_NAME:-mvp-chef-codex}"
SERVICE_NAME="${SERVICE_NAME:-${APP_NAME}}"
APP_DIR="${APP_DIR:-/opt/${APP_NAME}}"
APP_USER="${APP_USER:-${SUDO_USER:-$USER}}"
NODE_MAJOR="${NODE_MAJOR:-20}"
PORT="${PORT:-3000}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Please run this installer with sudo: sudo $0" >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive

echo "Installing system dependencies..."
apt-get update
apt-get install -y ca-certificates curl gnupg git build-essential iproute2 rsync sqlite3

if ! command -v node >/dev/null 2>&1 || [[ "$(node -p 'Number(process.versions.node.split(`.`)[0])')" -lt "${NODE_MAJOR}" ]]; then
  echo "Installing Node.js ${NODE_MAJOR}.x..."
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" > /etc/apt/sources.list.d/nodesource.list
  apt-get update
  apt-get install -y nodejs
fi

echo "Creating application directory at ${APP_DIR}..."
install -d -o "${APP_USER}" -g "${APP_USER}" "${APP_DIR}"
rsync -a --delete \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude 'data' \
  "${REPO_DIR}/" "${APP_DIR}/"
chown -R "${APP_USER}:${APP_USER}" "${APP_DIR}"

if [[ ! -f "${APP_DIR}/.env" ]]; then
  echo "Creating ${APP_DIR}/.env..."
  if [[ -f "${APP_DIR}/.env.example" ]]; then
    cp "${APP_DIR}/.env.example" "${APP_DIR}/.env"
  else
    cat > "${APP_DIR}/.env" <<ENVEOF
NODE_ENV=production
PORT=${PORT}
DATABASE_PATH=./data/mvp-chef-codex.sqlite
APP_NAME=MVP Chef Codex
ENVEOF
  fi
  sed -i 's/^NODE_ENV=.*/NODE_ENV=production/' "${APP_DIR}/.env"
  sed -i "s/^PORT=.*/PORT=${PORT}/" "${APP_DIR}/.env"
  chown "${APP_USER}:${APP_USER}" "${APP_DIR}/.env"
fi

install -d -o "${APP_USER}" -g "${APP_USER}" "${APP_DIR}/data" "${APP_DIR}/backups"

port_listeners() {
  ss -H -ltnp "sport = :${PORT}" 2>/dev/null || true
}

wait_for_port_release() {
  for _ in {1..10}; do
    if [[ -z "$(port_listeners)" ]]; then
      return 0
    fi
    sleep 1
  done
  return 1
}

if systemctl list-unit-files "${SERVICE_NAME}.service" >/dev/null 2>&1; then
  echo "Stopping existing ${SERVICE_NAME} service before deployment..."
  systemctl stop "${SERVICE_NAME}" || true
  wait_for_port_release || true
fi

if [[ -n "$(port_listeners)" ]]; then
  echo "Port ${PORT} is already in use, so ${SERVICE_NAME} cannot bind to it." >&2
  echo "Listeners on port ${PORT}:" >&2
  port_listeners >&2
  echo "Stop the conflicting process or rerun with a different PORT value." >&2
  exit 1
fi

echo "Installing npm packages..."
sudo -u "${APP_USER}" bash -lc "cd '${APP_DIR}' && npm ci --omit=dev"

NPM_BIN="$(command -v npm || true)"
"${APP_DIR}/scripts/create-systemd-service.sh" "${SERVICE_NAME}" "${APP_DIR}" "${APP_USER}" "${NPM_BIN}"

systemctl daemon-reload
systemctl enable "${SERVICE_NAME}"
systemctl restart "${SERVICE_NAME}"

echo "Waiting for ${SERVICE_NAME} to report healthy on port ${PORT}..."
SERVICE_READY=0
for _ in {1..20}; do
  if curl -fsS "http://127.0.0.1:${PORT}/healthz" >/dev/null; then
    SERVICE_READY=1
    break
  fi
  sleep 1
done

if [[ "${SERVICE_READY}" -ne 1 ]]; then
  echo "${SERVICE_NAME} did not become healthy at http://127.0.0.1:${PORT}/healthz." >&2
  echo "Service status:" >&2
  systemctl status "${SERVICE_NAME}" --no-pager >&2 || true
  echo "Recent logs:" >&2
  journalctl -u "${SERVICE_NAME}" -n 80 --no-pager >&2 || true
  exit 1
fi

HOST_IP="$(hostname -I | awk '{print $1}')"
echo "Deployment complete."
echo "Local URL: http://localhost:${PORT}"
if [[ -n "${HOST_IP}" ]]; then
  echo "Network URL: http://${HOST_IP}:${PORT}"
fi
