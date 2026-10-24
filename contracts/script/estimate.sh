#!/usr/bin/env bash
# Measures the gas every task-critical NadCards/BlitzArena call actually burns on
# Monad testnet and folds the results into deployments/testnet.json as gasLimits.
#
# Monad charges from the supplied gasLimit, not from gas used, so these numbers —
# not `forge test --gas-report` — are the source of truth for the client.
#
# Usage: contracts/script/estimate.sh
#   - reads root .env (MASTER_KEY, RPC_URLS) and deployments/testnet.json
#   - throwaway wallets live in a mktemp dir removed on exit; no key ever touches the repo
#   - funding obeys the Monad reserve-balance rule (N9): a wallet under 10 MON may
#     send a value tx only when it has not sent one in the previous 3 blocks, and a
#     freshly funded wallet waits >= 3 blocks before its first tx.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

set -a
# .env is hand-written; one unquoted value (EVENT_NAME) errors on source. Disable
# errexit for the source itself and validate the vars we need right after.
# shellcheck disable=SC1091
set +e
source "$ROOT/.env"
set -e
set +a

: "${MASTER_KEY:?MASTER_KEY missing from .env}"
: "${RPC_URLS:?RPC_URLS missing from .env}"
RPC="${RPC_URLS%%,*}"

CARDS="$(jq -r .cards deployments/testnet.json)"
ARENA="$(jq -r .arena deployments/testnet.json)"
[[ "$CARDS" =~ ^0x[0-9a-fA-F]{40}$ && "$ARENA" =~ ^0x[0-9a-fA-F]{40}$ ]] \
  || { echo "[estimate] deployments/testnet.json has no valid cards/arena" >&2; exit 1; }

WORK="$(mktemp -d)"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT INT TERM

MEASUREMENTS="$WORK/gas.tsv"
: > "$MEASUREMENTS"
ATTACK_TOPIC="$(cast keccak 'Attacked(uint256,address,uint16,uint256,uint16)')"

log() { printf '[estimate] %s\n' "$*"; }
die() { printf '[estimate] ERROR: %s\n' "$*" >&2; exit 1; }

block_number() { cast block-number --rpc-url "$RPC"; }

wait_for_block() { # target_block
  local target="$1" deadline=$(( SECONDS + 180 ))
  while (( $(block_number) < target )); do
    (( SECONDS < deadline )) || die "timed out waiting for block $target"
    sleep 0.2
  done
}

# ------------------------------------------------------------------ receipts

LAST_BLOCK=0
LAST_GAS=0
LAST_HASH=""
LAST_EST=0

send_tx() { # private_key to sig [args...]
  local key="$1"; shift
  local out
  if ! out="$(cast send "$@" --private-key "$key" --rpc-url "$RPC" --json 2>"$WORK/send.err")"; then
    cat "$WORK/send.err" >&2
    die "cast send failed: $*"
  fi
  [[ "$(jq -r .status <<<"$out")" == "0x1" ]] || die "tx reverted: $*"
  printf '%s' "$out" > "$WORK/last-receipt.json"
  LAST_BLOCK=$(( $(jq -r .blockNumber <<<"$out") ))
  LAST_GAS=$(( $(jq -r .gasUsed <<<"$out") ))
  LAST_HASH="$(jq -r .transactionHash <<<"$out")"
}

record() { # function estimate gas_used
  printf '%s\t%s\t%s\n' "$1" "${2:-0}" "${3:-0}" >> "$MEASUREMENTS"
}

attacked_field() { # receipt_json_path field_index(1=taps 2=damage 3=hpLeft)
  local data start
  data="$(jq -r --arg t "$ATTACK_TOPIC" '[.logs[] | select(.topics[0] == $t) | .data] | last // empty' "$1")"
  [[ -n "$data" ]] || return 0   # a tap that lands on a finished duel emits nothing
  start=$(( 2 + ($2 - 1) * 64 ))
  printf '%d' "0x${data:$start:64}"
}

