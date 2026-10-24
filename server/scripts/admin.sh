#!/usr/bin/env bash
# Monicard admin client: a thin curl wrapper around the token-protected /admin API.
#
#   bash server/scripts/admin.sh <command> [arg ...]
#
# Reads ONLY ADMIN_TOKEN and PUBLIC_URL from the repo's .env. The file is never sourced:
# it holds private keys. Set ADMIN_URL to target another server (e.g. http://localhost:8080).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

usage() {
  cat >&2 <<'EOF'
usage: admin.sh <command> [args]

  swarm <pairs> <rounds>    start the bot swarm (pairs 1-50, rounds 1-100)
  swarm-stop                stop starting new duels
  fund on|off               enable or disable /fund
  featured <id|none>        pin the featured duel
  reserve <address|none>    reserve the AI Agent for one p1 address
  merge-train               merge agent.train.json into the live agent
  wallets                   show the MON balance of every server wallet

environment:
  ADMIN_URL                 base URL override (default: PUBLIC_URL from .env)
  ADMIN_TOKEN, PUBLIC_URL   read from <repo>/.env
EOF
}

fail() {
  echo "admin.sh: $*" >&2
  exit 1
}

# Prints one KEY=VALUE from .env without executing the file; quotes around the value are dropped.
env_value() {
  local key="$1"
  [ -f "$ROOT/.env" ] || return 1
  grep -E "^${key}=" "$ROOT/.env" | tail -n 1 | sed -E "s/^${key}=//; s/^['\"]//; s/['\"]$//"
}

is_uint() {
  case "$1" in
    '' | *[!0-9]*) return 1 ;;
    *) return 0 ;;
  esac
}

require_count() {
  local label="$1" value="$2" min="$3" max="$4"
  is_uint "$value" || fail "$label must be an integer (got '$value')"
  if [ "$value" -lt "$min" ] || [ "$value" -gt "$max" ]; then
    fail "$label must be between $min and $max (got $value)"
  fi
}

# One request; exits non-zero on HTTP >= 400. The token is only ever sent in the header.
request() {
  local method="$1" path="$2" body="${3:-}"
  local -a args=(
    -sS -X "$method"
    -H "x-admin-token: $TOKEN"
    -H 'content-type: application/json'
    -w '\nHTTP %{http_code}\n'
  )
  if [ -n "$body" ]; then
    args+=(--data "$body")
  fi

  local response status
  response="$(curl "${args[@]}" "$BASE$path")"
  printf '%s\n' "$response"

  status="$(printf '%s\n' "$response" | tail -n 1 | sed -E 's/^HTTP //')"
  is_uint "$status" || fail "unexpected response from $BASE$path"
  if [ "$status" -ge 400 ]; then
    exit 1
  fi
}

TOKEN="$(env_value ADMIN_TOKEN || true)"
if [ -z "$TOKEN" ]; then
  fail "ADMIN_TOKEN is not set in $ROOT/.env"
fi

BASE="${ADMIN_URL:-$(env_value PUBLIC_URL || true)}"
BASE="${BASE%/}"
if [ -z "$BASE" ]; then
  fail "set ADMIN_URL, or PUBLIC_URL in $ROOT/.env"
fi

COMMAND="${1:-}"
if [ -z "$COMMAND" ]; then
  usage
  exit 2
fi
shift

case "$COMMAND" in
  swarm)
    if [ "$#" -ne 2 ]; then
      usage
      exit 2
    fi
    require_count pairs "$1" 1 50
    require_count rounds "$2" 1 100
    request POST /admin/swarm "{\"pairs\":$1,\"rounds\":$2}"
    ;;
  swarm-stop)
    if [ "$#" -ne 0 ]; then
      usage
      exit 2
    fi
    request POST /admin/swarm/stop
    ;;
  fund)
    if [ "$#" -ne 1 ]; then
      usage
      exit 2
    fi
    case "$1" in
      on) request POST /admin/fund '{"enabled":true}' ;;
      off) request POST /admin/fund '{"enabled":false}' ;;
      *) fail "fund expects on or off (got '$1')" ;;
    esac
    ;;
  featured)
    if [ "$#" -ne 1 ]; then
      usage
      exit 2
    fi
    if [ "$1" = "none" ]; then
      request POST /admin/featured '{"duelId":null}'
    else
      is_uint "$1" || fail "featured expects a duel id or none (got '$1')"
      request POST /admin/featured "{\"duelId\":\"$1\"}"
    fi
    ;;
  reserve)
    if [ "$#" -ne 1 ]; then
      usage
      exit 2
    fi
    if [ "$1" = "none" ]; then
      request POST /admin/agent/reserve '{"p1":null}'
    else
      if ! [[ "$1" =~ ^0x[0-9a-fA-F]{40}$ ]]; then
        fail "reserve expects 0x followed by 40 hex characters, or none (got '$1')"
      fi
      request POST /admin/agent/reserve "{\"p1\":\"$1\"}"
    fi
    ;;
  merge-train)
    if [ "$#" -ne 0 ]; then
      usage
      exit 2
    fi
    request POST /admin/agent/merge-train
    ;;
  wallets)
    if [ "$#" -ne 0 ]; then
      usage
      exit 2
    fi
    request GET /admin/wallets
    ;;
  help | -h | --help)
    usage
    exit 0
    ;;
  *)
    usage
    exit 2
    ;;
esac
