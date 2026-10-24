#!/usr/bin/env bash
# Build the web client (optional) and start the Monicard server.
#
#   SKIP_WEB_BUILD=1  skip `pnpm -F @nad/web build` (the VPS never builds the web)
#   SKIP_WEB=1        explicit API-only mode: do not require web/dist/index.html
#
# Under pm2 (env `pm_id` set) the server is exec'd directly and pm2 owns restarts.
# On the laptop it runs in a restart loop, under `caffeinate` when available.
# main.ts reads .env and PORT itself; this script never sources .env.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

# pm2 means "deployed box": the web is prebuilt, so never try to build it there.
if [ -n "${pm_id:-}" ]; then
  SKIP_WEB_BUILD=1
fi

if [ "${SKIP_WEB_BUILD:-}" != "1" ]; then
  echo "==> building web"
  pnpm -F @nad/web build
fi

if [ ! -f "$ROOT/web/dist/index.html" ]; then
  if [ "${SKIP_WEB:-}" = "1" ]; then
    echo "WARNING: web/dist/index.html is missing, serving API only (SKIP_WEB=1)" >&2
  else
    echo "ERROR: web/dist/index.html is missing. Build it with 'pnpm -F @nad/web build'," >&2
    echo "       or set SKIP_WEB=1 to serve the API only." >&2
    exit 1
  fi
fi

TSX="$ROOT/server/node_modules/.bin/tsx"
MAIN="server/src/main.ts"
if [ ! -x "$TSX" ]; then
  echo "ERROR: $TSX not found. Run pnpm install first." >&2
  exit 1
fi

if [ -n "${pm_id:-}" ]; then
  echo "==> starting server under pm2"
  exec "$TSX" "$MAIN"
fi

LOOP='until "$@"; do echo "server exited, restarting in 1s"; sleep 1; done'
echo "==> starting server (auto-restart loop)"
if command -v caffeinate >/dev/null 2>&1; then
  exec caffeinate -dis bash -c "$LOOP" _ "$TSX" "$MAIN"
fi
exec bash -c "$LOOP" _ "$TSX" "$MAIN"
