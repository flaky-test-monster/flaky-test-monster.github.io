#!/usr/bin/env bash
# Starts Flakifier. When the local pipeline is installed (scripts/install.sh), it also
# starts the pixal3d.cpp trellis-server in the background and stops it again on exit.
# A trellis-server that is already running at LOCAL_3D_URL is reused and left alone.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TRELLIS_SERVER="$ROOT/vendor/pixal3d.cpp/build/trellis-server"
TRELLIS_MODELS="$ROOT/models/trellis2/q8"
LOG_DIR="$ROOT/logs"
HEALTH_WAIT_SECONDS=60

cd "$ROOT"
# --fast: quicker, lower-quality statue images in the local pipeline, for testing.
[[ "${1:-}" == "--fast" ]] && export LOCAL_FAST=1
# Tools installed by Homebrew and `uv tool install` may not be on PATH in a fresh shell.
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

command -v node >/dev/null 2>&1 || { echo "node not found; run scripts/install.sh first." >&2; exit 1; }

# LOCAL_3D_URL from the shell wins, then .env, then the trellis-server default.
if [[ -z "${LOCAL_3D_URL:-}" && -f .env ]]; then
  LOCAL_3D_URL="$(sed -n 's/^LOCAL_3D_URL=//p' .env | tail -1)"
fi
LOCAL_3D_URL="${LOCAL_3D_URL:-http://127.0.0.1:8080}"
export LOCAL_3D_URL

healthy() { curl -fsS --max-time 2 "$LOCAL_3D_URL/health" >/dev/null 2>&1; }

TRELLIS_PID=""
NODE_PID=""
# Stops whatever this script started. Runs on every exit: Ctrl-C, kill, or node exiting.
cleanup() {
  for pid in "$NODE_PID" "$TRELLIS_PID"; do
    [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null && kill "$pid" 2>/dev/null || true
  done
  [[ -n "$TRELLIS_PID" ]] && echo "Stopping trellis-server"
  wait 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if healthy; then
  echo "Using the trellis-server already running at $LOCAL_3D_URL"
elif [[ -x "$TRELLIS_SERVER" && -d "$TRELLIS_MODELS" ]]; then
  hostport="${LOCAL_3D_URL#*://}"
  hostport="${hostport%%/*}"
  mkdir -p "$LOG_DIR"
  echo "Starting trellis-server on $hostport (log: logs/trellis-server.log)"
  "$TRELLIS_SERVER" --models "$TRELLIS_MODELS" --no-texture \
    --host "${hostport%%:*}" --port "${hostport##*:}" >"$LOG_DIR/trellis-server.log" 2>&1 &
  TRELLIS_PID=$!
  for ((i = 0; i < HEALTH_WAIT_SECONDS; i++)); do
    healthy && break
    kill -0 "$TRELLIS_PID" 2>/dev/null || { echo "trellis-server exited; see logs/trellis-server.log" >&2; exit 1; }
    sleep 1
  done
  healthy || { echo "trellis-server did not become healthy within ${HEALTH_WAIT_SECONDS}s" >&2; exit 1; }
else
  echo "Local pipeline not installed; run scripts/install.sh to enable it."
fi

# Run node in the background and wait on it: bash only handles signals between commands,
# so a foreground node would delay cleanup until it exited on its own.
node server.js &
NODE_PID=$!
wait "$NODE_PID"