card_field() { # token_id field_index(0=atk 1=hp 2=element 3=rarity)
  cast call "$CARDS" 'cards(uint256)((uint16,uint16,uint8,uint8,uint16,uint16,uint64))' "$1" \
    --rpc-url "$RPC" --json | jq -r ".[0][$2]"
}

# ------------------------------------------------------------------- wallets

cast wallet new --json > "$WORK/a.json"
cast wallet new --json > "$WORK/b.json"
A="$(jq -r '.[0].address' "$WORK/a.json")"
AKEY="$(jq -r '.[0].private_key' "$WORK/a.json")"
B="$(jq -r '.[0].address' "$WORK/b.json")"
BKEY="$(jq -r '.[0].private_key' "$WORK/b.json")"
MASTER="$(cast wallet address --private-key "$MASTER_KEY")"

log "cards=$CARDS arena=$ARENA"
log "master=$MASTER balance=$(cast balance "$MASTER" --rpc-url "$RPC" --ether) MON"
log "throwaway A=$A B=$B (keys in $WORK, deleted on exit)"

# ------------------------------------------------------------------ funding

log "funding A with 0.2 MON"
send_tx "$MASTER_KEY" "$A" --value 0.2ether
record fund "$LAST_GAS" "$LAST_GAS"
FUND_A_BLOCK=$LAST_BLOCK

wait_for_block $(( FUND_A_BLOCK + 3 ))   # master is under 10 MON: value txs >= 3 blocks apart
log "funding B with 0.2 MON"
send_tx "$MASTER_KEY" "$B" --value 0.2ether
record fund "$LAST_GAS" "$LAST_GAS"
FUND_B_BLOCK=$LAST_BLOCK

# N9: a fresh balance is invisible for 3 blocks; B's first tx must be the paid pull.
wait_for_block $(( FUND_B_BLOCK + 3 ))

# --------------------------------------------------------------- primary duel

log "freePull from A"
EST=$(cast estimate "$CARDS" 'freePull()' --from "$A" --rpc-url "$RPC")
send_tx "$AKEY" "$CARDS" 'freePull()'
record freePull "$EST" "$LAST_GAS"
CARD_A="$(cast call "$CARDS" 'cardOf(address)(uint256)' "$A" --rpc-url "$RPC")"
log "freePull gas est=$EST used=$LAST_GAS token=$CARD_A"

log "createDuel from A"
EST=$(cast estimate "$ARENA" 'createDuel(uint256)' "$CARD_A" --from "$A" --rpc-url "$RPC")
send_tx "$AKEY" "$ARENA" 'createDuel(uint256)' "$CARD_A"
record createDuel "$EST" "$LAST_GAS"
DUEL_ID=$(( $(cast call "$ARENA" 'duelCount()(uint256)' --rpc-url "$RPC") - 1 ))
log "createDuel gas est=$EST used=$LAST_GAS duel=$DUEL_ID"

# B's first tx after funding: value tx, so it must be the first one in >= 3 blocks (N9).
log "paidPull from B (0.05 MON)"
EST=$(cast estimate "$CARDS" 'paidPull()' --value 0.05ether --from "$B" --rpc-url "$RPC")
send_tx "$BKEY" "$CARDS" 'paidPull()' --value 0.05ether
record paidPull "$EST" "$LAST_GAS"
CARD_B="$(cast call "$CARDS" 'cardOf(address)(uint256)' "$B" --rpc-url "$RPC")"
log "paidPull gas est=$EST used=$LAST_GAS token=$CARD_B"

log "joinDuel from B"
EST=$(cast estimate "$ARENA" 'joinDuel(uint256,uint256)' "$DUEL_ID" "$CARD_B" --from "$B" --rpc-url "$RPC")
send_tx "$BKEY" "$ARENA" 'joinDuel(uint256,uint256)' "$DUEL_ID" "$CARD_B"
record joinDuel "$EST" "$LAST_GAS"
JOIN_BLOCK=$LAST_BLOCK
START_BLOCK=$(( JOIN_BLOCK + 10 ))
log "joinDuel gas est=$EST used=$LAST_GAS startBlock=$START_BLOCK"

