#!/usr/bin/env bash
# Starts the AEM Baltic task board on this computer.
set -e
cd "$(dirname "$0")"

if command -v node >/dev/null 2>&1; then
  exec node serve.js "$@"
fi

if command -v python3 >/dev/null 2>&1; then
  PORT="${1:-8765}"
  echo "Serving on http://localhost:$PORT/ — press Ctrl+C to stop."
  (sleep 1; (command -v open >/dev/null && open "http://localhost:$PORT/") \
    || (command -v xdg-open >/dev/null && xdg-open "http://localhost:$PORT/") || true) &
  exec python3 -m http.server "$PORT" --bind 127.0.0.1
fi

echo "Neither Node.js nor Python 3 was found. Install Node.js from https://nodejs.org"
exit 1
