# Monicard

**Onchain trading-card battles on Monad. Every move is a transaction.**

Monicard is a real-time 1v1 card battle played entirely onchain. Draw cards from a face-down pile, hold them or place them on your three-slot board, and strike your opponent's front card. **Every draw, placement and attack is a Monad transaction**, so the board moves at chain speed with no game server deciding who wins. Play a friend on two phones, or fight the **AI Agent**, an NPC with its own wallet.

Built in one day at **Monad Blitz Jogja Vol. 2** (24 October 2026) by a solo builder with a team of AI agents.

[![Monicard demo video](https://img.youtube.com/vi/N-FRL6CPAis/maxresdefault.jpg)](https://youtu.be/N-FRL6CPAis)

- **Repo:** https://github.com/zakyirsyaad/monicard
- **Demo video:** https://youtu.be/N-FRL6CPAis
- **Launch post on X:** https://x.com/0xKayz_/status/2113913855734862058
- **LinkedIn post:** https://lnkd.in/p/gB2QTGnT
- **Live app on Monad Mainnet:** https://monicard.xyz (open on your phone; projector view at https://monicard.xyz/arena)
- **Live app on Monad Testnet:** https://nadgacha.43-134-58-217.sslip.io (same app, testnet contracts)
- **Networks:** Monad Mainnet (chain id 143) and Monad Testnet (chain id 10143), one game server per network

## Try it in 30 seconds

1. Open the live URL on your phone, in your real browser (not inside a QR-scanner app).
2. Tap **Card Battle · Best of 3**, then **Fight AI Agent**. Your burner wallet is created and funded automatically: no wallet app, no seed phrase.
3. At the start of your turn a new card is already in your hand (marked **NEW**). Tap a card to place it on your board, or hold it, then press **Attack**.
4. Win **two KOs** to win the match. Every action is a real transaction: open the MonadScan link on the result screen.

To play a friend, tap **Create match**, and let them scan the QR code.

### Pages

| Path | What it is |
|---|---|
| `/` | Landing page: how to play, live block and stats, why Monad, event mode for organisers |
| `/battle` | Card Battle lobby: fight the AI Agent, create a match (QR) or join one |
| `/battle/:id` | The match board: hand, three-slot board, Attack and Special |
| `/play` | Tap Blitz lobby, your card, paid pulls |
| `/pull` | Gacha reveal (free first pull, odds shown) |
| `/arena` | Projector view: live matches, tx feed with MonadScan links, stats, QR to join |

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
| `BattleStakeVault` | Staked Card Battle: both players stake, winner takes the pot minus a 5% rake | [`0xF33d88f0D06bf16EA254f0067c272Fa328125E9e`](https://testnet.monadscan.com/address/0xF33d88f0D06bf16EA254f0067c272Fa328125E9e#code) |
| `NadCards` | ERC-721 collection, free and paid pulls, 5% royalty (ERC-2981) | [`0x7AF33CB3823Ff99D37411A678452A7980d14CF9F`](https://testnet.monadscan.com/address/0x7AF33CB3823Ff99D37411A678452A7980d14CF9F#code) |
| `BlitzArena` | Tap Blitz: parallel real-time duels | [`0xc08c323df6a5f9fAbaF75A6060E4CA357F2251f9`](https://testnet.monadscan.com/address/0xc08c323df6a5f9fAbaF75A6060E4CA357F2251f9#code) |
| `StakeVault` | Staked Tap Blitz duels with a 5% treasury rake | [`0x642C1364b62344128087549ceeD9268D5E3385df`](https://testnet.monadscan.com/address/0x642C1364b62344128087549ceeD9268D5E3385df#code) |

### Monad Mainnet (chain id 143)

The same five contracts, same bytecode, deployed and verified on mainnet (`deployments/mainnet.json`). https://monicard.xyz plays on these contracts: players' burner wallets are funded with real MON by the relay, so a first-time visitor still needs no wallet.

| Contract | Monad Mainnet (143) |
|---|---|
| `CardBattle` | [`0x1407a7463ec8dEAA57C55Df634f4C150AE93d26f`](https://monadscan.com/address/0x1407a7463ec8dEAA57C55Df634f4C150AE93d26f#code) |
| `BattleStakeVault` | [`0x4D13C24b27E36B4338f42C43878C981A92f768f4`](https://monadscan.com/address/0x4D13C24b27E36B4338f42C43878C981A92f768f4#code) |
| `NadCards` | [`0x9ED90215833c4ADE8C72132AC079bc9e5d5A30A8`](https://monadscan.com/address/0x9ED90215833c4ADE8C72132AC079bc9e5d5A30A8#code) |
| `BlitzArena` | [`0xdd56839940F5E20a4543e82ab01F43991C445E9A`](https://monadscan.com/address/0xdd56839940F5E20a4543e82ab01F43991C445E9A#code) |
| `StakeVault` | [`0x2B740d932dD20B73230ff4cbfCF8F25b4Fe18933`](https://monadscan.com/address/0x2B740d932dD20B73230ff4cbfCF8F25b4Fe18933#code) |

Source is verified for every address above, on MonadScan and MonadVision.

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

## Run against Monad testnet

To use the deployed testnet contracts with your own keys:

1. `cp .env.example .env` and fill `MASTER_KEY` (funds burners and bots), `OPERATOR_KEY` (relay), `AGENT_KEY` (AI Agent wallet), `ADMIN_TOKEN`, and `RPC_URLS` (e.g. `https://testnet-rpc.monad.xyz`). Leave `DEPLOYMENT` empty for testnet. Fund the three wallets with testnet MON from the [Monad faucet](https://faucet.monad.xyz).
2. `pnpm install`
3. `bash server/scripts/serve.sh` builds the web app, then serves the API, WebSocket and the web app on `PORT` (default 8080).

To deploy fresh contracts instead, run the Foundry scripts in `contracts/script/` (`Deploy.s.sol`, `DeployBattle.s.sol`, `DeployStake.s.sol`, `DeployBattleStake.s.sol`) with `--rpc-url https://testnet-rpc.monad.xyz --broadcast`, then write the addresses to `deployments/testnet.json`.

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
| Staked duels | Both players stake MON, the winner takes the pot minus a 5% rake to the treasury | Live in Card Battle (`BattleStakeVault`) and Tap Blitz (`StakeVault`) |
| Season pass and cosmetics | Players | Roadmap |

Unit cost: one Card Battle action costs about 101,000 gas, roughly 0.01 MON at 102 gwei, so a full match is about 0.2 MON in gas across both players. In event mode the organiser's package funds that gas through the relay; packs and stake rake are upside on top.

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

## Media

- **Demo video:** https://youtu.be/N-FRL6CPAis
- **Launch post on X:** https://x.com/0xKayz_/status/2113913855734862058
- **LinkedIn post:** https://lnkd.in/p/gB2QTGnT
- **Showreel / ad video:** `marketing/showreel/monicard-battle-ad-1920x1080-60fps.mp4` (landscape) and `monicard-battle-ad-1080x1920-60fps.mp4` (vertical), rendered from `marketing/showreel/battle.html`.
- **Pitch script:** `marketing/pitch.md`.
- **Specs:** `docs/BATTLE-SPEC.md` (Card Battle rules and contract), `docs/design-system/` (brand book, tokens, Nadmon art).

## Roadmap

Sponsor-funded tournament escrow, verifiable randomness (VRF), embedded-wallet login, ERC-8004 identity for the AI Agent, a native card marketplace, and a learning loop for the Card Battle agent.

## License

MIT, see [LICENSE](LICENSE).