atk_a="$(card_field "$CARD_A" 0)"; hp_a="$(card_field "$CARD_A" 1)"; el_a="$(card_field "$CARD_A" 2)"
atk_b="$(card_field "$CARD_B" 0)"; hp_b="$(card_field "$CARD_B" 1)"; el_b="$(card_field "$CARD_B" 2)"
mult_a="$(cast call "$ARENA" 'elementMult(uint8,uint8)(uint8)' "$el_a" "$el_b" --rpc-url "$RPC")"
mult_b="$(cast call "$ARENA" 'elementMult(uint8,uint8)(uint8)' "$el_b" "$el_a" --rpc-url "$RPC")"
log "A card atk=$atk_a hp=$hp_a el=$el_a mult=$mult_a | B card atk=$atk_b hp=$hp_b el=$el_b mult=$mult_b"

# Attack 1: 9 taps, available after 3 blocks of countdown.
wait_for_block $(( START_BLOCK + 3 ))
log "attack($DUEL_ID, 9, false) from A"
EST=$(cast estimate "$ARENA" 'attack(uint256,uint16,bool)' "$DUEL_ID" 9 false --from "$A" --rpc-url "$RPC")
send_tx "$AKEY" "$ARENA" 'attack(uint256,uint16,bool)' "$DUEL_ID" 9 false
record attack "$EST" "$LAST_GAS"
TAPS_9_GAS=$LAST_GAS
DAMAGE_9="$(attacked_field "$WORK/last-receipt.json" 2)"
HP_B_LEFT="$(attacked_field "$WORK/last-receipt.json" 3)"
RATE_A=$(( DAMAGE_9 / 3 ))   # 9 taps == 3 blocks of allowance; damage per block
log "attack9 gas est=$EST used=$LAST_GAS damage=$DAMAGE_9 hp2=$HP_B_LEFT rateA=$RATE_A/block"

# Attack 2: 30 taps + skill, available after 10 more blocks.
wait_for_block $(( LAST_BLOCK + 10 ))
log "attack($DUEL_ID, 30, true) from A"
EST=$(cast estimate "$ARENA" 'attack(uint256,uint16,bool)' "$DUEL_ID" 30 true --from "$A" --rpc-url "$RPC")
send_tx "$AKEY" "$ARENA" 'attack(uint256,uint16,bool)' "$DUEL_ID" 30 true
record attack "$EST" "$LAST_GAS"
TAPS_30_GAS=$LAST_GAS
DAMAGE_30="$(attacked_field "$WORK/last-receipt.json" 2)"
HP_B_LEFT="$(attacked_field "$WORK/last-receipt.json" 3)"
log "attack30skill gas est=$EST used=$LAST_GAS damage=$DAMAGE_30 hp2=$HP_B_LEFT"

# ---------------------------------------------------------------- KO duel
# The two mandated measurements above burn most of the 67-block window, and one
# `cast send` costs ~10 blocks of wall clock on this RPC, so a killing blow in
# the measurement duel is not reliable. Fight a second duel with the same cards
# and the stronger direction, sending 30-tap batches back to back: each round
# trip already covers the 10 blocks needed for a full tap allowance.

RATE_A=$(( 3 * atk_a * mult_a / 100 ))
RATE_B=$(( 3 * atk_b * mult_b / 100 ))
CAP_A=$(( 201 * atk_a * mult_a / 100 ))   # 67 blocks * 3 taps
CAP_B=$(( 201 * atk_b * mult_b / 100 ))
KO_EST=""
KO_GAS=""
KO_TAPS=""
KO_ACTOR=""
KO_DUEL_ID=""
ALREADY_SETTLED="$(cast sig 'AlreadySettled()')"

