# NadGacha: BlitzArena

A real-time 1v1 trading-card duel on Monad: pull a free onchain card, then fight a 20-second duel where **every batch of taps is a transaction**. Duel a friend on two phones, or fight the **AI Agent**, an NPC with its own wallet that learns from every duel.

Built in one day at **Monad Blitz Jogja Vol. 2** (24 October 2026).

## Live demo

- App: **https://nadgacha.43-134-58-217.sslip.io** (open on your phone)
- Projector view: https://nadgacha.43-134-58-217.sslip.io/arena
- Demo video: _TODO link_
- Post on X: _TODO link_

## Try it in 30 seconds

1. Open the live URL on your phone (in your real browser, not inside a QR scanner app).
2. Tap **Pull** to mint your free card. Stats are rolled onchain.
3. Tap **Fight AI Agent** and tap as fast as you can for 20 seconds.
4. Every tap batch is a Monad transaction. Tap the latency badge to open the last tx on MonadScan.

To play a friend instead, pick **Challenge a friend** and let them scan the QR code.

## Contracts

| Contract | Monad Testnet (10143) | Monad Mainnet (143) |
|---|---|---|
| `NadCards` (ERC-721 + ERC-2981) | _TODO_ ([MonadScan](https://testnet.monadscan.com/address/TODO)) | _TODO_ ([MonadScan](https://monadscan.com/address/TODO)) |
| `BlitzArena` (parallel duels) | _TODO_ ([MonadScan](https://testnet.monadscan.com/address/TODO)) | _TODO_ ([MonadScan](https://monadscan.com/address/TODO)) |

Source is verified on MonadScan for every address above. The app runs on testnet; the mainnet deployment is the same bytecode.

## Run locally (no MON needed)

Prerequisites: **Node 20+**, **pnpm** (`corepack enable`), **Foundry** (`curl -L https://foundry.paradigm.xyz | bash && foundryup`).

```bash
git clone <this repo> nadgacha && cd nadgacha
pnpm install
pnpm local
```

`pnpm local` starts a local Anvil chain (chain id 10143, 1-second blocks), deploys both contracts, starts the game server with Anvil's default accounts (no `.env` needed), and starts the web app. Open the URL it prints. _TODO: confirm output and URL after N4._

Tests:

```bash
cd contracts && forge test          # contract tests
pnpm test:shared                    # shared game formulas
pnpm -F server test                 # server
pnpm -F @nad/web test               # web
```

## Architecture

```text
 Phone (burner wallet)  ──signed tx──▶  Game server (Node: Hono + ws + viem)  ──▶  Monad
        ▲                                 /relay  /fund  /config  /card/:id
        └──────── WebSocket (one read per block, broadcast to all) ◀──┘
```

- **Phones sign, the server relays.** Each player has a burner wallet in `localStorage`; the server only forwards signed transactions, so they stay the player's own.
- **One read per block.** A block watcher fetches all receipts with one `eth_getBlockReceipts` call per block, and a poller reads every active duel with one `getDuels()` call, then broadcasts over WebSocket. RPC load stays flat no matter how many people play.
- **Chain is the referee.** Damage, winners and card records live onchain. If the server dies mid-duel, the duel is still valid and gets settled when it comes back.
- **Shared formulas.** `shared/` mirrors the contract maths in TypeScript, tested with the same vectors as the Foundry tests, so phones can predict damage before the receipt lands.

Repo layout: `contracts/` (Foundry), `shared/` (game formulas + ABIs), `server/` (relay, watcher, AI Agent, card art), `web/` (Vite + React).

## Built for Monad

1. **Clamp, never revert.** On Monad a reverted tx still pays its full gas limit, so late, early or oversized taps are clamped instead of reverting.
2. **Small hot path, fixed cost.** `attack()` touches only its own duel's 3 storage slots and calls no other contract; win/loss recording moves to `settle()`. The gas limit stays tight and predictable, which matters because Monad charges by gas limit.
3. **Isolated state per duel.** Different duels never touch the same slot, so they execute in parallel.
4. **MIP-8 makes every tap cheaper.** One duel is 3 consecutive slots, so `attack()` pays one cold page read instead of three. Measured with `cast estimate`: _TODO numbers_.

## Business model

| Model | Status |
|---|---|
| Paid packs: first pull free, then 0.05 MON, odds shown and rolled onchain; funds stay in the `NadCards` treasury | Live (`paidPull`) |
| 5% marketplace royalty (ERC-2981) | In the contract |
| Sponsored event arenas: branded projector view with live player, duel, tx and treasury stats | Live (`/arena`) |
| Staked duels (winner takes the pot, 5% fee) | Roadmap |

## Roadmap

Staked PvP duels, sponsor-funded tournament escrow, verifiable randomness (VRF), ERC-8004 identity for the AI Agent, a native card marketplace, and real reinforcement learning for the agent.

## License

MIT
