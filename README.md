# Monicard

**Onchain trading-card battles on Monad. Every move is a transaction.**

Monicard is a real-time 1v1 card battle played entirely onchain. Draw cards from a face-down pile, hold them or place them on your three-slot board, and strike your opponent's front card. **Every draw, placement and attack is a Monad transaction**, so the board moves at chain speed with no game server deciding who wins. Play a friend on two phones, or fight the **AI Agent**, an NPC with its own wallet.

Built in one day at **Monad Blitz Jogja Vol. 2** (24 October 2026) by a solo builder with a team of AI agents.

- **Repo:** https://github.com/zakyirsyaad/monicard
- **Live app:** https://nadgacha.43-134-58-217.sslip.io (open on your phone)
- **Projector view:** https://nadgacha.43-134-58-217.sslip.io/arena
- **Network:** Monad Testnet (chain id 10143)

## Try it in 30 seconds

1. Open the live URL on your phone, in your real browser (not inside a QR-scanner app).
2. Tap **Card Battle · Best of 3**, then **Fight AI Agent**. Your burner wallet is created and funded automatically: no wallet app, no seed phrase.
3. At the start of your turn a new card is already in your hand (marked **NEW**). Tap a card to place it on your board, or hold it, then press **Attack**.
4. Win **two KOs** to win the match. Every action is a real transaction: open the MonadScan link on the result screen.

To play a friend, tap **Create match**, and let them scan the QR code.

## How a battle works

- **Draw pile:** each player has a face-down pile of 10 cards, **generated onchain as they are drawn** (element, rarity, ATK, HP). Cards are temporary and unrelated to the NFTs you own, so anyone can play instantly.
- **Hand:** every turn you draw one random card. Your hand can hold as many cards as you want.
- **Board:** three slots. Cards you place enter play at full HP and keep their damage until KO.
- **Attack:** all of your board cards strike your opponent's **front card** together. Damage is summed, with element advantage: **Water > Fire > Lightning > Water** (×1.5 for the advantage, ×0.75 for the disadvantage).
- **Special:** once per match, doubles your total damage.
- **Win:** each KO scores a point; **two KOs win**. A turn has a 100-block (about 30 s) clock: if a player disappears, the opponent can claim the win onchain.

A match is roughly 15 to 25 transactions at about 0.01 MON each.

**Tap Blitz** is the original second mode: a 20-second real-time duel where batches of taps are transactions (contract `BlitzArena`), with optional staked duels (`StakeVault`) and a bot swarm on the projector view.

## Contracts

