#!/usr/bin/env bash
# Monad Blitz scorecard: automated evidence checks. Prints one line per rubric item:
#   ID | max | status | evidence   (PASS/FAIL = machine-proven; CHECK = machine-ok, human must confirm; MANUAL = needs proof; JUDGE = judge-scored; WARN = note)
# Usage: check.sh [LIVE_URL] [DOMAIN]
# Run from the repo root. Read-only: it never sends a transaction or writes a file.
set -u
cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
LIVE_URL="${1:-https://monicard.xyz}"
DOMAIN="${2:-monicard.xyz}"
VPS_IP="43.134.58.217"
TESTNET_RPC="https://testnet-rpc.monad.xyz"
MAINNET_RPC="https://rpc.monad.xyz"
SOURCIFY="https://sourcify-api-monad.blockvision.org"

row() { printf '%-14s | %3s | %-6s | %s\n' "$1" "$2" "$3" "$4"; }
addrs() { python3 - "$1" <<'EOF'
import json,sys,re
try: d=json.load(open(sys.argv[1]))
except Exception: sys.exit(0)
for k,v in d.items():
    if isinstance(v,str) and re.fullmatch(r"0x[0-9a-fA-F]{40}",v) and k!="deployer": print(k,v)
EOF
}

echo "ID             | max | status | evidence"
echo "---------------+-----+--------+---------"

# --- BASIC ---
REMOTE=$(git remote get-url origin 2>/dev/null || true)
if [ -z "$REMOTE" ]; then row B1_repo 25 FAIL "no git remote 'origin' (repo not pushed)"
else
  SLUG=$(echo "$REMOTE" | sed -E 's#(git@github.com:|https://github.com/)##; s#\.git$##')
  PRIV=$(gh api "repos/$SLUG" --jq .private 2>/dev/null || echo unknown)
  case "$PRIV" in false) row B1_repo 25 PASS "https://github.com/$SLUG is public";;
    true) row B1_repo 25 FAIL "https://github.com/$SLUG is PRIVATE";;
    *) row B1_repo 25 FAIL "cannot read $SLUG (not found or no access)";; esac
  UNPUSHED=$(git log --oneline "origin/$(git rev-parse --abbrev-ref HEAD 2>/dev/null)..HEAD" 2>/dev/null | wc -l | tr -d ' ')
  [ "${UNPUSHED:-0}" != "0" ] && row B1b_push 0 WARN "$UNPUSHED local commit(s) not pushed yet"
fi

if [ -f README.md ]; then
  MISSING=""; for f in deployments/testnet.json; do
    while read -r name addr; do [ -z "$addr" ] && continue
      grep -qi "$addr" README.md || MISSING="$MISSING $name"
    done < <(addrs "$f"); done
  HOST=$(echo "$LIVE_URL" | sed -E 's#https?://##; s#/.*##')
  HASURL=0; grep -qiE "$HOST|$DOMAIN" README.md && HASURL=1
  TODO=$(grep -ciE 'TODO|TBD' README.md)
  if [ -z "$MISSING" ] && [ "$HASURL" = 1 ] && [ "$TODO" = "0" ]; then row B2_readme 25 PASS "all testnet addresses + live URL present, no TODO"
  else row B2_readme 25 FAIL "missing addresses:${MISSING:- none}; live URL in README=$HASURL; TODO/TBD markers=$TODO"; fi
else row B2_readme 25 FAIL "README.md missing"; fi

TS_OK=0; TS_TOTAL=0; TS_LIST=""
while read -r name addr; do [ -z "$addr" ] && continue
  TS_TOTAL=$((TS_TOTAL+1)); CODE=$(cast code "$addr" --rpc-url "$TESTNET_RPC" 2>/dev/null || true)
  if [ -n "$CODE" ] && [ "$CODE" != "0x" ]; then TS_OK=$((TS_OK+1)); TS_LIST="$TS_LIST $name"; fi
done < <(addrs deployments/testnet.json)
if [ "$TS_TOTAL" -gt 0 ] && [ "$TS_OK" = "$TS_TOTAL" ]; then row B3_testnet 25 PASS "$TS_OK/$TS_TOTAL contracts have code on chain 10143:$TS_LIST"
else row B3_testnet 25 FAIL "$TS_OK/$TS_TOTAL contracts have code (deployments/testnet.json)"; fi

