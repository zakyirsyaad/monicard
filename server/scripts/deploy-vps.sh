#!/usr/bin/env bash
# Deploy Monicard to the VPS: build web locally, rsync, install, (re)start under pm2, smoke test.
#
# Usage: server/scripts/deploy-vps.sh [--env] [--no-build]
#   --env       force-copy the local .env (PORT rewritten to 8090) even if one exists remotely
#   --no-build  skip the local web build (web/dist/index.html must already exist)
#
# Overrides: VPS_HOST (0xAlvary3), VPS_DIR (nadgacha, relative to remote home),
#            PUBLIC_URL_CHECK (https://nadgacha.43-134-58-217.sslip.io)
#
# Only the pm2 process "nadgacha" and the ~/$VPS_DIR directory are ever touched.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

VPS_HOST="${VPS_HOST:-0xAlvary3}"
VPS_DIR="${VPS_DIR-nadgacha}"
PUBLIC_URL_CHECK="${PUBLIC_URL_CHECK:-https://nadgacha.43-134-58-217.sslip.io}"
# rsync --delete runs against this directory, so it must be a plain path below the remote home.
case "$VPS_DIR" in
  '' | . | .. | /* | ../* | */.. | */../* | ~*)
    echo "ERROR: VPS_DIR must be a relative path below the remote home, got: '$VPS_DIR'" >&2
    exit 2
    ;;
esac
REMOTE_PORT=8090
PM2_NAME="nadgacha"

FORCE_ENV=0
SKIP_WEB_BUILD="${SKIP_WEB_BUILD:-}"
for arg in "$@"; do
  case "$arg" in
    --env) FORCE_ENV=1 ;;
    --no-build) SKIP_WEB_BUILD=1 ;;
    *)
      echo "Unknown option: $arg (expected --env or --no-build)" >&2
      exit 2
      ;;
  esac
done

TMP_ENV=""
cleanup() {
  if [ -n "$TMP_ENV" ]; then rm -f "$TMP_ENV"; fi
}
trap cleanup EXIT

# Run a script on the VPS in a login shell (so node/pm2 are on PATH); $1 inside is the remote dir.
remote() {
  ssh "$VPS_HOST" "bash -l -c $(printf '%q' "$1") _ $(printf '%q' "$VPS_DIR")"
}

echo "==> preflight"
ssh -o ConnectTimeout=10 -o BatchMode=yes "$VPS_HOST" true || {
  echo "ERROR: cannot reach $VPS_HOST over ssh" >&2
  exit 1
}
for required in .env pnpm-lock.yaml deployments/testnet.json; do
  if [ ! -f "$ROOT/$required" ]; then
    echo "ERROR: required file missing: $required" >&2
    exit 1
  fi
done

if [ "$SKIP_WEB_BUILD" = "1" ]; then
  echo "==> web build skipped"
else
  echo "==> building web"
  pnpm -F @nad/web build
fi
if [ ! -f "$ROOT/web/dist/index.html" ]; then
  echo "ERROR: web/dist/index.html is missing (pnpm -F silently succeeds for unknown packages)" >&2
  exit 1
fi

echo "==> rsync to $VPS_HOST:~/$VPS_DIR"
# Anchored (/x) patterns only match at the repo root, so web/src/data etc. still ship.
# Excluded paths are never deleted remotely, so the remote data/ and .env survive.
RSYNC_EXCLUDES=(
  --exclude='node_modules'
  --exclude='/data'
  --exclude='.env'
  --exclude='/contracts/out'
  --exclude='/contracts/cache'
  --exclude='/contracts/lib'
  --exclude='/contracts/broadcast'
  --exclude='.git'
  --exclude='/.coord'
  --exclude='/.superpowers'
  --exclude='/.claude'
  --exclude='/.remember'
  --exclude='/marketing'
  --exclude='.DS_Store'
)
rsync -az --delete "${RSYNC_EXCLUDES[@]}" "$ROOT/" "$VPS_HOST:$VPS_DIR/"

echo "==> .env"
copy_env=0
if [ "$FORCE_ENV" = "1" ]; then
  copy_env=1
else
  # Exit 0 = exists, 1 = missing. Anything else (e.g. ssh's 255) is an error, never "missing".
  if ssh "$VPS_HOST" "test -f ~/$(printf '%q' "$VPS_DIR")/.env"; then
    env_status=0
  else
    env_status=$?
  fi
  case "$env_status" in
    0) ;;
    1) copy_env=1 ;;
    *)
      echo "ERROR: could not check the remote .env (ssh exit $env_status), aborting" >&2
      exit 1
      ;;
  esac
fi
if [ "$copy_env" = "1" ]; then
  TMP_ENV="$(mktemp)"
  chmod 600 "$TMP_ENV"
  awk -v port="PORT=$REMOTE_PORT" '
    /^PORT=/ { if (!done) { print port; done = 1 } next }
    { print }
    END { if (!done) print port }
  ' "$ROOT/.env" >"$TMP_ENV"
  scp -q "$TMP_ENV" "$VPS_HOST:$VPS_DIR/.env"
  ssh "$VPS_HOST" "chmod 600 ~/$(printf '%q' "$VPS_DIR")/.env"
  echo "    copied .env (PORT=$REMOTE_PORT)"
else
  echo "    remote .env kept (pass --env to overwrite)"
fi

echo "==> remote install"
# shellcheck disable=SC2016 # $1 and $HOME must expand on the VPS
remote '
for tool in node npx pm2; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "ERROR: $tool not found on the VPS PATH (login shell); install it or fix ~/.profile" >&2
    exit 1
  fi
done
cd "$HOME/$1" &&
CI=true npx -y pnpm@12.10.1 install --frozen-lockfile --filter server... </dev/null
'

echo "==> restart pm2 process $PM2_NAME"
# shellcheck disable=SC2016 # $1 and $HOME must expand on the VPS
remote '
cd "$HOME/$1" &&
(pm2 restart nadgacha --update-env ||
  SKIP_WEB_BUILD=1 pm2 start server/scripts/serve.sh --name nadgacha --interpreter bash --cwd "$HOME/$1") &&
pm2 save
'

echo "==> smoke test $PUBLIC_URL_CHECK/config"
deadline=$((SECONDS + 30))
while [ "$SECONDS" -lt "$deadline" ]; do
  if body="$(curl -fsS --max-time 3 "$PUBLIC_URL_CHECK/config" 2>/dev/null)"; then
    # A non-JSON answer (proxy error page, SPA fallback) is not healthy: keep polling.
    if chain_id="$(printf '%s' "$body" | node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(0, "utf8")).chainId))' 2>/dev/null)"; then
      echo "OK: server is up, chainId=$chain_id"
      exit 0
    fi
  fi
  sleep 1
done

echo "ERROR: smoke test failed after 30s; recent pm2 logs:" >&2
remote 'pm2 logs nadgacha --lines 40 --nostream' >&2 || echo "(could not fetch pm2 logs)" >&2
exit 1
