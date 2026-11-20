#!/usr/bin/env bash
#
# Stop the JobPilot web UI.
#
#   ./stop.sh            # port 7788
#   ./stop.sh 8080       # custom port
#
set -euo pipefail

cd "$(dirname "$0")"

PORT="${1:-${PORT:-7788}}"

listener() {
  lsof -ti "tcp:${PORT}" -sTCP:LISTEN 2>/dev/null | head -1
}

PID="$(listener || true)"
if [ -z "${PID}" ]; then
  echo "JobPilot is not running on port ${PORT}"
  exit 0
fi

# Only kill our own server. Something else on the port is not ours to stop.
CMD="$(ps -o command= -p "${PID}" 2>/dev/null || true)"
case "${CMD}" in
  *src/server/server.ts*|*JobPilot*) ;;
  *)
    echo "port ${PORT} is held by another program, not JobPilot:" >&2
    echo "  ${CMD}" >&2
    exit 1
    ;;
esac

kill "${PID}" 2>/dev/null || true

for _ in $(seq 1 25); do
  if [ -z "$(listener || true)" ]; then
    echo "JobPilot stopped (port ${PORT})"
    exit 0
  fi
  sleep 0.2
done

echo "did not exit gracefully, forcing" >&2
kill -9 "${PID}" 2>/dev/null || true
echo "JobPilot stopped (forced, port ${PORT})"