http_code() { curl -s -m 12 -o /dev/null -w '%{http_code}' "$1" 2>/dev/null || true; }
CFG=$(http_code "$LIVE_URL/config"); CFG=${CFG:-000}
APP=$(http_code "$LIVE_URL/"); APP=${APP:-000}
if [ "$CFG" = "200" ] && [ "$APP" = "200" ]; then row B4_hosted 25 PASS "$LIVE_URL (/ 200, /config 200)"
else row B4_hosted 25 FAIL "$LIVE_URL / -> $APP, /config -> $CFG"; fi

# --- ADVANCE: project working ---
row A1_functions 25 MANUAL "every announced feature must work live (tap mode, battle, AI Agent, fund, stake): run the demo script end to end"
row A2_livetx 25 MANUAL "show a fresh onchain tx during the demo (MonadScan link in the HUD)"

V_OK=0; V_TOTAL=0; V_BAD=""
while read -r name addr; do [ -z "$addr" ] && continue
  V_TOTAL=$((V_TOTAL+1))
  ST=$(curl -s -m 15 "$SOURCIFY/check-by-addresses?addresses=$addr&chainIds=10143" 2>/dev/null | python3 -c "import sys,json;print(json.load(sys.stdin)[0].get('status',''))" 2>/dev/null || echo "")
  case "$ST" in perfect|partial) V_OK=$((V_OK+1));; *) V_BAD="$V_BAD $name";; esac
done < <(addrs deployments/testnet.json)
if [ "$V_TOTAL" -gt 0 ] && [ "$V_OK" = "$V_TOTAL" ]; then
  row A3_verified 25 CHECK "$V_OK/$V_TOTAL verified on Sourcify. The rubric says 'on the explorer': OPEN each page and confirm a green Contract tab with source: $(addrs deployments/testnet.json | awk '{printf "https://testnet.monadscan.com/address/%s#code ", $2}')"
else row A3_verified 25 FAIL "$V_OK/$V_TOTAL verified; missing:${V_BAD:- none found}"; fi

if [ -f README.md ] && grep -qiE 'pnpm local|npm run|## *(Run|Quick ?start|Getting started)' README.md && grep -qiE 'node|pnpm|foundry' README.md; then
  row A4_runnable 25 MANUAL "README has run steps; PROVE it: fresh clone in an empty dir, follow README verbatim, no help"
else row A4_runnable 25 FAIL "README lacks run instructions or prerequisites"; fi

# --- ADVANCE: build in public ---
row A5_post 25 MANUAL "post on X/LinkedIn tagging @monad @monad_dev @geeky_kartikey: paste the URL"
row A6_demo_vid 25 MANUAL "demo video >= 30s, product running, posted: paste the URL"
row A7_ad_vid 25 MANUAL "creative ad video posted (marketing/ad page): paste the URL"
row A8_views 25 MANUAL "5K+ total views across ALL posts made during Blitz: paste the view counts"

# --- BONUS ---
if [ -f deployments/mainnet.json ]; then
  MN_OK=0; MN_TOTAL=0
  while read -r name addr; do [ -z "$addr" ] && continue
    MN_TOTAL=$((MN_TOTAL+1)); CODE=$(cast code "$addr" --rpc-url "$MAINNET_RPC" 2>/dev/null || true)
    [ -n "$CODE" ] && [ "$CODE" != "0x" ] && MN_OK=$((MN_OK+1))
  done < <(addrs deployments/mainnet.json)
  if [ "$MN_TOTAL" -gt 0 ] && [ "$MN_OK" = "$MN_TOTAL" ]; then row X1_mainnet 25 PASS "$MN_OK/$MN_TOTAL contracts have code on chain 143"
  else row X1_mainnet 25 FAIL "$MN_OK/$MN_TOTAL contracts have code on mainnet"; fi
else row X1_mainnet 25 FAIL "deployments/mainnet.json missing (not deployed)"; fi

DIP=$(dig +short "$DOMAIN" A @1.1.1.1 2>/dev/null | tail -1)
DHTTP=$(http_code "https://$DOMAIN/"); DHTTP=${DHTTP:-000}
if [ "$DIP" = "$VPS_IP" ] && [ "$DHTTP" = "200" ]; then row X2_domain 15 PASS "https://$DOMAIN -> $VPS_IP, HTTPS 200"
else row X2_domain 15 FAIL "$DOMAIN A=${DIP:-none} (want $VPS_IP), HTTPS=$DHTTP"; fi

row X3_pmf 20 JUDGE "who pays, evidence of real usage (cards pulled / tx sent today), pitch clarity"
row X4_revenue 20 JUDGE "revenue streams live onchain (paid pack, royalty, event mode, stake rake) + strategy"
row X5_innovation 20 JUDGE "novel mechanic, pushes Monad limits (parallel duels, per-block timing), originality"