| Contract | Role | Monad Testnet (10143) |
|---|---|---|
| `CardBattle` | Card Battle: onchain draws, hand, board, best of 3 | [`0x68B4759FaA160907327a6eB40dAe0A4094A90242`](https://testnet.monadscan.com/address/0x68B4759FaA160907327a6eB40dAe0A4094A90242#code) |
| `NadCards` | ERC-721 collection, free and paid pulls, 5% royalty (ERC-2981) | [`0x7AF33CB3823Ff99D37411A678452A7980d14CF9F`](https://testnet.monadscan.com/address/0x7AF33CB3823Ff99D37411A678452A7980d14CF9F#code) |
| `BlitzArena` | Tap Blitz: parallel real-time duels | [`0xc08c323df6a5f9fAbaF75A6060E4CA357F2251f9`](https://testnet.monadscan.com/address/0xc08c323df6a5f9fAbaF75A6060E4CA357F2251f9#code) |
| `StakeVault` | Staked Tap Blitz duels with a 5% treasury rake | [`0x642C1364b62344128087549ceeD9268D5E3385df`](https://testnet.monadscan.com/address/0x642C1364b62344128087549ceeD9268D5E3385df#code) |

Source is verified for every address above. The Monad Mainnet deployment (chain id 143) uses the same bytecode and is listed in `deployments/mainnet.json` once broadcast.

## Run locally (no MON needed)

Prerequisites: **Node 20+**, **pnpm** (`corepack enable`), **Foundry** (`curl -L https://foundry.paradigm.xyz | bash && foundryup`).

```bash
git clone https://github.com/zakyirsyaad/monicard.git && cd monicard
pnpm install
pnpm local
```

`pnpm local` starts a local Anvil chain (chain id 10143, 0.3-second blocks like Monad), deploys the game contracts, starts the game server with Anvil's default dev accounts (no `.env`, no MON), and starts the web app. When it prints the banner, open **http://localhost:5173** (or the LAN address it prints, on your phone). Tap **Card Battle**, then **Fight AI Agent**. Press Ctrl+C to stop everything.

Ports 8545, 8080 and 5173 must be free. The local chain is throwaway: stopping it forgets all cards and matches.

Tests:

```bash
cd contracts && forge test          # contract tests
pnpm test:shared                    # shared game formulas and ABIs
pnpm -F server test                 # server
pnpm -F @nad/web test               # web
```

## Architecture

```text
 Phone (burner wallet) ──signed tx──▶ Game server (Node: Hono + ws + viem) ──▶ Monad
        ▲                               /relay  /fund  /config  /card/:id  /agent/*
        └─────── WebSocket (one read per block, broadcast to all) ◀──┘
```

- **Phones sign, the server relays.** Each player has a burner wallet in `localStorage`. The server only forwards signed transactions after checking the target contract, function, value and gas, so every action stays the player's own.
- **One read per block.** A block watcher fetches all receipts with one `eth_getBlockReceipts` call per block, and a poller reads the active matches and duels with one call each, then broadcasts over WebSocket. RPC load stays flat no matter how many people play.
- **The chain is the referee.** Draws, damage, KOs and winners live onchain. If the server dies mid-match, the match is still valid and the opponent can claim a timeout.
- **AI Agent.** It owns a wallet and plays both modes through the same relay as a human. Its policy (when to fire Special) comes from what it learned in Tap Blitz duels: after each duel a coach updates the policy and publishes a lesson.
- **Shared formulas.** `shared/` mirrors the contract maths in TypeScript, tested with the same vectors as the Foundry tests.

Repo layout: `contracts/` (Foundry), `shared/` (game formulas + ABIs), `server/` (relay, watcher, poller, AI Agent, card art), `web/` (Vite + React), `deployments/` (addresses per network), `docs/` (design system, specs).

## Who it's for

- **First customer: organisers of web3 community events** (meetups, hackathons) who need an onchain onboarding activity that people actually enjoy.
- **Players** scan a QR code and are playing in about 3 seconds: no wallet app, no seed phrase. Every move is a transaction anyone can verify.
- **Organisers** get a branded projector screen, live stats and provable onchain engagement for their sponsors.

## Business model

| Stream | How | Status |
|---|---|---|
| Event mode (B2B) | Organisers pay for a branded arena; the relay subsidises players' gas. Card Battle itself is free to play and acts as the funnel | Live (`/arena`) |
| Paid packs | First pull free, then 0.05 MON per pack, odds shown and rolled onchain; funds go to the contract treasury (`paidPull` / `withdraw`) | Live |
| Marketplace royalty | 5% on every resale (ERC-2981) | Live (in the contract) |
| Staked duels | Both players stake MON, the winner takes the pot minus a 5% rake to the treasury | Live in Tap Blitz (`StakeVault`); Card Battle staking is next |
| Season pass and cosmetics | Players | Roadmap |

Unit cost: one Card Battle action costs about 101,000 gas, roughly 0.01 MON at 102 gwei. Onboarding a player costs less than a sticker.

## What's new / Why Monad

- **Gameplay is onchain, move by move**, not just NFT ownership. A match is 15 to 25 real transactions.
- **Every match and duel lives in its own storage**, so they never touch the same state and execute in parallel on Monad. The projector view runs many matches at once.
- **Built around Monad's rules:**
  - all timing uses `block.number` (turn clocks, timeouts), never the 1-second-resolution timestamp;
  - gas is charged on the gas limit, so every function has a measured, tight limit;
  - the server's transaction queue respects Monad's reserve-balance rule and the 3-block delayed state view;
  - the server makes one `eth_getBlockReceipts` call per block, no matter how many people play.
- **Onchain randomness for drawing**, with generated cards that need no NFT ownership, so a first-time visitor can play in seconds.
- **An AI Agent with its own wallet** that plays through the same relay as everyone else.
- **Original IP.** The Nadmon roster is our own design.

## Roadmap

Staked Card Battle, sponsor-funded tournament escrow, verifiable randomness (VRF), embedded-wallet login, ERC-8004 identity for the AI Agent, a native card marketplace, and a learning loop for the Card Battle agent.

## License

MIT