if (( HP_B_LEFT == 0 )); then
  KO_EST=$EST; KO_GAS=$LAST_GAS; KO_TAPS=30; KO_ACTOR=A
  log "attack30skill was the killing blow"
fi

log "window capacity: A=$CAP_A vs hp2=$hp_b | B=$CAP_B vs hp1=$hp_a (rates $RATE_A/$RATE_B per block)"

if [[ -z "$KO_GAS" ]]; then
  if (( CAP_A * hp_a >= CAP_B * hp_b )); then KO_ACTOR=A; else KO_ACTOR=B; fi
  if [[ "$KO_ACTOR" == A ]]; then
    KO_KEY=$AKEY; KO_ADDR=$A; KO_TARGET=$hp_b; KO_TARGET_LABEL=hp2
  else
    KO_KEY=$BKEY; KO_ADDR=$B; KO_TARGET=$hp_a; KO_TARGET_LABEL=hp1
  fi
  log "KO duel: attacker=$KO_ACTOR target=$KO_TARGET_LABEL=$KO_TARGET"

  log "createDuel from A (KO duel)"
  EST=$(cast estimate "$ARENA" 'createDuel(uint256)' "$CARD_A" --from "$A" --rpc-url "$RPC")
  send_tx "$AKEY" "$ARENA" 'createDuel(uint256)' "$CARD_A"
  record createDuel "$EST" "$LAST_GAS"
  KO_DUEL_ID=$(( $(cast call "$ARENA" 'duelCount()(uint256)' --rpc-url "$RPC") - 1 ))

  log "joinDuel from B (KO duel)"
  EST=$(cast estimate "$ARENA" 'joinDuel(uint256,uint256)' "$KO_DUEL_ID" "$CARD_B" --from "$B" --rpc-url "$RPC")
  send_tx "$BKEY" "$ARENA" 'joinDuel(uint256,uint256)' "$KO_DUEL_ID" "$CARD_B"
  record joinDuel "$EST" "$LAST_GAS"
  KO_START=$(( LAST_BLOCK + 10 ))

  KO_ATK=$atk_a; KO_MULT=$mult_a
  [[ "$KO_ACTOR" == A ]] || { KO_ATK=$atk_b; KO_MULT=$mult_b; }
  PER_BATCH=$(( 30 * KO_ATK * KO_MULT / 100 ))
  BATCHES=$(( (KO_TARGET + PER_BATCH - 1) / PER_BATCH ))
  (( BATCHES >= 1 )) || BATCHES=1
  BATCHES=$(( BATCHES + 1 ))        # one spare batch: a tap on a finished duel is a no-op
  (( BATCHES <= 5 )) || BATCHES=5   # a 67-block window holds five 11-block batches
  log "KO plan: $BATCHES x 30 taps ($PER_BATCH dmg each) for $KO_TARGET hp"

  # Async sends. A synchronous receipt wait costs 10-16 blocks on this RPC, which
  # would eat the whole duel window, so fire on the block schedule and collect
  # receipts afterwards. 11-block spacing keeps the 30-tap allowance full even
  # when a send lands two blocks late.
  KO_HASHES=()
  for (( i = 0; i < BATCHES; i++ )); do
    wait_for_block $(( KO_START + 11 * (i + 1) ))
    (( $(block_number) < KO_START + 67 )) || break
    H="$(cast send "$ARENA" 'attack(uint256,uint16,bool)' "$KO_DUEL_ID" 30 false \
      --private-key "$KO_KEY" --rpc-url "$RPC" --async)"
    KO_HASHES+=("$H")
    log "sent KO batch $(( i + 1 ))/$BATCHES hash=$H block=$(block_number)"
  done

  for H in "${KO_HASHES[@]}"; do
    cast receipt "$H" --rpc-url "$RPC" --json > "$WORK/ko-receipt.json"
    [[ "$(jq -r .status "$WORK/ko-receipt.json")" == "0x1" ]] || die "KO batch $H reverted"
    G=$(( $(jq -r .gasUsed "$WORK/ko-receipt.json") ))
    RECEIPT_BLOCK=$(( $(jq -r .blockNumber "$WORK/ko-receipt.json") ))
    record attack 0 "$G"
    HPL="$(attacked_field "$WORK/ko-receipt.json" 3)"
    log "KO receipt $H gas=$G $KO_TARGET_LABEL=${HPL:-none} block=$RECEIPT_BLOCK"
    if [[ -n "$HPL" ]] && (( HPL == 0 )); then
      KO_GAS=$G; KO_EST=0; KO_TAPS=30
      log "killing blow from $KO_ACTOR: used=$G block=$RECEIPT_BLOCK"
      break
    fi
  done
