#!/usr/bin/env bash
#
# Start the JobPilot web UI and open it in the browser.
#
#   ./start.sh              # port 7788
#   ./start.sh 8080         # custom port
#   NO_OPEN=1 ./start.sh    # start without opening a browser (CI, remote shells)
#
set -euo pipefail

cd "$(dirname "$0")"

PORT="${1:-${PORT:-7788}}"
URL="http://127.0.0.1:${PORT}"

open_browser() {
  if [ "${NO_OPEN:-0}" = "1" ]; then
    return
  fi
  if command -v open >/dev/null 2>&1; then
    open "$URL"
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$URL" >/dev/null 2>&1 || true
  else
    echo "Open $URL in your browser."
  fi
}

if curl -sf --max-time 2 "$URL/api/health" >/dev/null 2>&1; then
  echo "JobPilot is already running at $URL"
  open_browser
  exit 0
fi

if [ ! -d node_modules ]; then
  echo "Installing dependencies…"
  npm install --silent
fi

# Wait for the server to answer before opening the page, so the browser does
# not land on a connection error.
(
  for _ in $(seq 1 100); do
    if curl -sf --max-time 1 "$URL/api/health" >/dev/null 2>&1; then
      open_browser
      exit 0
    fi
    sleep 0.2
  done
  echo "Server did not answer at $URL — check the output above." >&2
) &

echo "Starting JobPilot at $URL  (Ctrl+C to stop)"
exec node src/server.ts --port "$PORT"
