#!/usr/bin/env bash

set -euo pipefail

# Lockstone helper CLI
# Provides one-command build/deploy/start/stop across backend, frontend, and arb-rs

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

BACKEND_DIR="${REPO_ROOT}/backend"
FRONTEND_DIR="${REPO_ROOT}/frontend"
ARB_DIR="${REPO_ROOT}/arb-rs"

# Destination for built frontend static files
WWW_DIR="${WWW_DIR:-/var/www/lockstone}"

# Systemd unit names
BACKEND_SERVICE="lockstone-backend"
ARB_SERVICE="lockstone-arb"
NGINX_SERVICE="nginx"
TARGET_UNIT="lockstone.target"

usage() {
  cat <<EOF
Lockstone CLI

Usage:
  $(basename "$0") build            Build backend, frontend, and arb-rs
  $(basename "$0") deploy           Build everything and restart services + reload nginx
  $(basename "$0") start            Start all services via ${TARGET_UNIT}
  $(basename "$0") stop             Stop all services via ${TARGET_UNIT}
  $(basename "$0") restart          Restart all services via ${TARGET_UNIT}
  $(basename "$0") status           Show status of backend, arb, and nginx

Advanced service control:
  $(basename "$0") svc <backend|arb|nginx> <start|stop|restart|status>

Environment overrides:
  WWW_DIR=/var/www/lockstone   Destination directory for frontend dist (default: /var/www/lockstone)

Examples:
  sudo $(basename "$0") build
  sudo $(basename "$0") start
  sudo $(basename "$0") deploy
EOF
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || { echo "Missing required command: $1" >&2; exit 1; }
}

ensure_tools() {
  need_cmd node
  need_cmd npm
  need_cmd cargo
  need_cmd rsync
  need_cmd systemctl
}

build_backend() {
  echo "[backend] installing deps and building..."
  ( cd "${BACKEND_DIR}" && npm ci --legacy-peer-deps --include=dev && npm run build )
}

build_frontend() {
  echo "[frontend] installing deps and building..."
  ( cd "${FRONTEND_DIR}" && npm ci --legacy-peer-deps --include=dev && npm run build )
  echo "[frontend] syncing dist to ${WWW_DIR}..."
  sudo mkdir -p "${WWW_DIR}"
  sudo rsync -a --delete "${FRONTEND_DIR}/dist/" "${WWW_DIR}/"
}

build_arb() {
  echo "[arb-rs] cargo build --release..."
  ( cd "${ARB_DIR}" && cargo build --release )
}

cmd_build() {
  ensure_tools
  build_backend
  build_frontend
  build_arb
  echo "Build complete."
}

cmd_deploy() {
  cmd_build
  echo "[systemd] restarting ${BACKEND_SERVICE} and ${ARB_SERVICE}..."
  sudo systemctl restart "${BACKEND_SERVICE}" "${ARB_SERVICE}"
  echo "[nginx] reloading..."
  sudo systemctl reload "${NGINX_SERVICE}"
  echo "Deploy complete."
}

cmd_start() {
  echo "[nginx] starting..."
  sudo systemctl start "${NGINX_SERVICE}"
  echo "[systemd] starting ${BACKEND_SERVICE} and ${ARB_SERVICE}..."
  sudo systemctl start "${BACKEND_SERVICE}" "${ARB_SERVICE}"
}

cmd_stop() {
  echo "[systemd] stopping ${BACKEND_SERVICE} and ${ARB_SERVICE}..."
  sudo systemctl stop "${BACKEND_SERVICE}" "${ARB_SERVICE}"
  echo "[nginx] stopping..."
  sudo systemctl stop "${NGINX_SERVICE}"
}

cmd_restart() {
  echo "[systemd] restarting ${BACKEND_SERVICE} and ${ARB_SERVICE}..."
  sudo systemctl restart "${BACKEND_SERVICE}" "${ARB_SERVICE}"
  echo "[nginx] restarting..."
  sudo systemctl restart "${NGINX_SERVICE}"
}

cmd_status() {
  echo "[systemd] status: ${BACKEND_SERVICE} ${ARB_SERVICE} ${NGINX_SERVICE}"
  sudo systemctl status "${BACKEND_SERVICE}" "${ARB_SERVICE}" "${NGINX_SERVICE}" | cat
}

cmd_svc() {
  local svc action unit
  svc="${1:-}"; action="${2:-}"
  case "${svc}" in
    backend) unit="${BACKEND_SERVICE}" ;;
    arb) unit="${ARB_SERVICE}" ;;
    nginx) unit="${NGINX_SERVICE}" ;;
    *) echo "Unknown service '${svc}'. Use: backend|arb|nginx" >&2; exit 1 ;;
  esac
  case "${action}" in
    start|stop|restart|status) ;;
    *) echo "Unknown action '${action}'. Use: start|stop|restart|status" >&2; exit 1 ;;
  esac
  if [[ "${action}" == "status" ]]; then
    sudo systemctl status "${unit}" | cat
  else
    sudo systemctl "${action}" "${unit}"
  fi
}

main() {
  local cmd="${1:-help}"; shift || true
  case "${cmd}" in
    build) cmd_build ;;
    deploy) cmd_deploy ;;
    start) cmd_start ;;
    stop) cmd_stop ;;
    restart) cmd_restart ;;
    status) cmd_status ;;
    svc) cmd_svc "$@" ;;
    -h|--help|help) usage ;;
    *) echo "Unknown command: ${cmd}" >&2; echo; usage; exit 1 ;;
  esac
}

main "$@"