fi

# ------------------------------------------------------------------- settle

settle_duel() { # duel_id label
  local id="$1" label="$2" est out
  est="$(cast estimate "$ARENA" 'settle(uint256)' "$id" --from "$A" --rpc-url "$RPC")"
  send_tx "$AKEY" "$ARENA" 'settle(uint256)' "$id"
  record settle "$est" "$LAST_GAS"
  out="$(cast call "$ARENA" 'settle(uint256)' "$id" --from "$A" --rpc-url "$RPC" 2>&1 || true)"
  grep -qi "${ALREADY_SETTLED#0x}" <<<"$out" || die "duel $id is not settled: $out"
  log "settle($label id=$id) gas est=$est used=$LAST_GAS (settled)"
}

if [[ -n "$KO_DUEL_ID" ]]; then
  [[ -n "$KO_GAS" ]] || { log "WARNING: no killing blow in the KO duel; waiting for timeout"; wait_for_block $(( KO_START + 67 )); }
  settle_duel "$KO_DUEL_ID" ko
fi

wait_for_block $(( START_BLOCK + 67 ))
settle_duel "$DUEL_ID" primary

# --------------------------------------------------------------- gasLimits

max_gas() { # function
  awk -F'\t' -v f="$1" '$1 == f { if ($2 > m) m = $2; if ($3 > m) m = $3 } END { print m + 0 }' "$MEASUREMENTS"
}

limit_for() { # function -> max measured * 1.2, rounded up to the next 1000
  local max padded
  max="$(max_gas "$1")"
  (( max > 0 )) || die "no measurement recorded for $1"
  padded=$(( (max * 12 + 9) / 10 ))          # ceil(max * 1.2)
  printf '%d' $(( (padded + 999) / 1000 * 1000 ))
}

FREE="$(limit_for freePull)"
PAID="$(limit_for paidPull)"
CREATE="$(limit_for createDuel)"
JOIN="$(limit_for joinDuel)"
ATTACK="$(limit_for attack)"
SETTLE="$(limit_for settle)"

(( ATTACK < 100000 )) || die "attack gasLimit $ATTACK is not under 100000"

jq --argjson freePull "$FREE" --argjson paidPull "$PAID" --argjson createDuel "$CREATE" \
  --argjson joinDuel "$JOIN" --argjson attack "$ATTACK" --argjson settle "$SETTLE" \
  '.gasLimits = {freePull: $freePull, paidPull: $paidPull, createDuel: $createDuel, joinDuel: $joinDuel, attack: $attack, settle: $settle}' \
  deployments/testnet.json > "$WORK/testnet.json"
mv "$WORK/testnet.json" deployments/testnet.json

log "raw measurements (function estimate used):"
awk -F'\t' '{ printf "  %-11s est=%-8s used=%s\n", $1, $2, $3 }' "$MEASUREMENTS"
log "attack raw: 9taps_est? used=$TAPS_9_GAS | 30taps+skill used=$TAPS_30_GAS | killing_blow est=$KO_EST used=$KO_GAS taps=$KO_TAPS actor=$KO_ACTOR"
log "gasLimits written: freePull=$FREE paidPull=$PAID createDuel=$CREATE joinDuel=$JOIN attack=$ATTACK settle=$SETTLE"
log "done"