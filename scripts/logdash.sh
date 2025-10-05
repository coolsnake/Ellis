#!/usr/bin/env bash

set -euo pipefail

# Lockstone tmux log dashboard
# Views concurrent logs for backend and arb-rs systemd services.

SESSION_NAME="lockstone-logs"
BACKEND_UNIT="lockstone-backend"
ARB_UNIT="lockstone-arb"

# Absolute path to this script for reliable re-exec
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
SELF_PATH="${SCRIPT_DIR}/$(basename "${BASH_SOURCE[0]:-$0}")"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
LOCKCTL="${REPO_ROOT}/scripts/lockstone.sh"

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || { echo "Missing required command: $1" >&2; exit 1; }
}

# If running via sudo, re-exec as original user to avoid creating a root-owned tmux session
if [[ "${SUDO_USER-}" != "" && "${USER}" == "root" ]]; then
  exec sudo -u "$SUDO_USER" -H -- bash "$SELF_PATH" "$@"
fi

need_cmd tmux
need_cmd journalctl

# Detect if session exists
if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
  exec tmux attach -t "$SESSION_NAME"
fi

# Create new session with three panes:
#  - Pane 0: Combined follow of backend + arb
#  - Pane 1: Backend only
#  - Pane 2: Arb only

tmux new-session -d -s "$SESSION_NAME" "journalctl -fu $BACKEND_UNIT -u $ARB_UNIT -o short-iso -n 200"

tmux split-window -h "journalctl -fu $BACKEND_UNIT -o cat -n 200"
tmux split-window -v "journalctl -fu $ARB_UNIT -o cat -n 200"

tmux select-layout tiled
tmux select-pane -t 0

# Keybindings for quick navigation
tmux bind-key -n 1 select-pane -t 0
tmux bind-key -n 2 select-pane -t 1
tmux bind-key -n 3 select-pane -t 2
tmux bind-key -n z resize-pane -Z

# Bind Shift-Q to stop services and kill the dashboard
tmux bind-key -n Q split-window -v "bash -lc '$LOCKCTL stop; read -p "Stopped. Press Enter to close dashboard..."; tmux kill-session -t $SESSION_NAME'"

# Create an alternate window with less-follow for long scrollback & search
tmux new-window -n "Full Logs" "bash -lc 'journalctl -u $BACKEND_UNIT -o short-iso -n 1000 | less -R +F'"
tmux split-window -h "bash -lc 'journalctl -u $ARB_UNIT -o short-iso -n 1000 | less -R +F'"
tmux select-layout even-horizontal

echo "Controls: 1/2/3 switch panes, z zoom, Q quit (stop & close), PgUp/PgDn scroll, / search in less (Full Logs)"

exec tmux attach -t "$SESSION_NAME"


