# Monicard

**Real-time onchain TCG duels on Monad. Every tap is a transaction.**

Monicard is a real-time 1v1 trading-card duel on Monad: pull a free onchain card, then fight a 20-second duel where **every batch of taps is a transaction**. Duel a friend on two phones, or fight the **AI Agent**, an NPC with its own wallet that learns from every duel.

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
| `NadCards` (ERC-721 + ERC-2981) | [`0x7AF33CB3823Ff99D37411A678452A7980d14CF9F`](https://testnet.monadscan.com/address/0x7AF33CB3823Ff99D37411A678452A7980d14CF9F#code) | _TODO_ ([MonadScan](https://monadscan.com/address/TODO)) |
| `BlitzArena` (parallel duels) | [`0xc08c323df6a5f9fAbaF75A6060E4CA357F2251f9`](https://testnet.monadscan.com/address/0xc08c323df6a5f9fAbaF75A6060E4CA357F2251f9#code) | _TODO_ ([MonadScan](https://monadscan.com/address/TODO)) |

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

## Who it's for

- **First customer: organisers of web3 community events** (meetups, hackathons) who need an onchain onboarding activity that people actually enjoy.
- **Players** scan a QR code and are playing in about 3 seconds: no wallet app, no seed phrase. Every tap is a transaction anyone can verify.
- **Organisers** get a branded projector screen, live stats and provable onchain engagement for their sponsors.

## Business model

| Stream | How | Status |
|---|---|---|
| Event mode (B2B) | Organisers pay for a branded arena; the relay subsidises players' gas | Live (`/arena`) |
| Paid packs | First pull free, then 0.05 MON per pack, odds shown and rolled onchain; funds go to the contract treasury (`paidPull` / `withdraw`) | Live |
| Marketplace royalty | 5% on every resale (ERC-2981) | Live (in the contract) |
| Season pass, cosmetics, staked duels | Depends on local regulation | Roadmap |

Unit cost: one `attack` tx = 62,000 gas ≈ 0.006 MON at 102 gwei.

## What's new / Why Monad

- **Gameplay is onchain, tap by tap**, not just NFT ownership. A 20-second duel is dozens of real transactions.
- **Every duel lives in its own 3 storage slots**, so duels never touch the same state and execute in parallel on Monad. One duel is 3 consecutive slots, so MIP-8 makes every tap cheaper.
- **Built around Monad's rules:**
  - timing uses `block.number`, never the 1-second-resolution timestamp;
  - late or excess taps are clamped instead of reverting, because Monad charges by gas limit;
  - `attack()` touches only its duel and calls no other contract, so its gas limit stays tight;
  - the server's tx queue respects Monad's reserve-balance rule;
  - the server makes one `eth_getBlockReceipts` call per block, no matter how many people play.
- **An AI Agent that learns.** It plays with its own wallet; after each duel a coach adjusts its policy and publishes the lesson. Its win/loss record is onchain.
- **Original IP.** The Nadmon roster is our own design.

## Roadmap

Staked PvP duels, sponsor-funded tournament escrow, verifiable randomness (VRF), ERC-8004 identity for the AI Agent, a native card marketplace, and real reinforcement learning for the agent.

## License

MIT
