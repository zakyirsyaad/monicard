# NadGacha: BlitzArena — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Web game mobile-first di Monad testnet: pull 1 kartu NFT gratis, lalu duel 1v1 real-time 20 detik (PvP atau vs AI Agent yang belajar), dengan swarm duel bot paralel di layar proyektor.

**Architecture:** Dua kontrak Foundry (`NadCards` ERC-721, `BlitzArena` duel paralel dengan state 3 slot per duel). Satu service Node (Hono + ws + viem) yang meneruskan tx bertanda tangan burner, membaca chain satu kali per blok lalu menyiarkan via WebSocket, dan menjalankan AI Agent serta swarm bot. Client Vite React dengan burner wallet dan mesin tx "1 tx in-flight". Rumus game ditulis sekali di paket `shared/` dan dipakai server serta web, dengan vektor uji yang sama seperti test Foundry.

**Tech Stack:** Solidity ^0.8.24, Foundry 1.7, OpenZeppelin Contracts v5, Node 22, pnpm workspace, TypeScript 5, Hono 4, ws 8, viem 2, zod 3, vitest 2, Vite 5 + React 18 + Tailwind 3, `qrcode.react`, VPS user + nginx (addendum N5; awalnya Cloudflare Tunnel `cloudflared` quick tunnel) dari laptop.

**Spec:** `blueprint_v2_nadgacha_blitzarena.md` (root repo). Nomor § di plan ini merujuk ke spec tersebut.

**Agent pelaksana:** dua agent paralel — Qwen Code untuk jalur backend (`QWEN.md`) dan Claude Code untuk jalur frontend (`CLAUDE.md`); lihat "Pembagian Kerja". Di Qwen, subagent dipanggil lewat tool `agent` dan skill-nya `superpowers:subagent-driven-development` (extension Superpowers sudah terpasang).

**Metode eksekusi (dipilih 23 Okt, ditegaskan ulang):** Subagent-driven — satu subagent implementer per task + **reviewer penuh untuk setiap task** (termasuk task kecil), review menyeluruh di akhir. Tidak ada peralihan ke eksekusi tanpa reviewer. Kalau terlambat, yang dipotong adalah **fitur**, mengikuti urutan pemangkasan dan tabel titik keputusan di spec §11 (checkpoint A 10:45, B 13:10, 🚩 C 13:45, D 15:10). Task 16 dan halaman `/control` adalah yang pertama dipotong.

**Dikerjakan dua agent paralel** — lihat bagian "Pembagian Kerja" di bawah.

**Penyimpangan kecil dari spec §3.4:** skrip (`setup-bots`, `e2e`, `train`) diletakkan di `server/scripts/` (bukan `scripts/` di root) supaya bisa mengimpor modul server, dan ditambah paket `shared/` untuk rumus game (DRY antara web dan server).

## Pembagian Kerja (dua agent paralel)

| Jalur | Agent | Folder milik jalur ini | Task |
|---|---|---|---|
| **Backend** | Qwen Code (`QWEN.md`) | `contracts/`, `shared/`, `server/`, `deployments/`, dan file root (`package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.gitignore`, `.env.example`) | 1–10, 13, 14, **15s** (server: `swarm.ts`, `admin.ts`, `admin.sh`), 16, 17 (cek secret, README) |
| **Frontend** | Claude Code, sesi baru di app Claude (`CLAUDE.md`) | `web/` saja | **11a–c**, **12a–d**, **15w** (`Arena.tsx`), UI mode AI Agent, halaman `/control` (bonus), 17 (build web, tes perangkat dan video bersama user) |

**Aturan koordinasi:**
1. **Kontrak antarmuka dibekukan.** Bagian "Kontrak Antarmuka Bersama" (HTTP API, pesan WebSocket, env) dan ekspor `@nad/shared` (Interfaces Task 4) tidak boleh diubah sepihak. Kalau satu jalur butuh perubahan: berhenti, tulis usulan ke user, dan user yang meneruskannya ke jalur lain.
2. **Disiplin folder.** Jangan pernah mengedit folder milik jalur lain. Commit hanya folder sendiri (`git add web/` atau `git add contracts shared server deployments`), **tidak pernah `git add -A`**. Prefix commit: `feat(web)` / `feat(contracts|shared|server)`.
3. **Bootstrap.** Langkah pertama Qwen (Task 1 Step 1): `git init`, kerangka workspace root (`package.json` private dengan `"packageManager": "pnpm@12.10.1"` — versi yang terpasang di laptop; `pnpm@9` ditolak corepack —, `pnpm-workspace.yaml` berisi `shared`, `server`, `web`, `tsconfig.base.json`), **stub `shared/`** (`shared/package.json` bernama `@nad/shared`, `"type": "module"`, `"main": "src/index.ts"`, `"exports": {".": "./src/index.ts"}`, dan `shared/src/index.ts` kosong — tanpa ini `pnpm install` di `web/` gagal karena `@nad/shared@workspace:*` tidak ditemukan), `.gitignore`, `.env.example`, lalu commit `chore: workspace skeleton` dalam ±5 menit. **Commit ini juga memasukkan semua dokumen yang sudah ada** (`blueprint_*.md`, `docs/`, `QWEN.md`, `CLAUDE.md`), supaya rencana dan design system ikut ter-versi dan ikut ke repo submission. Frontend mulai menulis file setelah commit itu terlihat di `git log`. Web memakai `@nad/shared` langsung dari source TypeScript (Vite mengompilasinya), bukan dari `dist`.
   - **Lockfile:** `pnpm-lock.yaml` milik backend dan di-commit backend (Task 4, lalu di setiap checkpoint). Frontend menambah dependency hanya lewat `pnpm -F @nad/web add <pkg>` dan **tidak pernah meng-commit lockfile**. Jangan menjalankan `pnpm install` dari dua agent bersamaan; kalau instalasi gagal karena lock, tunggu dan ulangi.
4. **Ketergantungan frontend dan penggantinya:**
   - `@nad/shared` (Task 4, ±11:00). Sebelum itu frontend mengerjakan bagian yang tidak butuh rumus (setup, komponen, layout).
   - Server: sampai ±12:20 frontend memakai **mock** (`web/src/mock/`, aktif dengan `VITE_USE_MOCK=1`) yang meniru persis HTTP API dan pesan WebSocket di kontrak. Mulai ±12:20 (Task 8 selesai) backend menjalankan server dev di laptop yang sama **terhubung ke testnet** (`pnpm -F server dev`, `DEPLOYMENT=testnet`, `FUND_ENABLED=true`, port 8080), dan frontend mengarahkan proxy Vite ke sana. Tidak ada fase anvil untuk frontend. Di Task 10, backend mengganti server dev dengan `serve.sh` di port yang sama (beri tahu user sebelum mematikan server dev). Kartu SVG baru ada setelah Task 9; selama mock, `<img>` kartu memakai placeholder `web/public/mock/card.svg`.
   - Dev server Vite mem-proxy `/config`, `/account`, `/fund`, `/relay`, `/card`, `/agent`, `^/admin/` (regex, hanya API admin), dan `/ws` (dengan `ws: true`) ke `http://localhost:8080`. Halaman kontrol web bernama **`/control`** (bukan `/admin`) supaya tidak bertabrakan dengan API.
5. **Titik serah-terima** (user meneruskan kabar antar jalur): Task 4 selesai → frontend memakai `@nad/shared`; Task 8 selesai + server dev jalan → frontend memakai API sungguhan; Task 9 selesai → kartu SVG asli tersedia; checkpoint B → testnet; Task 13 selesai → tombol "Fight AI Agent" sungguhan; Task 15s selesai → swarm tampil di `/arena`.
6. **Produksi.** `serve.sh` (milik backend) mem-build `web/` lalu server menyajikan `web/dist`. Frontend memastikan `pnpm -F @nad/web build` selalu lulus sebelum commit.

## Global Constraints

- Chain ID `10143`; RPC publik `https://testnet-rpc.monad.xyz` hanya untuk cadangan baca; explorer `https://testnet.monadscan.com`.
- Semua timing di kontrak memakai `block.number`, **tidak pernah** `block.timestamp`.
- Konstanta duel: `COUNTDOWN_BLOCKS = 10`, `DUEL_BLOCKS = 67`, `MAX_TAPS_PER_BLOCK = 3`, `MAX_TAPS_PER_TX = 30`.
- Rarity dari roll 0–99: `<60` Common (0), `<88` Rare (1), `<98` Epic (2), sisanya Legendary (3).
- ATK = `10 + (0..4) + rarity`; HP = `1500 + (0..300) + 100 × rarity`; elemen 0 Fire, 1 Water, 2 Lightning.
- **Semua teks yang dilihat pemain dan juri dalam bahasa Inggris**: UI, kartu SVG, lore, gelar, ejekan, pelajaran agent, pesan error, layar proyektor, template fallback. Angka memakai koma ribuan (`1,950`, `#73,562,481`). Dokumen dan komentar internal boleh Indonesia. Aturan teks lengkap: bagian "Konten" di `docs/design-system/README.md`.
- Pengali elemen: penyerang `a` unggul atas `d` jika `(d + 1) % 3 == a` → 150; sama → 100; kalah → 75.
- Damage tap = `taps × atk × mult / 100`. Skill = `atk × mult × (10·maxHp + 40·(maxHp − hp)) / (100·maxHp)`, 1× per duel. Semua aritmetika kontrak di `uint256`, HP dikurangi secara jenuh.
- Kontrak: clamp, jangan revert, untuk tap kelebihan, terlambat, atau sebelum mulai. `attack()` tidak memanggil kontrak lain.
- `gasLimit` = hasil `cast estimate` di testnet × 1,2 (bukan `forge --gas-report`).
- `/fund`: 0,3 MON awal; isi ulang 0,3 MON jika saldo < 0,1 MON; maks 3× per alamat; 10 per IP per 10 menit; budget total 3 MON; bisa dimatikan admin.
- `/relay` hanya menerima: `chainId` 10143, `to` ∈ {NadCards, BlitzArena}, selector ∈ {`freePull`, `paidPull`, `createDuel`, `joinDuel`, `attack`, `settle`}, `value = 0` **kecuali** `paidPull` yang wajib `value = pullPrice`, `gasLimit` ≤ batas fungsi di `/config`.
- **Model bisnis yang dibangun:** (1) pack berbayar `paidPull` seharga `PULL_PRICE = 0.05 ether` (testnet MON) dengan uang masuk ke kontrak `NadCards` sebagai treasury; (2) royalti marketplace 5% lewat ERC-2981; (4) mode event bersponsor: branding event, statistik, dan leaderboard di `/arena`. Model (3) duel dengan taruhan **hanya roadmap**: jangan menambah `payable` ke `BlitzArena`.
- Client: 1 tx in-flight per pemain; jarak antar tx ≥ `batchMs` (default 1000, alternatif 2000); flush terakhir di `endBlock − 3`; berhenti di `endBlock − 2`; relay timeout 5 dtk → kirim ulang raw tx yang sama.
- Server: 1× `eth_getBlockReceipts` per blok baru; poller membaca `getDuels` sekali per blok baru; `duelCount` dilacak dari event `DuelCreated` (dibaca dari chain hanya saat startup); beban RPC dasar ≈ 13 rps; `gasPrice` diperbarui tiap ~10 dtk; satu antrean berurutan per wallet server.
- Semua tx (client & server): `maxFeePerGas = 2 × gasPrice`, `maxPriorityFeePerGas = 2 gwei`. Harga efektif tetap base fee + priority; headroom hanya mencegah tx ditolak kalau base fee naik.
- QR & link duel memakai `location.origin` halaman yang sedang dibuka (tidak perlu build ulang kalau URL berubah; URL publik sekarang `https://nadgacha.43-134-58-217.sslip.io` di VPS, addendum N5). `PUBLIC_URL` di server hanya untuk `tokenURI` dan URL gambar metadata.
- LLM: lore timeout 4 dtk → template; mulut tiap ~5 dtk, ≤ 80 karakter, timeout 2,5 dtk → diam; pelatih: pelajaran ≤ 120 karakter, `thresholdDelta ∈ [−10, +10]`, threshold dijaga di `[10, 90]`.
- AI Agent: nama UI "AI Agent"; tap 7–8/dtk + jitter; bot 5–9/dtk; level = `min(6, 1 + floor(totalWins / 10))`; peluang abaikan kebijakan = `0.5 − 0.1 × (level − 1)` (0 di Lv.6); 1 duel per waktu; pelatih hanya belajar dari duel `ikutKebijakan`.
- Persona AI Agent (bahasa Inggris): santai, percaya diri, meledek dengan sopan; tidak menyerang pribadi; tidak memakai kata "bet", "wager", atau "gamble".
- Tidak ada secret yang memakai awalan `VITE_`. Semua private key hanya di env server.
- **Design system: `docs/design-system/`** (arah "Monad-native bersih"). Semua warna, font, spasi, dan radius di web dan SVG kartu diambil dari `tokens.json` / `tokens.css`; tidak ada hex yang ditulis langsung di komponen. Aturan pemakaian ada di `docs/design-system/README.md`, aturan tiap komponen di `docs/design-system/components/<Comp>/README.md`, dan `preview.html` di folder yang sama adalah acuan visualnya. Tidak ada shadow, gradien, glow, emoji, atau logo Monad — **kecuali** kilau foil Legendary di atas `<img>` kartu (satu-satunya gradien). **Kartu full dirender sekali di server sebagai SVG** (Task 9) dan web menampilkannya lewat `<img>`; React hanya membuat `GameCard` compact. Warna token adalah variabel CSS, jadi modifier opacity Tailwind (`bg-berry/40`) tidak menghasilkan CSS: pakai elemen terpisah dengan `opacity-40`.
- Data server (`cards.json`, `agent.json`, `bots.json`, `fund.json`) di `DATA_DIR` = folder `data/` di laptop (masuk `.gitignore`).
- **Semua path di-resolve dari root repo** (`ROOT` dihitung dari `import.meta.url` di `server/src/env.ts`), dan `.env` dibaca dari root. Alasannya: `pnpm -F server …` berjalan dengan cwd `server/`, sedangkan `serve.sh` berjalan dari root.
- `chainId` dibaca dari `deployments/<DEPLOYMENT>.json`, tidak di-hardcode. Anvil selalu dijalankan dengan `--chain-id 10143` supaya kode penandatanganan sama untuk anvil dan testnet.
- Skrip TypeScript dijalankan dengan `tsx` (devDependency di root).

## Review Focus

1. **Pemain reload halaman di tengah duel** → burner sama dari `localStorage`, nonce disinkronkan dari chain, layar duel kembali dari snapshot WebSocket, pemain bisa lanjut tap. Test di Task 11 (`resumes from chain nonce after reload`).
2. **Dua orang scan QR duel yang sama hampir bersamaan** → yang kedua mendapat pesan "This duel already started. Create a new one.", bukan error mentah. Test di Task 2 (`test_join_rejectsSecondJoiner`) dan Task 12 (pemetaan revert → pesan).
3. **Relay menjawab `already known` / `nonce too low` setelah kirim ulang** → dianggap mungkin sukses, ditunggu berdasarkan hash, tap tidak tercatat dua kali. Test di Task 6 (`treats already-known as pending`) dan Task 11 (`resends identical raw tx on timeout`).
4. **Server restart di tengah duel** → client reconnect, menerima snapshot penuh, duel yang lewat waktu tetap di-`settle` oleh poller setelah hidup lagi. Test di Task 8 (`selectSettleable` mencakup duel Active yang lewat waktu).
5. **LLM mengembalikan JSON tidak valid atau kosong** → lore/pelatih jatuh ke fallback, bukan crash. Test di Task 9 (`falls back on invalid JSON`) dan Task 14 (`coach falls back to rules on invalid output`).

---

## Struktur File

```text
monad-tcg/
├── package.json, pnpm-workspace.yaml, tsconfig.base.json, .gitignore, .env.example
├── data/                          cards.json, agent.json, bots.json, fund.json, agent.train.json (gitignored)
├── contracts/                       Foundry
│   ├── src/NadCards.sol             kartu ERC-721 + freePull + recordResult
│   ├── src/BlitzArena.sol           duel: create/join/attack/settle/getDuels
│   ├── src/interfaces/INadCards.sol interface yang dipakai Arena
│   ├── test/NadCards.t.sol
│   ├── test/BlitzArena.t.sol
│   └── script/Deploy.s.sol
├── deployments/                     testnet.json, anvil.json (alamat + gasLimits)
├── shared/src/
│   ├── constants.ts                 konstanta duel + rarity
│   ├── game.ts                      rumus murni (cermin kontrak)
│   ├── duel.ts                      tipe DuelView + decodeDuels
│   ├── abi.ts                       ABI hasil ekspor dari contracts/out
│   ├── bytecode.ts                  bytecode kontrak (hanya untuk skrip anvil)
│   └── nadmon.ts                    roster Nadmon, nadmonFor, strongAgainst, weakTo
├── server/src/
│   ├── env.ts                       parse env dengan zod
│   ├── chain.ts                     client viem + failover RPC
│   ├── walletQueue.ts               antrean tx berurutan per wallet
│   ├── receiptHub.ts                pending hash ↔ receipt
│   ├── blockWatcher.ts              loop per blok
│   ├── relay.ts                     validateRawTx + route /relay
│   ├── fund.ts                      FundLimiter + route /fund
│   ├── poller.ts                    getDuels + selectSettleable + broadcast
│   ├── ws.ts                        hub WebSocket
│   ├── cards/lore.ts, cards/svg.ts, cards/store.ts, cards/routes.ts
│   ├── llm.ts                       client OpenAI-compatible + timeout
│   ├── agent/policy.ts              decideSkill, levelFromWins, ignoreProbability, agentTapRate
│   ├── agent/coach.ts               ruleCoach, llmCoach, applyCoach
│   ├── agent/mouth.ts               taunt
│   ├── agent/runner.ts              loop duel agent di chain
│   ├── agent/store.ts               agent.json (policy, jurnal, memori lawan, statistik)
│   ├── swarm.ts                     pasangan bot
│   ├── admin.ts                     route admin
│   ├── event.ts                     statistik event + leaderboard
│   ├── stats.ts                     tx counter, tx/dtk, latency
│   └── app.ts, main.ts              rakit Hono + ws + loop
├── server/scripts/                  setup-bots.ts, e2e.ts, train.ts, merge-agent.ts, fund.ts, check-secrets.ts, serve.sh, admin.sh
└── web/src/
    ├── lib/burner.ts, lib/api.ts, lib/txEngine.ts, lib/useArenaSocket.ts, lib/errors.ts
    ├── public/nadmon/*.svg          salinan docs/design-system/assets/Nadmon
    ├── styles/tokens.css            salinan docs/design-system/tokens.css
    ├── components/GameCard.tsx, HpBar.tsx, TapButton.tsx, SkillButton.tsx, LatencyBadge.tsx (spesifikasi: docs/design-system/components/)
    └── routes/Home.tsx, Pull.tsx, Play.tsx, Duel.tsx, Arena.tsx, Control.tsx
```

## Kontrak Antarmuka Bersama (dipakai banyak task)

**HTTP API**
| Method & path | Request | Response |
|---|---|---|
| `GET /config` | — | `{chainId: 10143, contracts: {cards, arena}, gasLimits: {freePull, paidPull, createDuel, joinDuel, attack, settle}, gasPrice: string, batchMs: number, pullPrice: string, event: {name: string, sponsor: string | null}, agent: Hex, bots: Hex[]}` (`pullPrice` dalam wei; `event` dari env `EVENT_NAME` / `EVENT_SPONSOR`; `agent` = alamat AI Agent; `bots` = alamat bot swarm, untuk label dan untuk membedakan duel bot) |
| `POST /fund` | `{address}` | `{funded: boolean, txHash?: Hex, reason?: 'disabled'|'limit_address'|'limit_ip'|'budget'|'balance_ok'}` |
| `GET /account/:address` | — | `{nonce: number, balance: string, cardId: string | null}` (nonce `pending`, balance dalam wei, `cardId` dari `cardOf`; dibaca server lewat RPC berbayar supaya HP tidak memakai RPC publik) |
| `POST /relay` | `{rawTx: Hex}` | `{hash: Hex, status: 'success'|'reverted', latencyMs: number, blockNumber: string, events: { tokenId?: string; duelId?: string }}` atau `400/429 {reason}`. `events` didekode dari log `CardMinted` / `DuelCreated` di receipt, supaya client tahu tokenId hasil pull dan duelId untuk QR |
| `GET /card/:id{[0-9]+}` | — | metadata ERC-721 `{name, description, image, attributes[]}` atau `{status: 'forging'}`; `404` kalau token tidak ada |
| `GET /card/:id{[0-9]+}/image.svg` | — | `image/svg+xml` (route `/card/:id.svg` **tidak dipakai**: di Hono 4 route itu ikut menangkap `/card/5` dan `id` terbaca `undefined`) |
| `POST /agent/challenge` | `{duelId}` | `{ok: true}`, `409 {reason: 'busy'|'reserved'|'not_open'|'stale'}`, atau `429 {reason: 'limit_ip'}` |
| `POST /admin/*` | header `x-admin-token` | lihat Task 15 |

**Pesan WebSocket (`/ws`)**
```ts
type WsMessage =
  | { type: 'duels'; block: string; duels: DuelView[]; featuredId: string | null }   // server mengisi featuredId dengan duel non-bot terbaru kalau admin belum memilih
  | { type: 'stats'; block: string; txTotal: number; txPerSec: number; avgLatencyMs: number;
      uniquePlayers: number; totalDuels: number; treasury: string }   // 3 field terakhir 0/'0' sampai Task 15s
  | { type: 'leaderboard'; entries: { address: Hex; label: string | null; wins: number; losses: number; cardId: string }[] }  // top 10, tanpa bot
  | { type: 'agent'; level: number; threshold: number; finisher: boolean;
      sim: { duels: number; wins: number }; testnet: { duels: number; wins: number };
      lessons: { at: number; duelId: string; text: string; thresholdFrom: number; thresholdTo: number }[] }   // terbaru di depan
  | { type: 'taunt'; duelId: string; text: string };
```
Pesan pertama setelah koneksi adalah `duels` + `stats` + `agent` (+ `leaderboard` untuk `scope=all`) sebagai snapshot penuh; `leaderboard` juga di-broadcast setiap kali berubah. `stats.treasury` dalam wei (string); UI menampilkannya dengan `formatEther`, 2 desimal. **Lingkup langganan lewat query:** `/ws?scope=all` (proyektor & admin, semua duel di jendela aktif) atau `/ws?scope=duel:<id>` (HP pemain: hanya duel itu + `agent` + `taunt` duel itu). Tanpa ini, 64 duel × ±450 B × 3,3/dtk ≈ 95 KB/dtk per HP.

**Env server:** `EVENT_NAME` (default "NadGacha BlitzArena"), `EVENT_SPONSOR` (opsional), `FUND_ENABLED` (default `false`; `true` di `.env` dev), `RPC_URLS` (dipisah koma, urutan prioritas; skrip shell memakai URL pertama: `RPC=${RPC_URLS%%,*}`), `FUND_BUDGET_MON` (default 3), `MASTER_KEY`, `OPERATOR_KEY`, `AGENT_KEY`, `ADMIN_TOKEN`, `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`, `DATA_DIR`, `PUBLIC_URL`, `BATCH_MS`, `DEPLOYMENT` (`testnet`|`anvil`).

---

### Task 1: `NadCards.sol` (09:15–09:40)

**Files:**
- Create: `contracts/foundry.toml`, `contracts/src/NadCards.sol`, `contracts/src/interfaces/INadCards.sol`, `contracts/test/NadCards.t.sol`, root `.gitignore`, root `.env.example`

**Interfaces:**
- Produces:
  - `struct Card { uint16 atk; uint16 hp; uint8 element; uint8 rarity; uint16 wins; uint16 losses; uint64 mintedAt; }` (1 slot; `mintedAt` = `block.number` saat mint, ditampilkan di kartu sebagai "Block #…")
  - `function freePull() external returns (uint256 tokenId)` (gratis, 1× per alamat); `function paidPull() external payable returns (uint256 tokenId)` (wajib `msg.value == PULL_PRICE`, boleh berkali-kali, kartu baru jadi kartu aktif: `cardOf[msg.sender] = tokenId`); `uint256 public constant PULL_PRICE = 0.05 ether`; `function withdraw(address payable to) external` (owner, kirim seluruh saldo treasury); royalti ERC-2981 5% ke owner (`_setDefaultRoyalty(owner, 500)`, `supportsInterface` meng-override ERC721 + ERC2981); `function cards(uint256 id) external view returns (Card memory)`; `function cardOf(address) external view returns (uint256)` (0 = belum punya; token ID mulai dari 1) dan `function hasPulled(address a) external view returns (bool)` = `cardOf[a] != 0`
  - `function recordResult(uint256 winId, uint256 loseId) external` (hanya `arena`)
  - `function setArena(address a) external` (owner, sekali); `function setBaseURI(string calldata uri) external` (owner)
  - `event CardMinted(uint256 indexed tokenId, address indexed owner, uint8 rarity, uint8 element, uint16 atk, uint16 hp)`
  - `INadCards` berisi `ownerOf`, `cards`, `cardOf`, `recordResult`

- [ ] **Step 1: Setup proyek**

Run (di root): `git init`, buat kerangka workspace root sesuai "Pembagian Kerja" aturan 3 dan commit `chore: workspace skeleton` (frontend menunggu commit ini), lalu `forge init contracts --no-git && cd contracts && forge install OpenZeppelin/openzeppelin-contracts@v5.1.0 --no-git && rm -f src/Counter.sol test/Counter.t.sol script/Counter.s.sol`
Isi `.gitignore`: `node_modules/`, `dist/`, `data/`, `.env`, `contracts/out/`, `contracts/cache/`, `contracts/broadcast/`. Buat `.env.example` di root berisi semua key dari daftar Env server (nilai kosong).
Tambahkan ke `foundry.toml`: `solc = "0.8.24"`, `remappings = ["@openzeppelin/=lib/openzeppelin-contracts/"]`, `[fuzz] runs = 1000`.
Expected: `forge build` sukses (tanpa kontrak).

- [ ] **Step 2: Tulis test yang gagal di `contracts/test/NadCards.t.sol`**

```solidity
function test_freePull_mintsOncePerAddress() public {
    vm.prank(alice, alice); uint256 id = cards.freePull();
    assertEq(cards.ownerOf(id), alice);
    assertEq(cards.cardOf(alice), id); assertTrue(cards.hasPulled(alice));
    vm.prank(alice, alice); vm.expectRevert(NadCards.AlreadyPulled.selector); cards.freePull();
}
function test_freePull_rejectsContractCaller() public {
    vm.prank(address(this), alice); // msg.sender != tx.origin
    vm.expectRevert(NadCards.OnlyEOA.selector); cards.freePull();
}
function testFuzz_freePull_statsWithinRanges(uint256 rnd, address who) public {
    vm.assume(who != address(0) && who.code.length == 0); assumeNotPrecompile(who); assumeNotForgeAddress(who);
    vm.prevrandao(bytes32(rnd));
    vm.prank(who, who); NadCards.Card memory c = cards.cards(cards.freePull());
    assertLe(c.rarity, 3); assertLe(c.element, 2);
    assertGe(c.atk, 10 + c.rarity); assertLe(c.atk, 14 + c.rarity);
    assertGe(c.hp, 1500 + 100 * uint16(c.rarity)); assertLe(c.hp, 1800 + 100 * uint16(c.rarity));
}
function test_recordResult_onlyArena() public {
    vm.expectRevert(NadCards.OnlyArena.selector); cards.recordResult(1, 2);
}
function test_recordResult_incrementsWinsAndLosses() public { /* mint 2 kartu, prank arena, cek wins=1 & losses=1 */ }
function test_setArena_onlyOnce() public {
    cards.setArena(arena);
    vm.expectRevert(NadCards.ArenaAlreadySet.selector); cards.setArena(address(0xBEEF));
}
function test_paidPull_requiresExactPrice() public {
    vm.deal(alice, 1 ether);
    vm.prank(alice, alice); vm.expectRevert(NadCards.WrongPrice.selector); cards.paidPull{value: 0.01 ether}();
}
function test_paidPull_mintsNewActiveCardAndFillsTreasury() public {
    vm.deal(alice, 1 ether);
    vm.prank(alice, alice); uint256 first = cards.freePull();
    vm.prank(alice, alice); uint256 second = cards.paidPull{value: 0.05 ether}();
    assertEq(cards.cardOf(alice), second); assertEq(cards.ownerOf(first), alice);
    assertEq(address(cards).balance, 0.05 ether);
}
function test_withdraw_onlyOwner() public {
    vm.prank(bob); vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, bob)); cards.withdraw(payable(bob));
    /* owner → seluruh saldo pindah ke `to` (pakai `Address.sendValue`) */
}
function test_royalty_is_5_percent() public {
    (address recv, uint256 amt) = cards.royaltyInfo(1, 1 ether);
    assertEq(recv, address(this)); assertEq(amt, 0.05 ether);
}
```

- [ ] **Step 3: Jalankan, pastikan gagal**

Run: `cd contracts && forge test --match-contract NadCardsTest -vv`
Expected: FAIL (kontrak belum ada).

- [ ] **Step 4: Implementasi `NadCards`**

`ERC721` + `Ownable(msg.sender)` dari OZ v5. Custom error: `AlreadyPulled`, `OnlyEOA`, `OnlyArena`, `ArenaAlreadySet`, `WrongPrice`. Turunan: `ERC721`, `ERC2981`, `Ownable`. `freePull` dan `paidPull` memakai satu fungsi internal `_pull(address to)` yang sama (acak → simpan `Card` → `_mint` → emit) supaya algoritma acak tidak ditulis dua kali; `_pull(address to) internal returns (uint256 tokenId)` menetapkan ID, mengacak, menyimpan `Card`, `_mint`, lalu emit; pemanggil men-set `cardOf[msg.sender] = tokenId` sesudahnya (aman, tidak ada panggilan eksternal). Cek EOA untuk kedua fungsi: `if (msg.sender != tx.origin || msg.sender.code.length != 0) revert OnlyEOA();` (menutup celah EOA yang didelegasikan EIP-7702). `paidPull`: cek EOA → cek harga → `_pull`. Royalti: `_setDefaultRoyalty(msg.sender, 500)` di constructor. `withdraw` memakai `Address.sendValue`. Urutan di `freePull`: cek EOA → cek `cardOf[msg.sender] == 0` (`AlreadyPulled`) → `tokenId = _pull(msg.sender)` → `cardOf[msg.sender] = tokenId`. Di dalam `_pull`: ID berikutnya → acak → simpan `Card` → `_mint` (bukan `_safeMint`) → emit. Token ID mulai dari 1. Pengacakan (algoritma dikunci supaya cocok dengan spec):

```solidity
uint256 r = uint256(keccak256(abi.encodePacked(block.prevrandao, msg.sender, tokenId)));
uint8 roll = uint8(r % 100);
uint8 rarity = roll < 60 ? 0 : roll < 88 ? 1 : roll < 98 ? 2 : 3;
uint16 atk = uint16(10 + ((r >> 8) % 5) + rarity);
uint16 hp  = uint16(1500 + ((r >> 16) % 301) + 100 * uint256(rarity));
uint8 element = uint8((r >> 32) % 3);
```

- [ ] **Step 5: Jalankan, pastikan lulus**

Run: `forge test --match-contract NadCardsTest -vv`
Expected: PASS semua.

- [ ] **Step 6: Commit**

```bash
git add .gitignore contracts && git commit -m "feat(contracts): NadCards ERC-721 with free pull and onchain stats"
```

---

### Task 2: `BlitzArena.sol` (09:40–10:20)

**Files:**
- Create: `contracts/src/BlitzArena.sol`, `contracts/test/BlitzArena.t.sol`

**Interfaces:**
- Consumes: `INadCards` (Task 1).
- Produces:
  - `enum Status { Open, Active, P1Won, P2Won, Draw }` dan `struct Duel` persis seperti spec §4.2 (3 slot, urutan field tidak boleh diubah).
  - `constructor(INadCards cards)`
  - `function createDuel(uint256 cardId) external returns (uint256 id)`
  - `function joinDuel(uint256 id, uint256 cardId) external`
  - `function attack(uint256 id, uint16 taps, bool useSkill) external`
  - `function settle(uint256 id) external`
  - `function getDuels(uint256 from, uint256 count) external view returns (Duel[] memory)` (count dipotong ke panjang array)
  - `function duelCount() external view returns (uint256)`
  - Event: `DuelCreated(uint256 indexed id, address indexed p1, uint256 card1)`, `DuelStarted(uint256 indexed id, address indexed p2, uint32 startBlock)`, `Attacked(uint256 indexed id, address indexed attacker, uint16 taps, uint256 damage, uint16 hpLeft)`, `DuelEnded(uint256 indexed id, Status status)`
  - Custom error: `NotCardOwner`, `NotOpen`, `SelfJoin`, `NotParticipant`, `NotFinished`, `AlreadySettled`
  - `attack()` oleh peserta pada duel yang **sudah selesai** (KO atau sudah di-settle) **return tanpa efek, tidak revert**. Tx yang sedang in-flight saat lawan KO adalah kondisi normal, dan revert di Monad tetap membayar penuh `gasLimit`.

- [ ] **Step 1: Tulis test yang gagal di `contracts/test/BlitzArena.t.sol`**

Helper `setUp`: deploy `NadCards` + `BlitzArena`, `setArena`, `alice` & `bob` masing-masing `freePull` (pakai `vm.prank(x, x)`), lalu helper `_start()` yang membuat dan join duel dan mengembalikan `(id, startBlock)`. Untuk test yang butuh stat tertentu, tulis stat lewat `vm.store` ke slot `Card`, atau pakai kontrak harness `NadCardsHarness` dengan `setCard(id, Card)` khusus test.

```solidity
function test_attack_clampsTapsToBlocksElapsed() public {
    (uint256 id, uint32 s) = _start();
    vm.roll(s + 3); vm.prank(alice); arena.attack(id, 20, false);
    assertEq(_lastAttackTaps(), 9);            // min(20, 3*3, 30)
}
function test_attack_clampsTapsPerTx() public {
    (uint256 id, uint32 s) = _start();
    vm.roll(s + 20); vm.prank(alice); arena.attack(id, 40, false);
    assertEq(_lastAttackTaps(), 30);
}
function test_attack_beforeStart_noEffect() public { /* vm.roll(s - 1); attack; HP tidak berubah, tidak revert */ }
function test_elementMultiplier() public {
    assertEq(arena.elementMult(1, 0), 150);   // Water > Fire
    assertEq(arena.elementMult(0, 1), 75);
    assertEq(arena.elementMult(0, 2), 150);   // Fire > Lightning
    assertEq(arena.elementMult(2, 2), 100);
}
function test_tapDamage() public { /* atk 12, mult 150, 9 tap → HP lawan berkurang 162 */ }
function test_skill_fullHp_and_lowHp() public {
    assertEq(arena.skillDamage(12, 100, 1500, 1500), 120);
    assertEq(arena.skillDamage(12, 100, 150, 1500), 552);
}
function test_skill_onlyOnce() public { /* useSkill dua kali: damage skill hanya terhitung sekali */ }
function test_attack_koEndsDuel() public { /* HP lawan → 0, status P1Won, event DuelEnded */ }
function test_attack_afterEnd_ignoresTapsAndCloses() public {
    (uint256 id, uint32 s) = _start();
    vm.roll(s + 67); vm.prank(alice); arena.attack(id, 30, false);
    // assert: hp2 tetap = maxHp2, status bukan Active, ada event DuelEnded
}
function test_draw_recordsNothing() public { /* seri → settle → wins/losses kedua kartu tetap 0 */ }
function test_settle_recordsOnce() public {
    // KO → settle → wins pemenang = 1; settle lagi → revert AlreadySettled
}
function test_settle_timeoutDecidesByHp() public { /* tanpa attack setelah waktu habis, settle menentukan pemenang dari sisa HP */ }
function test_attack_afterKo_noRevert() public { /* KO oleh alice, lalu bob attack → tidak revert, HP dan status tidak berubah */ }
function test_attack_nonParticipantReverts() public { vm.expectRevert(BlitzArena.NotParticipant.selector); /* ... */ }
function test_join_rejectsSecondJoiner() public {
    (uint256 id,) = _start();
    vm.prank(carol, carol); uint256 c = cards.freePull();
    vm.prank(carol); vm.expectRevert(BlitzArena.NotOpen.selector); arena.joinDuel(id, c);
}
function test_join_rejectsSelfJoin() public { /* p1 join duelnya sendiri → SelfJoin */ }
function testFuzz_attack_neverOverflows(uint16 taps, uint8 blocks, bool skill) public {
    (uint256 id, uint32 s) = _start();
    vm.roll(s + uint32(blocks % 67)); vm.prank(alice); arena.attack(id, taps, skill); // tidak boleh revert
}
```

`elementMult` dan `skillDamage` dibuat `public pure` supaya bisa diuji dan dicerminkan di `shared/`. Helper `_lastAttackTaps()` membaca field `taps` dari event `Attacked` terakhir lewat `vm.recordLogs()` / `vm.getRecordedLogs()`.

- [ ] **Step 2: Jalankan, pastikan gagal**

Run: `forge test --match-contract BlitzArenaTest -vv`
Expected: FAIL.

- [ ] **Step 3: Implementasi `BlitzArena`**

Ikuti 6 langkah `attack()` di spec §4.2 persis. Sisi penyerang ditentukan dari `msg.sender == p1`. `joinDuel` menyalin `atk`, `hp`, `maxHp`, dan `mult` kedua sisi dari `cards.cards(id)`, lalu set `startBlock = block.number + 10` dan `lastBlock1 = lastBlock2 = startBlock`. Penutupan karena waktu habis: HP lebih besar menang, sama → `Draw`. `settle`: tutup dulu kalau `Active` dan waktu habis (`NotFinished` kalau masih berjalan), lalu `AlreadySettled` kalau sudah, lalu set `settled = true` dan panggil `recordResult` kecuali `Draw`. Emit `DuelEnded` di setiap transisi ke status selesai.

- [ ] **Step 4: Jalankan semua test kontrak**

Run: `forge test -vv`
Expected: PASS semua, termasuk fuzz 1000 run.

- [ ] **Step 5: Commit**

```bash
git add contracts && git commit -m "feat(contracts): BlitzArena parallel duels with clamped taps and two-phase settle"
```

---

### Task 3: Deploy + ukur `gasLimit` (10:20–10:45 → checkpoint A)

> ⚠️ **ADDENDUM 24 Okt (menang atas teks task ini, lihat `docs/ADDENDUM-2026-10-24.md`):** verifikasi **wajib**, jalur utama verification API devnads (`POST https://agents.devnads.com/v1/verify`, addendum N1), Sourcify/Etherscan hanya cadangan. Kalimat "kalau verifikasi gagal, lanjut saja" tidak berlaku lagi: ulangi di slot README. `estimate.sh` juga menunggu ≥ 3 blok setelah mengisi wallet uji sebelum tx pertamanya (N9). Jam baru: lihat timeline addendum (A 12:00).

**Files:**
- Create: `contracts/script/Deploy.s.sol`, `deployments/anvil.json`, `deployments/testnet.json`, `contracts/script/estimate.sh`

**Interfaces:**
- Produces: `deployments/<net>.json` = `{"chainId": number, "cards": Hex, "arena": Hex, "deployBlock": number, "gasLimits": {"freePull": number, "paidPull": number, "createDuel": number, "joinDuel": number, "attack": number, "settle": number}}`

- [ ] **Step 1: Tulis `Deploy.s.sol`**

Deploy `NadCards`, deploy `BlitzArena(cards)`, panggil `cards.setArena(arena)`, lalu kalau `vm.envOr("PUBLIC_URL", string(""))` tidak kosong, `cards.setBaseURI(PUBLIC_URL + "/card/")`. (URL tunnel baru ada di Task 10, jadi saat deploy pagi biasanya kosong dan `setBaseURI` dipanggil di Task 10.) Cetak kedua alamat.

- [ ] **Step 2: Deploy ke anvil**

Run: `anvil --chain-id 10143` (terminal terpisah), lalu `forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --broadcast --private-key <anvil key 0>`
Expected: dua alamat tercetak. Tulis ke `deployments/anvil.json` (`chainId` 10143, gasLimits sementara 500000). **Matikan anvil ini setelah selesai** (port 8545 dipakai lagi oleh e2e/train).

- [ ] **Step 3: Deploy ke testnet dan verifikasi**

Run: `set -a; source ../.env; set +a; RPC=${RPC_URLS%%,*}`, lalu `forge script script/Deploy.s.sol --rpc-url $RPC --broadcast --private-key $MASTER_KEY`, lalu untuk tiap kontrak: `forge verify-contract <alamat> <NamaKontrak> --chain 10143 --verifier sourcify --verifier-url https://sourcify-api-monad.blockvision.org/` (tanpa API key; argumen constructor `BlitzArena` lewat `--constructor-args $(cast abi-encode 'c(address)' $CARDS)`). Kalau verifikasi gagal, lanjut saja; jangan blokir task.
Expected: kontrak terlihat di `https://testnet.monadscan.com`.

- [ ] **Step 4: Ukur `gasLimit` di testnet**

`estimate.sh` (membaca `.env` root dan alamat dari `deployments/testnet.json` via `jq`; setiap `cast` memakai `--rpc-url $RPC` dan `--private-key`): kirim 0,05 MON dari master ke 2 wallet uji, lalu jalankan `cast send` untuk `freePull`, `paidPull` (dengan `--value 0.05ether`, **setelah menunggu ≥ 3 blok sejak tx sebelumnya dari wallet yang sama** karena aturan reserve balance; revert di sini justru mengonfirmasi aturan itu), `createDuel`, `joinDuel`, tunggu `startBlock`, lalu `cast estimate` untuk `attack(id, 9, false)`, `attack(id, 30, true)`, dan `attack` yang menghasilkan KO, serta `settle`. Ambil nilai terbesar per fungsi × 1,2 (dibulatkan ke atas ke ribuan) → tulis ke `deployments/testnet.json`. Catat juga gas `attack` apa adanya untuk angka MIP-8 di pitch. (Akses `duels[id]` juga membaca `duels.length`, dan duel 3 slot kadang melintasi batas page 128 slot, jadi yang disebut di pitch hanya angka hasil ukur.)
Expected: semua nilai terisi; `attack` di bawah 100000.

- [ ] **Step 5: Commit**

```bash
git add contracts/script deployments && git commit -m "chore: deploy contracts and record Monad-measured gas limits"
```

---

### Task 4: Paket `shared/` — rumus game (10:45–11:00)

**Files:**
- Modify: root `package.json` (tambah skrip; file sudah dibuat di Task 1)
- Create: `shared/package.json` (nama `@nad/shared`), `shared/src/constants.ts`, `shared/src/game.ts`, `shared/src/duel.ts`, `shared/src/abi.ts`, `shared/src/nadmon.ts`, `shared/test/game.test.ts`, `shared/test/nadmon.test.ts`, `shared/scripts/export-abi.ts`

**Interfaces:**
- Produces (diekspor dari `@nad/shared`):
  - Konstanta: `COUNTDOWN_BLOCKS`, `DUEL_BLOCKS`, `MAX_TAPS_PER_BLOCK`, `MAX_TAPS_PER_TX`, `ELEMENTS = ['Fire','Water','Lightning']`, `RARITIES = ['Common','Rare','Epic','Legendary']`, `RARITY_ODDS = [60, 28, 10, 2]` (persen, cermin aturan rarity `freePull`; ditampilkan di Home)
  - `elementMult(attacker: number, defender: number): 150 | 100 | 75`
  - `allowedTaps(requested: number, blocksElapsed: number): number`
  - `tapDamage(taps: number, atk: number, mult: number): number` (pembulatan ke bawah, sama dengan Solidity)
  - `skillDamage(atk: number, mult: number, hp: number, maxHp: number): number`
  - `type DuelStatus = 'Open'|'Active'|'P1Won'|'P2Won'|'Draw'`
  - `type DuelView = { id: string; p1: Hex; p2: Hex; hp1: number; hp2: number; atk1: number; atk2: number; mult1: number; mult2: number; lastBlock1: number; lastBlock2: number; skill1: boolean; skill2: boolean; status: DuelStatus; startBlock: number; endBlock: number; card1: number; card2: number; maxHp1: number; maxHp2: number; settled: boolean }`
  - `decodeDuels(raw: readonly unknown[], fromId: bigint): DuelView[]`
  - `nadCardsAbi`, `blitzArenaAbi` (`as const`)
  - `type Nadmon = { id: string; name: string; element: 0 | 1 | 2; stage: 1 | 2 | 3; evolvesFrom: string | null }` dan `NADMON: readonly Nadmon[]` (9 entri, persis tabel di `docs/design-system/assets/Nadmon/README.md`; `id` = nama file tanpa `.svg`)
  - `nadmonFor(element: number, rarity: number): Nadmon` — tahap = 1 untuk rarity 0–1, 2 untuk rarity 2, 3 untuk rarity 3
  - `strongAgainst(element: number): number` dan `weakTo(element: number): number` — dari aturan `(d+1)%3 == a`

- [ ] **Step 1: Tulis test yang gagal (vektor sama dengan Task 2)**

```ts
test('element multiplier follows (d+1)%3==a', () => {
  expect(elementMult(1, 0)).toBe(150); expect(elementMult(0, 1)).toBe(75);
  expect(elementMult(0, 2)).toBe(150); expect(elementMult(2, 2)).toBe(100);
});
test('allowed taps clamps by blocks and per-tx cap', () => {
  expect(allowedTaps(20, 3)).toBe(9); expect(allowedTaps(40, 20)).toBe(30); expect(allowedTaps(5, 0)).toBe(0);
});
test('tap damage', () => { expect(tapDamage(9, 12, 150)).toBe(162); });
test('skill damage at full and 10% hp', () => {
  expect(skillDamage(12, 100, 1500, 1500)).toBe(120); expect(skillDamage(12, 100, 150, 1500)).toBe(552);
});
test('decodeDuels computes endBlock and status names', () => { /* satu tuple mentah → endBlock = startBlock + 67, status 'Active' */ });
test('nadmonFor maps rarity to stage', () => {
  expect(nadmonFor(2, 0).id).toBe('sparkit'); expect(nadmonFor(2, 1).id).toBe('sparkit');
  expect(nadmonFor(2, 2).id).toBe('voltnad'); expect(nadmonFor(1, 3).id).toBe('abyssnad');
});
test('advantage helpers', () => { expect(strongAgainst(2)).toBe(1); expect(weakTo(2)).toBe(0); expect(strongAgainst(0)).toBe(2); });
```

- [ ] **Step 2: Jalankan, pastikan gagal**

Run: `pnpm -F @nad/shared test`
Expected: FAIL.

- [ ] **Step 3: Implementasi + `export-abi.ts`** (dijalankan dengan `pnpm -F @nad/shared export-abi`, setelah `forge build`)

`export-abi.ts` membaca `contracts/out/{NadCards,BlitzArena}.sol/*.json` lalu menulis `shared/src/abi.ts` berisi `export const ... = [...] as const`, dan `shared/src/bytecode.ts` berisi `nadCardsBytecode` + `blitzArenaBytecode` (hanya diimpor skrip server untuk deploy ke anvil, tidak ikut ke bundle web).

- [ ] **Step 4: Jalankan, pastikan lulus**

Run: `pnpm -F @nad/shared test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-workspace.yaml tsconfig.base.json shared && git commit -m "feat(shared): game formulas mirroring contracts"
```

---

### Task 5: Server inti — env, chain, antrean wallet, `/config` (11:00–11:20)

> ⚠️ **ADDENDUM 24 Okt (menang atas teks task ini, lihat `docs/ADDENDUM-2026-10-24.md`):** tambahkan env opsional `PORT` (default 8080) ke `env.ts` dan `.env.example`, ditambah `ETHERSCAN_API_KEY`, `MAINNET_RPC_URL`, `MAINNET_DEPLOYER_KEY` (hanya untuk skrip, server tidak memakainya). Di VPS `PORT=8090`.

**Files:**
- Create: `server/package.json`, `server/src/env.ts`, `server/src/chain.ts`, `server/src/walletQueue.ts`, `server/src/account.ts`, `server/src/app.ts`, `server/src/main.ts`, `server/test/walletQueue.test.ts`

**Interfaces:**
- Consumes: `@nad/shared` (Task 4), `deployments/<DEPLOYMENT>.json` (Task 3).
- Produces:
  - `env` (objek hasil zod, key sesuai daftar env di atas; `BATCH_MS` default 1000)
  - `createChain(rpcUrls: string[]): { client: PublicClient; call<T>(fn: (c: PublicClient) => Promise<T>): Promise<T> }` — `call` mencoba URL berikutnya saat error jaringan/429
  - `createWalletQueue(account: Account, chain): { address: Hex; send(req: { to: Hex; data: Hex; gas: bigint; value?: bigint }): Promise<Hex>; resyncNonce(): Promise<void> }` — nonce lokal **hanya naik setelah `sendRawTransaction` berhasil**; setelah error apa pun, nonce disinkronkan ulang dari chain. **Reserve balance Monad:** tx bernilai (`value > 0`) dari wallet bersaldo di bawah 10 MON hanya lolos kalau itu tx pertama wallet tersebut dalam 3 blok terakhir, jadi antrean menunggu sampai ≥ 3 blok sejak tx sebelumnya sebelum mengirim tx bernilai (berlaku untuk `/fund` dan `setup-bots`)
  - `getGasPrice(): bigint` (cache, diperbarui tiap 10 dtk)
  - `buildApp(deps): Hono` dengan `GET /config` (`pullPrice` dibaca dari `NadCards.PULL_PRICE()` sekali saat start; `event` dari env) dan `GET /account/:address` → `{nonce, balance, cardId, hasPulled}` (cache 1 dtk per alamat; `cardId` null kalau `cardOf` = 0 **atau** `ownerOf(cardOf) != address` karena kartu sudah dipindahkan/dijual; `hasPulled` dari kontrak, supaya UI tahu tarikan gratis sudah terpakai)

- [ ] **Step 1: Tulis test yang gagal**

```ts
test('wallet queue sends sequentially with increasing nonces', async () => {
  const sent: number[] = []; const q = createWalletQueue(fakeAccount, fakeChain({ onSend: n => sent.push(n), startNonce: 7 }));
  await Promise.all([q.send(tx), q.send(tx), q.send(tx)]);
  expect(sent).toEqual([7, 8, 9]);
});
test('wallet queue resyncs nonce after nonce error', async () => { /* send pertama error "nonce too low" → resync → send ulang dengan nonce dari chain */ });
test('failed send does not leave a nonce gap', async () => { /* send kedua error "insufficient funds" → send ketiga memakai nonce yang sama dengan send kedua */ });
test('GET /config returns contracts, gas limits, gasPrice string, batchMs', async () => {
  const res = await buildApp(deps).request('/config');
  expect(await res.json()).toMatchObject({ chainId: 10143, batchMs: 1000, gasLimits: { attack: expect.any(Number) } });
});
```

- [ ] **Step 2: Jalankan, pastikan gagal** — Run: `pnpm -F server test` → FAIL.

- [ ] **Step 3: Implementasi**

Antrean memakai rantai promise per wallet; nonce lokal diinisialisasi dari `getTransactionCount(address, 'pending')`. `main.ts` menyalakan Hono via `@hono/node-server` di `PORT` (default 8080) dan menyajikan `web/dist` sebagai statis (fallback ke `index.html` untuk rute SPA).

- [ ] **Step 4: Jalankan, pastikan lulus** — Run: `pnpm -F server test` → PASS.

- [ ] **Step 5: Commit**

```bash
git add server && git commit -m "feat(server): env, RPC failover, per-wallet tx queue, /config, /account"
```

---

### Task 6: Relay + receipt hub + block watcher (11:20–11:45)

**Files:**
- Create: `server/src/relay.ts`, `server/src/receiptHub.ts`, `server/src/blockWatcher.ts`, `server/src/stats.ts`, `server/test/relay.test.ts`, `server/test/receiptHub.test.ts`

**Interfaces:**
- Consumes: `createChain`, `deployments` gasLimits.
- Produces:
  - `validateRawTx(raw: Hex, cfg: { chainId: number; cards: Hex; arena: Hex; gasLimits: Record<string, number>; pullPrice: bigint }): { ok: true; hash: Hex; fn: string } | { ok: false; reason: 'chain'|'to'|'selector'|'value'|'gas'|'decode' }`
  - `createReceiptHub(): { wait(hash: Hex, timeoutMs: number): Promise<TxReceipt>; ingest(blockNumber: bigint, receipts: TxReceipt[]): void; onIngest(cb: (block: bigint, receipts: TxReceipt[]) => void): void }` — menyimpan receipt ±200 blok terakhir (LRU), sehingga `wait` untuk hash yang **sudah** di-ingest langsung selesai
  - `startBlockWatcher(chain, hub, opts: { pollMs: 150 }): { latestBlock(): bigint }` — untuk setiap blok baru (termasuk blok yang terlewat) memanggil `eth_getBlockReceipts`, lalu `hub.ingest`
  - `stats`: `recordAttack(count)`, `recordLatency(ms)`, `snapshot(): { txTotal, txPerSec, avgLatencyMs }` (tx/dtk dari jendela 5 dtk). Diberi makan dari `hub.onIngest` dengan menghitung log `Attacked`.
  - Route `POST /relay` dengan batas 3 tx/dtk per alamat pengirim dan 30 tx/dtk per IP (`429 {reason: 'rate'}`), serta tolak lebih awal (`400 {reason: 'balance'}`) kalau saldo pengirim (dari cache `/account`) di bawah `gas × maxFeePerGas + value`; hanya tx tipe 2 (EIP-1559) yang diterima

- [ ] **Step 1: Tulis test yang gagal**

```ts
test('accepts a signed attack tx to arena', async () => { expect(validateRawTx(await sign({ to: arena, data: attackData, gas: 70000n }), cfg)).toMatchObject({ ok: true, fn: 'attack' }); });
test('rejects wrong chain id', ...);           // reason 'chain'
test('rejects unknown contract', ...);         // reason 'to'
test('rejects transfer selector on cards', ...); // reason 'selector' (transferFrom)
test('rejects non-zero value', ...);           // reason 'value'
test('accepts paidPull only with value == pullPrice', ...); // value lain → reason 'value'
test('rejects gas above limit', ...);          // reason 'gas'
test('receipt hub resolves waiter when receipt ingested', async () => {
  const p = hub.wait(h, 5000); hub.ingest(100n, [receipt(h)]); expect((await p).transactionHash).toBe(h);
});
test('receipt hub rejects waiter after timeout', ...);
test('waiter registered after ingest resolves', async () => { hub.ingest(100n, [receipt(h)]); expect((await hub.wait(h, 100)).transactionHash).toBe(h); });
test('relay response includes decoded tokenId and duelId', ...);
test('treats already-known as pending', async () => {
  // RPC melempar "already known" → handler /relay tidak mengembalikan error, tetap menunggu hash dan sukses saat receipt di-ingest
});
```

- [ ] **Step 2: Jalankan, pastikan gagal** — Run: `pnpm -F server test relay receiptHub` → FAIL.

- [ ] **Step 3: Implementasi**

`validateRawTx` memakai `parseTransaction` + `keccak256(raw)` dari viem; selector dicek dengan `decodeFunctionData` terhadap ABI. `/relay`: validasi → **daftarkan `hub.wait(hash, 5000)` lebih dulu** → `sendRawTransaction` (error `already known` / `nonce too low` → panggil `eth_getTransactionReceipt` sekali; kalau ada, selesai, kalau tidak, tetap menunggu) → `{hash, status, latencyMs, blockNumber, events}`. `latencyMs` = waktu dari request masuk sampai receipt di-ingest.

- [ ] **Step 4: Jalankan, pastikan lulus** — PASS.

- [ ] **Step 5: Commit**

```bash
git add server && git commit -m "feat(server): validated relay with block-receipt watcher"
```

---

### Task 7: `/fund` dengan pembatas (11:45–12:00)

> ⚠️ **ADDENDUM 24 Okt (menang atas teks task ini, lihat `docs/ADDENDUM-2026-10-24.md`):** N9: respons `/fund` tetap `{funded, txHash}` (kontrak tidak berubah); client yang menunggu ≥ 3 blok setelah receipt pengisian sebelum tx pertama burner.

**Files:**
- Create: `server/src/fund.ts`, `server/test/fund.test.ts`, `server/scripts/fund.ts` (CLI `pnpm -F server fund <alamat>`: kirim 0,3 MON dari master; dipakai kalau `/fund` dipotong menurut spec §11)

**Interfaces:**
- Consumes: `createWalletQueue` (wallet master).
- Produces:
  - `createFundLimiter(cfg: { amountWei: bigint; thresholdWei: bigint; maxPerAddress: 3; maxPerIpPer10Min: 10; budgetWei: bigint; ledgerPath: string }): { reserve(input: { address: Hex; ip: string; balanceWei: bigint; now: number }): { fund: true; release(): void } | { fund: false; reason: 'limit_address'|'limit_ip'|'budget'|'balance_ok' }; spentWei(): bigint }` — `reserve` mencatat jatah **secara sinkron** (request paralel untuk alamat yang sama tidak bisa lolos bersamaan); `release()` dipanggil kalau transfer gagal; ledger disimpan ke `data/fund.json` supaya tidak reset saat server restart
  - `setFundEnabled(v: boolean)` (dipakai admin; nilai awal dari env `FUND_ENABLED`, default `false` — `.env` dev memakai `true`; saat pitch dinyalakan lewat `admin.sh fund on` hanya saat dibutuhkan), route `POST /fund` (alasan `disabled` saat dimatikan)
  - Nilai: amount 0,3 MON, threshold 0,1 MON, budget `FUND_BUDGET_MON` (default 3)

- [ ] **Step 1: Tulis test yang gagal**

```ts
test('funds a fresh address', () => expect(l.decide({ address: a, ip, balanceWei: 0n, now })).toEqual({ fund: true }));
test('skips when balance above threshold', ...);      // balance 0.2 MON → 'balance_ok'
test('stops after 3 fundings per address', ...);      // 'limit_address'
test('limits 10 per ip per 10 minutes, resets after window', ...);
test('stops when budget exhausted', ...);             // budget 3 MON → setelah 10× 0.3 → 'budget'
test('parallel reservations for one address respect the cap', ...); // 5 reserve() bersamaan → hanya 1 yang fund (saldo dianggap 0 sampai transfer selesai)
test('ledger survives restart', ...);                 // limiter baru dari ledgerPath yang sama melanjutkan hitungan
```

- [ ] **Step 2: Jalankan, pastikan gagal** — FAIL.
- [ ] **Step 3: Implementasi** — route membaca IP dari header `cf-connecting-ip` (Cloudflare Tunnel) dengan fallback ke alamat socket; transfer lewat antrean master lalu menunggu receipt via `hub.wait` sebelum menjawab.
- [ ] **Step 4: Jalankan, pastikan lulus** — PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(server): rate-limited burner funding"`

---

### Task 8: Poller, settle otomatis, WebSocket (12:00–12:20)

**Files:**
- Create: `server/src/poller.ts`, `server/src/ws.ts`, `server/test/poller.test.ts`

**Interfaces:**
- Consumes: `decodeDuels`, `DuelView`, `createWalletQueue` (wallet operator), `stats`, block watcher.
- Produces:
  - `selectSettleable(duels: DuelView[], block: number): string[]` — id duel yang `!settled` dan (status selesai, atau `Active` dengan `block >= endBlock`)
  - `activeWindow(duelCount: bigint, size = 64): { from: bigint; count: bigint }`
  - `createWsHub(server): { broadcast(msg: WsMessage): void; onConnect(cb: (send: (m: WsMessage) => void, scope: 'all' | { duelId: string }) => void): void }` — pesan `duels` difilter per lingkup koneksi (lihat Pesan WebSocket)
  - `startPoller(deps)` — dipicu setiap blok baru dari block watcher; `duelCount` lokal dinaikkan dari log `DuelCreated` di `hub.onIngest` (dibaca dari chain sekali saat startup); membaca `getDuels(window)`, broadcast `duels` (dengan `block` dan `featuredId`) dan `stats`, lalu mengirim `settle(id)` untuk hasil `selectSettleable` (dedup: satu id hanya dikirim sekali sampai terlihat `settled`)
  - `setFeatured(id: string | null)`

- [ ] **Step 1: Tulis test yang gagal**

```ts
test('selects finished unsettled duels', ...);
test('selects active duels past endBlock (covers server restart mid-duel)', () => {
  expect(selectSettleable([duel({ status: 'Active', startBlock: 100, settled: false })], 167)).toEqual(['0']);
});
test('ignores active duels still running and already-settled duels', ...);
test('activeWindow covers last 64 duels', () => expect(activeWindow(100n)).toEqual({ from: 36n, count: 64n }));
test('duel-scoped connection only receives its duel', ...);
```

- [ ] **Step 2: Jalankan, pastikan gagal** — FAIL.
- [ ] **Step 3: Implementasi** — `ws` dipasang di path `/ws` pada server HTTP yang sama; saat ada koneksi baru, langsung kirim snapshot `duels` + `stats` + `agent`.
- [ ] **Step 4: Jalankan, pastikan lulus** — PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(server): duel poller with auto-settle and websocket broadcast"`

---

### Task 9: Metadata kartu, SVG kartu TCG, lore template (12:20–12:45; lore AI asli di Task 16 bonus)

> ⚠️ **ADDENDUM 24 Okt (menang atas teks task ini, lihat `docs/ADDENDUM-2026-10-24.md`):** Task 16 dipotong, jadi lore template ini adalah versi final.

**Files:**
- Create: `server/src/cards/store.ts`, `server/src/cards/lore.ts`, `server/src/cards/svg.ts`, `server/src/cards/routes.ts`, `server/src/llm.ts`, `server/test/cards.test.ts`

**Interfaces:**
- Consumes: `receiptHub.onIngest` (event `CardMinted`), `NadCards.cards(id)`.
- Produces:
  - `type CardData = { id: number; atk: number; hp: number; element: number; rarity: number; wins: number; losses: number; mintedAt: number }`
  - Metadata `/card/:id` **selalu** berisi `nadgacha: { ...CardData, nadmon: { id, name, stage }, title, lore, status: 'ready' | 'forging' }` (stat ada walaupun lore belum siap), plus `name`, `description`, `image`, `attributes` standar ERC-721
  - `resolveTokenHex(tokens, name, theme = 'light'): string` — me-resolve alias `{nama}` sampai ke hex
  - `wrapText(text: string, maxChars: number, maxLines: number): string[]` — patah di spasi, baris terakhir diberi elipsis kalau terpotong
  - `escapeXml(s: string): string`
  - `type Lore = { name: string; title: string; lore: string; source: 'ai' | 'template' }` — `name` **selalu** nama Nadmon dari `nadmonFor(element, rarity)`; AI hanya menulis `title` (gelar) dan `lore`
  - `fallbackLore(card: CardData): Lore` — `name` dari `nadmonFor`, `title` dan `lore` (bahasa Inggris) dipilih deterministik dari `id` (pool minimal 4 gelar + 4 lore per elemen)
  - `forgeLore(card: CardData, llm: Llm | null, timeoutMs = 4000): Promise<Lore>` — `llm` null → template
  - `createLlm(cfg): Llm` dengan `json<T>(system: string, user: string, schema: ZodType<T>, timeoutMs: number): Promise<T>` (melempar error saat timeout atau JSON tidak valid)
  - `cardSvg(card: CardData, lore: Lore): string`
  - `createCardStore(dataDir): { get(id): Lore | undefined; set(id, lore): void }` (persist ke `cards.json`)
  - Route `GET /card/:id{[0-9]+}` dan `GET /card/:id{[0-9]+}/image.svg`; mint terdeteksi → `forgeLore` → `store.set` (stat selalu dibaca dari chain, bukan dari event saja). Kalau lore belum ada saat GET dan `ownerOf` berhasil (mis. mint terjadi saat server mati), buat `fallbackLore` saat itu juga. Token yang tidak ada → `404` dan di-cache negatif 10 dtk

- [ ] **Step 1: Tulis test yang gagal**

```ts
test('template lore is deterministic per card', () => expect(fallbackLore(c)).toEqual(fallbackLore(c)));
test('falls back on invalid JSON', async () => {
  const lore = await forgeLore(c, fakeLlm({ throws: new Error('invalid json') })); expect(lore.source).toBe('template');
});
test('falls back on timeout', ...);  // fakeLlm lambat 5 dtk, timeout 4000 → template
test('GET /card/:id returns forging while AI lore is in progress', async () => { /* forge sedang berjalan → { status: 'forging' } */ });
test('GET /card/:id creates template lore lazily for mints missed while server was down', ...);
test('GET /card/:id returns 404 for nonexistent token', ...);
test('svg route /card/5/image.svg returns svg and /card/5 returns metadata', ...);
test('metadata includes nadgacha stats, nadmon, title, lore and status even while forging', ...);
test('resolveTokenHex resolves rarity aliases to hex', () => { expect(resolveTokenHex(tokens, 'rarity-epic')).toBe('#200052'); expect(resolveTokenHex(tokens, 'focus')).toMatch(/^#[0-9a-f]{6}$/); });
test('wrapText wraps lore to at most 4 lines with ellipsis', ...);
test('card svg is valid XML with nested nadmon and escaped text', ...); // lore berisi & dan < tetap valid; tidak ada atribut width ganda
test('svg uses element color and rarity frame', ...);
```

- [ ] **Step 2: Jalankan, pastikan gagal** — FAIL.
- [ ] **Step 3: Implementasi** — SVG kartu **300 × 560** persis tabel layout di `docs/design-system/components/GameCard/README.md` (bagian "Full"): warna dari `resolveTokenHex` tema light, lore dipatah dengan `wrapText(lore, 44, 4)`, semua teks lewat `escapeXml`, font-family memakai tanda kutip tunggal. Nadmon disisipkan dengan aturan di README itu: isi file **tanpa** tag akarnya, dibungkus `<svg x="12" y="88" width="276" height="172" viewBox="0 0 240 150">`. Saat `status: 'forging'`, kotak flavor berisi "Forging lore…". Semua teks kartu dalam bahasa Inggris persis seperti README `GameCard`. Di task ini `forgeLore` dipanggil dengan `llm = null`.
- [ ] **Step 4: Jalankan, pastikan lulus** — PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(server): card metadata, procedural svg, template lore"`

---

### Task 10: Harness e2e di anvil + setup bot + tunnel publik (12:45–13:10 → checkpoint B)

> ⚠️ **ADDENDUM 24 Okt (menang atas teks task ini, lihat `docs/ADDENDUM-2026-10-24.md`):** Step 5 (tunnel) **diganti** deploy ke VPS (addendum N5): tulis `server/scripts/deploy-vps.sh`, jalankan server di VPS dengan pm2 bernama `nadgacha` dan `PORT=8090`, `PUBLIC_URL=https://nadgacha.43-134-58-217.sslip.io`, lalu `setBaseURI`. `cloudflared` tidak dipakai. `setup-bots` menunggu ≥ 3 blok setelah top-up sebelum `freePull` (N9). Tulis juga kerangka README. Checkpoint B 14:25.

**Files:**
- Create: `server/scripts/e2e.ts`, `server/scripts/setup-bots.ts`, `server/src/sim/duelLoop.ts`, `server/src/sim/types.ts`, `server/scripts/serve.sh`, `server/scripts/anvil.ts`

**Interfaces:**
- Consumes: Task 3–9.
- Produces:
  - `type SideState = { myHp: number; myMaxHp: number; oppHp: number; atk: number; mult: number; skillUsed: boolean; block: number; endBlock: number; lastBlock: number }`
  - `type DuelSummary = { duelId: string; mode: 'sim' | 'testnet'; opponent: Hex; myElement: number; oppElement: number; result: 'win' | 'loss' | 'draw'; skillUsedAtHpPct: number | null; followedPolicy: boolean; hpTimeline: { block: number; myHp: number; oppHp: number }[] }`
  - `runSide(opts: { send: (data: Hex) => Promise<TxReceipt>; duelId: bigint; side: 1 | 2; state: () => Promise<SideState | null>; tapsPerSec: () => number; batchBlocks: number; useSkill: (s: SideState) => boolean; onBlock?: (s: SideState) => void }): Promise<{ status: DuelStatus; summary: Omit<DuelSummary, 'mode' | 'opponent' | 'followedPolicy'> }>` — menjalankan **satu sisi** duel yang sudah ada, berbasis blok: taps = `allowedTaps(round(rate × (block − lastBlock) × 0.3), block − lastBlock)`; kirim tiap `batchBlocks` blok. Di testnet, `state()` membaca cache poller (tanpa RPC tambahan); di anvil, `state()` membaca kontrak langsung
  - `runDuelPair(opts)` = `createDuel` + `joinDuel` + dua `runSide` paralel. Dipakai `e2e`, `train` (Task 14), dan `swarm` (Task 15). AI Agent (Task 13) memakai `runSide` saja
  - `startAnvil(port = 8546): Promise<{ rpcUrl: string; mine(blocks: number): Promise<void>; stop(): void }>` — menjalankan `anvil --chain-id 10143 --no-mining --port <port>` sebagai child process dan menunggu port siap sebelum resolve (port 8546 supaya tidak bentrok dengan anvil manual)
  - `setup-bots.ts --pairs N --topup <MON>`: membuat atau memuat `DATA_DIR/bots.json` (`{ privateKey, address, cardId }[]`, 2N entri), **mengisi saldo tiap bot sampai 0,15 MON** (hanya selisihnya), lalu `freePull` untuk bot yang belum punya kartu. Juga mengisi wallet agent sampai 1 MON (+ `freePull` kalau belum) dan wallet operator sampai 0,5 MON. Dijalankan ulang sebelum gladi dan sebelum demo. `setup-bots.ts --sweep` mengembalikan sisa saldo semua bot ke master
  - `serve.sh` (dari root): build `shared` → `web` → `server`, **gagal dengan pesan jelas kalau `web/dist/index.html` tidak ada** (`pnpm -F` diam saja kalau paket belum ada), lalu jalankan `node server/dist/main.js` dalam loop restart (`until node server/dist/main.js; do sleep 1; done`) yang dibungkus `caffeinate -dis`

- [ ] **Step 1: Tulis `e2e.ts` sebagai test**

Skrip melempar error (exit 1) kalau ada asersi gagal: `startAnvil()`, deploy ke anvil **lewat viem** memakai `shared/src/bytecode.ts` (bukan `forge script`, karena `forge script --broadcast` menunggu receipt dan akan menggantung saat automine mati), panggil `anvil_mine(1)` setelah setiap tx setup, 2 burner, `freePull` ×2, `createDuel` + `joinDuel`, `runDuelPair` sampai selesai, `settle`, lalu cek `wins + losses` kedua kartu = 1 (atau 0 kalau `Draw`).

- [ ] **Step 2: Jalankan, pastikan gagal** — Run: `pnpm -F server e2e` → FAIL (`runDuelPair` belum ada).
- [ ] **Step 3: Implementasi `duelLoop.ts` dan `setup-bots.ts`**
- [ ] **Step 4: Jalankan e2e** — Run: `pnpm -F server e2e` (skrip menyalakan dan mematikan anvil sendiri) → output `E2E OK status=P1Won|P2Won|Draw`.
- [ ] **Step 5: Buka tunnel publik**

Run: matikan server dev (beri tahu user lebih dulu, karena frontend sedang memakainya), lalu `bash server/scripts/serve.sh` (Task 10 belum punya web, jadi sementara jalankan dengan `SKIP_WEB=1`), lalu di terminal lain `cloudflared tunnel --url http://localhost:8080`. Catat URL `https://<acak>.trycloudflare.com` sebagai `PUBLIC_URL` di `.env`, panggil `cast send $(jq -r .cards deployments/testnet.json) 'setBaseURI(string)' "$PUBLIC_URL/card/" --rpc-url $RPC --private-key $MASTER_KEY`, restart server, lalu `curl $PUBLIC_URL/config` dari jaringan lain (HP pakai data seluler).
Expected: JSON `/config` dengan `chainId: 10143`. Mulai sekarang **jangan matikan `cloudflared`** supaya URL tidak berubah.

- [ ] **Step 6: Jalankan `setup-bots` di testnet** — Run: `pnpm -F server setup-bots --pairs 3 --topup 0.1` (cukup untuk uji; profil demo diisi di Task 17) → bot + agent punya kartu (`cardOf != 0`) dan `cardId` tersimpan di `bots.json`.
- [ ] **Step 7: Commit** — `git commit -m "feat: anvil e2e harness, bot setup, public tunnel"`

---

### Task 11 · Frontend: setup web, komponen, burner + mesin tx (11a 09:40–10:20 · 11b 10:20–11:00 · 11c 11:00–11:45)

> ⚠️ **ADDENDUM 24 Okt (menang atas teks task ini, lihat `docs/ADDENDUM-2026-10-24.md`):** jam baru mengikuti timeline addendum (mulai setelah commit skeleton, ±10:40).

**Files:**
- Create: `web/package.json`, `web/vite.config.ts`, `web/tailwind.config.cjs`, `web/postcss.config.cjs`, `web/index.html`, `web/src/styles/tokens.css`, `web/src/lib/burner.ts`, `web/src/lib/api.ts`, `web/src/lib/txEngine.ts`, `web/test/txEngine.test.ts`
- **11a (setup):** `web/package.json` bernama `@nad/web` dengan dependency `"@nad/shared": "workspace:*"`; `vite.config.ts` dengan proxy aturan 4 "Pembagian Kerja"; `web/src/main.tsx` + `web/src/App.tsx` (router kosong).
- **11b (komponen, dipindah dari Task 12):** `web/src/components/{GameCard,HpBar,TapButton,SkillButton,LatencyBadge}.tsx` sesuai `docs/design-system/components/<Comp>/README.md`, plus rute `/dev` yang menampilkan semua komponen dalam beberapa state (acuan visual untuk reviewer).
- **11c (data):** `web/src/lib/{burner,api,txEngine}.ts` dan `web/src/mock/{api.ts,socket.ts}`: mock mengembalikan bentuk respons persis seperti tabel HTTP API dan memancarkan pesan `WsMessage` (duel berjalan, HP turun, duel selesai), aktif dengan `VITE_USE_MOCK=1`.
- Setup design system: salin `docs/design-system/tokens.css` ke `web/src/styles/tokens.css` dan impor di `main.tsx`; salin `docs/design-system/assets/Nadmon/*.svg` ke `web/public/nadmon/` (dipakai `GameCard` lewat `/nadmon/<id>.svg`); `tailwind.config.cjs` (CommonJS, supaya `require` jalan walaupun paket web bertipe ESM) memakai `theme: { extend: require('../docs/design-system/tailwind.theme.cjs') }`; `index.html` memuat Google Fonts `Schibsted Grotesk` (400;600;700;800) dan `JetBrains Mono` (500;600) dan set `<html data-theme="light">`

**Interfaces:**
- Consumes: `/config`, `/fund`, `/relay`, `allowedTaps`, `tapDamage`, `skillDamage`.
- Produces:
  - `loadOrCreateBurner(): PrivateKeyAccount` (key `nad.burner` di `localStorage`)
  - `api`: `getConfig()`, `getAccount(address)` → `{nonce, balance, cardId}`, `fund(address)`, `relay(rawTx, timeoutMs = 5000)`, `getCard(id)` (metadata dengan `nadgacha`), `challengeAgent(duelId)`
  - `web/tailwind.config.cjs` persis: `module.exports = { content: ['./index.html', './src/**/*.{ts,tsx}'], theme: { extend: require('../docs/design-system/tailwind.theme.cjs') } }`. Radius: `rounded-chip`, `rounded-card`, `rounded-tap`
  - `createTxEngine(deps: { account; config; relay; getNonce: () => Promise<number>; now: () => number }): TxEngine` (`getNonce` memanggil `GET /account/:address`)
  - `TxEngine`: `start(duel: { id: bigint; startBlock: number; endBlock: number; side: 1 | 2; lastBlock: number })` (`lastBlock` dari `DuelView.lastBlock1/2`, supaya benar setelah reload), `tap(): void`, `requestSkill(): void`, `onBlock(block: number): void`, `pendingDamageEstimate(atk: number, mult: number, hp: number, maxHp: number): number`, `on('sent'|'confirmed'|'error', cb)`, `stats(): { txCount: number; damageSent: number; avgLatencyMs: number; lastTxHash: Hex | null }` (ringkasan duel untuk layar Result), `stop()`
  - Aturan: buffer dicerminkan dengan `allowedTaps(buffer, blokSekarang − lastBlock)`, dengan `lastBlock` = `blockNumber` receipt tx terakhir (basis yang sama dengan kontrak, bukan waktu kirim); 1 in-flight; `batchMs`; flush di blok `endBlock − 3`; **pada blok ≥ `endBlock − 2` tidak mengirim lagi**; timeout → kirim ulang **raw tx yang sama**; error nonce → `getNonce()` lalu coba 1×

- [ ] **Step 1: Tulis test yang gagal (jam & blok palsu)**

```ts
test('sends at most one tx in flight', ...);
test('waits batchMs between txs', ...);
test('mirrors contract tap cap per elapsed blocks', () => { /* 20 tap, 3 blok sejak blockNumber receipt terakhir → tx berisi 9 tap */ });
test('flushes remaining buffer at endBlock-3 ignoring batchMs', ...);
test('stops sending at endBlock-2', ...);
test('resends identical raw tx on timeout', async () => { /* relay timeout → panggilan relay kedua menerima rawTx byte-identik */ });
test('resyncs nonce once on nonce error', ...);
test('resumes from chain nonce after reload', async () => { /* engine baru dengan getNonce()=12 → tx pertama memakai nonce 12 */ });
test('ignores taps before startBlock', ...);
test('stats sums confirmed txs, damage and average latency', ...);
```

- [ ] **Step 2: Jalankan, pastikan gagal** — Run: `pnpm -F web test` → FAIL.
- [ ] **Step 3: Implementasi** — tanda tangan lokal dengan `account.signTransaction` (EIP-1559, `maxFeePerGas = 2 × gasPrice`, `maxPriorityFeePerGas = 2 gwei`, `gas = config.gasLimits.attack`, `chainId 10143`).
- [ ] **Step 4: Jalankan, pastikan lulus** — PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(web): burner wallet and one-in-flight tx engine"`

---

### Task 12 · Frontend: layar pemain Home, Pull, Play, Duel (12a 11:45–12:20 mock · 12b 12:20–12:45 · 12c 12:45–13:10 server lokal · 12d 13:20–13:45 testnet → 🚩 checkpoint C)

> ⚠️ **ADDENDUM 24 Okt (menang atas teks task ini, lihat `docs/ADDENDUM-2026-10-24.md`):** (1) Uji 2 HP di checkpoint C memakai `https://nadgacha.43-134-58-217.sslip.io` (web di-build di laptop, lalu di-rsync backend lewat `deploy-vps.sh`), bukan tunnel. (2) N9: setelah receipt `/fund`, tunggu ≥ 3 blok sebelum `freePull`/`createDuel`/`joinDuel`. (3) N2: badge latency/HUD menautkan `lastTxHash` ke MonadScan. (4) Panel leaderboard disembunyikan kalau pesan `leaderboard` tidak pernah datang. 🚩 C 14:45.

**Files:**
- Create: `web/src/lib/useArenaSocket.ts`, `web/src/lib/errors.ts`, `web/src/routes/{Home,Pull,Play,Duel}.tsx`, `web/test/errors.test.ts` (komponen sudah dibuat di Task 11b; `main.tsx`/`App.tsx` di 11a)

**Interfaces:**
- Consumes: Task 11, pesan WebSocket, `GET /card/:id`.
- Produces:
  - `useArenaSocket(scope: 'all' | { duelId: string }): { duels: Map<string, DuelView>; featuredId: string | null; stats; agent; leaderboard; taunts: Map<string, string>; block: number; connected: boolean }` (reconnect dengan backoff 0,5 → 1 → 2 → 4 dtk, maks 8 dtk)
  - `friendlyError(e: { kind: 'reverted'; fn: string; duelStatus?: DuelStatus } | { kind: 'relay'; reason: string } | { kind: 'network' } | { kind: 'agent'; reason: 'busy'|'reserved'|'not_open'|'stale'|'limit_ip' }): string` — receipt tidak membawa alasan revert, jadi pesan disimpulkan dari konteks: `joinDuel` revert + `duelStatus !== 'Open'` → "This duel already started. Create a new one."; `paidPull` revert → "The pull didn't go through. Wait a second and try again."; relay `balance` → "Not enough test MON."; network → "Network is busy. Trying again."; agent `busy` → "AI Agent is in another duel. Try again in a moment.", `reserved` → "AI Agent is reserved for the stage demo right now.", `not_open`/`stale` → "That duel can't be joined anymore. Create a new one."
  - WebSocket dibuka dengan `scope=duel:<id>` di layar duel dan `scope=all` di `/arena` & `/control`
  - Rute dan state, mengikuti alur pemain di spec §6.1:
    - `/` **Home**: burner otomatis; kalau `getAccount(burner).cardId` tidak null → `/play`; kalau `cardId` null tetapi `hasPulled` true (kartu sudah dipindahkan), tombolnya "Pull a new card · 0.05 MON" (`paidPull`). Tampilkan tabel `RARITY_ODDS` dengan catatan "Rolled onchain", tombol "Pull your first card · free". Kalau `/fund` menjawab `reason: 'disabled'` dan saldo kurang: pesan "Test MON is off right now. Ask the host to enable it." Kalau user agent cocok dengan in-app browser (Instagram, FBAN/FBAV, Line, Telegram, WhatsApp): banner "Open this link in your browser".
    - `/pull` **reveal gacha**: kartu tertutup (latar `surface-sunken`, ±600 ms) → bingkai menyala warna rarity (±400 ms) → `<img src="/card/:id/image.svg?v=…">` muncul, overlay foil kalau Legendary → saat `status: 'forging'` tampil "Forging lore…", ganti `v` saat `ready`. tokenId dari `events.tokenId` respons relay. Baris "Rolled in block #…" dari `nadgacha.mintedAt`. Tombol "Continue". Hormati `prefers-reduced-motion` (langsung tampil).
    - `/play` **Play**: kartu full (`<img>`), rekor `12 W · 4 L`, tombol "Fight AI Agent" (→ `createDuel` → `challengeAgent`; `409 busy` → "AI Agent is in another duel. Try again in a moment.") dan "Challenge a friend" (→ `createDuel` → `/duel/:id`). Di bawah kartu: tombol sekunder **"Pull again · 0.05 MON"** dengan baris kecil peluang (`RARITY_ODDS`) di bawahnya. Klik → `paidPull` dengan `value = pullPrice`, lalu reveal gacha yang sama; kartu baru jadi kartu aktif. **Aturan reserve balance:** tombol nonaktif sampai ≥ 3 blok sejak tx terakhir burner (wallet di bawah 10 MON hanya boleh mengirim value sebagai tx pertama dalam 3 blok). Saldo kurang → panggil `/fund` dulu, lalu coba lagi; masih kurang → "Not enough test MON for another pull."
    - `/duel/:id` dengan state dari WebSocket `scope=duel:<id>`:
      - **Ruang tunggu** (kamu `p1`, status `Open`): QR besar berisi `${location.origin}/duel/:id`, tombol salin link, "Waiting for opponent…", `GameCard` compact milikmu.
      - **Konfirmasi join** (kamu bukan `p1`, status `Open`): pemain baru dialihkan dulu ke onboarding + pull (reveal singkat), lalu layar "Join duel vs 0xAb…" dengan `GameCard` compact kedua kartu (kartu lawan dari `getCard(card1)`) dan tombol "Join duel".
      - **Penonton** (kamu bukan peserta, status sudah `Active` atau selesai): "This duel is already underway." + tombol "Back to Play".
      - **Countdown** → **Duel** (lihat spec §6.1) → **Result**.
      - **Result**: "Victory" / "Defeat" / "Draw" (`display-tap`), ringkasan dari `engine.stats()` (damage, jumlah tx onchain, rata-rata latency), link tx terakhir di explorer (`engine.stats().lastTxHash`); "Recording result onchain…" sampai duel `settled`, lalu rekor kartu terbaru dari `getCard`. Melawan AI Agent: tampilkan pelajaran dari pesan `agent` yang `duelId`-nya sama dengan duel ini (`lessons` terbaru di depan, termasuk `thresholdFrom → thresholdTo`); kalau 8 detik setelah `settled` tidak ada (duel tidak mengikuti kebijakan atau LLM gagal), jangan tampilkan apa pun. Tombol "Rematch" (AI: duel baru + challenge; teman: duel baru → ruang tunggu baru) dan "Back to Play".

- [ ] **Step 1: Tulis test yang gagal untuk `friendlyError`**

```ts
test('maps a reverted join on a non-open duel', () => expect(friendlyError({ kind: 'reverted', fn: 'joinDuel', duelStatus: 'Active' })).toBe('This duel already started. Create a new one.'));
test('maps agent busy', ...);
test('maps network errors', ...);
```

- [ ] **Step 2: Jalankan, pastikan gagal** — FAIL.
- [ ] **Step 3: Implementasi layar**

Detail yang wajib: `touch-action: manipulation` pada tombol tap; event `pointerdown`; tombol tap nonaktif selama countdown; Wake Lock saat duel; `navigator.vibrate?.(10)` per tap (hanya efektif di Android); screen shake **hanya saat skill dipakai**; `HpBar` menerima `hp` = nilai chain dan `pendingDamage` = `engine.pendingDamageEstimate(...)` dari blok pesan WS terakhir (pengurangan hanya di dalam `HpBar`); `SkillButton` mengikuti README-nya (label "Last stand", angka damage di kanan); kartu full = `<img>` SVG server, `GameCard` React hanya versi compact; badge latency dari event `confirmed`; layar hasil dengan link `https://testnet.monadscan.com/tx/<hash>`. Pemain baru yang membuka `/duel/:id` langsung diarahkan ke fund → pull → join. Sebelum `createDuel`/`joinDuel`, client membaca saldo burner; kalau < 0,1 MON, panggil `/fund` dulu (isi ulang).

- [ ] **Step 4: Jalankan unit test** — PASS.
- [ ] **Step 5: 🚩 Verifikasi checkpoint di 2 HP**

**Restart `serve.sh` tanpa `SKIP_WEB`** supaya web ikut di-build (skrip gagal kalau `web/dist/index.html` tidak ada), pastikan `cloudflared` masih jalan, buka `PUBLIC_URL` di 2 HP pakai data seluler: HP A pull → "Challenge a friend" → HP B scan QR → pull → join → duel sampai selesai → kedua layar menampilkan hasil yang sama dengan explorer.
Expected: duel PvP selesai end-to-end di testnet. **Ini checkpoint 🚩 C (target 13:45). Kalau terlambat, terapkan tabel titik keputusan spec §11.**

- [ ] **Step 6: Commit** — `git commit -m "feat(web): onboarding, pull, play and duel screens"`
- [ ] **Step 7: Rekam video aman** (±5 menit, spec §11): `Cmd+Shift+5`, satu take: pull → tantang → duel → hasil → tx di explorer. Simpan di luar repo.

---

### Task 13 · Backend: AI Agent — otot + mode "Fight AI Agent" (13:20–13:45)

> ⚠️ **ADDENDUM 24 Okt (menang atas teks task ini, lihat `docs/ADDENDUM-2026-10-24.md`):** jam baru 14:25–14:50.

**Files:**
- Create: `server/src/agent/policy.ts`, `server/src/agent/store.ts`, `server/src/agent/runner.ts`, `server/test/policy.test.ts`

**Interfaces:**
- Consumes: `runDuelPair`-style loop dari `sim/duelLoop.ts` (pakai ulang langkah per blok), `createWalletQueue` (wallet agent).
- Produces:
  - `type Policy = { skillHpThreshold: number; finisher: boolean }` (awal `{ skillHpThreshold: 30, finisher: true }`)
  - `levelFromWins(totalWins: number): number`; `ignoreProbability(level: number): number`
  - `rollDiscipline(level: number, rng: () => number): boolean` — **dikocok sekali per duel** di awal duel (`true` = duel ini mengikuti kebijakan). Kalau dikocok tiap keputusan, peluang satu duel penuh mengikuti kebijakan di Lv.1 ≈ 0,5ⁿ ≈ 0 dan pelatih tidak pernah belajar
  - `decideSkill(s: SideState, p: Policy, followPolicy: boolean, rng: () => number): boolean` — kalau `followPolicy` false, skill dipakai di titik HP acak
  - `agentTapRate(rng): number` (7–8)
  - `createAgentStore(dataDir)`: `get(): AgentData`, `update(fn)`; `AgentData = { policy: Policy; lessons: Lesson[]; opponents: Record<Hex, { lastResult: 'win'|'loss'|'draw'; skillHpPct: number | null }>; sim: {duels, wins}; testnet: {duels, wins} }`
  - `createAgentRunner(deps): { challenge(duelId: bigint): Promise<'ok'|'busy'|'reserved'|'not_open'|'stale'>; busy(): boolean; reserveFor(p1: Hex | null): void }` — sebelum join, server mengecek: duel `Open`, `p1 != agent`, dibuat ≤ 200 blok terakhir (poller mencatat `createdBlock` dari nomor blok log `DuelCreated`) — kalau duel belum ada di cache poller (tantangan datang tepat setelah `createDuel`), baca langsung `getDuels(id, 1)` dari chain dan tunggu sampai 3 blok sebelum menjawab `not_open` —, dan (kalau `reserveFor` aktif) `p1` sama dengan alamat yang dicadangkan. Lalu join dengan `cardOf(agent)`, menjalankan `runSide` (Task 10), mencatat ringkasan duel (`DuelSummary` timeline HP per tx, blok skill dipakai, elemen, hasil, `followedPolicy`) untuk Task 14
  - Route `POST /agent/challenge`; broadcast `agent` setiap kali data berubah

- [ ] **Step 1: Tulis test yang gagal**

```ts
test('level from wins', () => { expect(levelFromWins(0)).toBe(1); expect(levelFromWins(25)).toBe(3); expect(levelFromWins(200)).toBe(6); });
test('ignore probability shrinks per level', () => { expect(ignoreProbability(1)).toBe(0.5); expect(ignoreProbability(6)).toBe(0); });
test('uses skill when own hp at or below threshold', () => expect(decideSkill(side({ myHp: 450, myMaxHp: 1500 }), { skillHpThreshold: 30, finisher: false }, true, () => 0.9)).toBe(true));
test('finisher uses skill early when it would KO', () => { /* oppHp 100, skillDamage ≥ 100 → useSkill true */ });
test('never uses skill twice', ...);
test('rollDiscipline at level 1 follows policy about half the time, always at level 6', ...);
test('agent tap rate stays within 7..8', ...);
```

- [ ] **Step 2: Jalankan, pastikan gagal** — FAIL.
- [ ] **Step 3: Implementasi** — runner menolak tantangan saat sibuk (`409 busy`); route `/agent/challenge` juga dibatasi 5 tantangan per IP per 10 menit (`429 {reason: 'limit_ip'}`) supaya URL publik tidak dipakai untuk menguras saldo agent; kartu agent dibaca dari wallet `AGENT_KEY`. (Latihan berjalan di laptop lewat `train.ts`, bukan di server, jadi server tidak perlu tombol jeda latihan.)
- [ ] **Step 4: Jalankan, pastikan lulus** — PASS. Lalu verifikasi manual: dari HP, "Fight AI Agent" → duel sampai selesai.
- [ ] **Step 5: Commit** — `git commit -m "feat(agent): block-based muscle policy and challenge mode"`

---

### Task 14 · Backend: Pelatih + jurnal + latihan di anvil (13:50–14:15)

> ⚠️ **ADDENDUM 24 Okt (menang atas teks task ini, lihat `docs/ADDENDUM-2026-10-24.md`):** jam baru 14:50–15:15; pelatih aturan dulu, LLM kalau sempat.

**Files:**
- Create: `server/src/agent/coach.ts`, `server/scripts/train.ts`, `server/test/coach.test.ts`

**Interfaces:**
- Consumes: `DuelSummary`, `Policy`, `createAgentStore`, `createLlm`, `runDuelPair` (anvil + `mine`).
- Produces:
  - `type CoachOutput = { lesson: string; thresholdDelta: number; finisher: boolean }`
  - `ruleCoach(s: DuelSummary, policy: Policy, rng: () => number): CoachOutput` — kalah & skill tak terpakai → +10; kalah & skill dipakai saat HP > 50% → −10; kalah & skill dipakai saat HP ≤ 50% → 0; seri → 0; menang → acak −3..+3. `finisher` tetap sama dengan `policy.finisher`, kecuali kalah dengan skill tak terpakai padahal damage skill cukup untuk KO → `true`. `lesson` dari template sesuai kasus
  - `llmCoach(s: DuelSummary, policy: Policy, llm: Llm, rng: () => number, timeoutMs = 4000): Promise<CoachOutput>` — fallback ke `ruleCoach` kalau gagal/tidak valid
  - `applyCoach(p: Policy, out: CoachOutput): Policy` — delta di-clamp ke [−10, 10], threshold ke [10, 90], `lesson` dipotong 120 karakter
  - `onDuelSettled(summary)`: kalau `followedPolicy` → coach → update policy + tambah `Lesson { at, text, thresholdFrom, thresholdTo }` (simpan 20 terakhir); selalu update statistik `sim`/`testnet` dan `opponents[lawan] = { lastResult, skillHpPct }`
  - `train.ts --duels N [--llm-every 10]`: mulai dari `data/agent.json` yang ada (kalau ada) supaya belajar terakumulasi; deploy ke anvil lewat viem, agent vs bot (tap 5–9, threshold skill acak 10–90), `anvil_mine(3)` per tick, mulut mati; pelatih LLM hanya dipanggil tiap duel ke-10 (sisanya `ruleCoach`) supaya 300 duel selesai dalam hitungan menit, bukan 15+ menit menunggu LLM; hasil ditulis ke `data/agent.train.json` (file terpisah supaya tidak bentrok dengan server yang sedang jalan)
  - `mergeTrained(live: AgentData, trained: AgentData): AgentData` — ambil `policy` dari hasil latihan, tambahkan `sim` (bukan timpa), gabung `lessons` (urut waktu, simpan 20 terakhir), **pertahankan** `testnet` dan `opponents` dari data live. Dipanggil lewat `POST /admin/agent/merge-train` (Task 15), tanpa restart server

- [ ] **Step 1: Tulis test yang gagal**

```ts
test('rule coach raises threshold after loss with unused skill', () => expect(ruleCoach(summary({ result: 'loss', skillUsedAtHpPct: null }), policy, rng).thresholdDelta).toBe(10));
test('rule coach lowers threshold after loss with early skill', () => expect(ruleCoach(summary({ result: 'loss', skillUsedAtHpPct: 70 }), policy, rng).thresholdDelta).toBe(-10));
test('rule coach keeps threshold on draw and on loss with late skill', ...);
test('applyCoach clamps delta and threshold range', () => expect(applyCoach({ skillHpThreshold: 88, finisher: true }, { lesson: 'x', thresholdDelta: 50, finisher: true }).skillHpThreshold).toBe(90));
test('coach falls back to rules on invalid output', async () => { /* llm mengembalikan thresholdDelta 'abc' → hasil sama dengan ruleCoach */ });
test('duels that did not follow policy do not change policy', ...);
test('lesson text is truncated to 120 chars', ...);
test('mergeTrained adds sim stats and keeps live testnet stats and opponents', ...);
```

- [ ] **Step 2: Jalankan, pastikan gagal** — FAIL.
- [ ] **Step 3: Implementasi** — prompt pelatih berisi ringkasan duel + policy sekarang + 5 pelajaran terakhir. Output JSON divalidasi zod `{ lesson: string, thresholdDelta: number.int, finisher: boolean }`.
- [ ] **Step 4: Jalankan, pastikan lulus** — PASS.
- [ ] **Step 5: Latih** — Run: `pnpm -F server train --duels 300` (skrip menyalakan anvil sendiri lewat `startAnvil`) → `sim.duels` di `agent.train.json` bertambah 300 dari nilai awal, minimal 1 pelajaran baru, threshold berubah. Pasang hasilnya dengan `POST /admin/agent/merge-train` setelah Task 15 selesai (sebelum itu: hentikan server, jalankan `mergeTrained` lewat `pnpm -F server merge-agent`, nyalakan lagi).
- [ ] **Step 6: Commit** — `git commit -m "feat(agent): coach with rule fallback and anvil training"`

---

### Task 15 · Backend 15s (14:15–14:40: swarm + route admin → checkpoint D 15:10; 15:10–15:35: `event.ts` statistik + leaderboard) · Frontend 15w (13:50–14:15: `/arena` → checkpoint D; 15:10–15:35: branding, statistik, panel leaderboard)

> ⚠️ **ADDENDUM 24 Okt (menang atas teks task ini, lihat `docs/ADDENDUM-2026-10-24.md`):** **`event.ts` + leaderboard dipotong** (backend boleh tidak mengirim `leaderboard`; `uniquePlayers`/`totalDuels` = 0) dan **`/control` dipotong**. Yang tersisa: 15s swarm + route admin (15:15–15:40, D 15:40) dan 15w `/arena` + link explorer kontrak dan tx (N2). `admin.sh event-reset` tidak perlu.

**Files:**
- Create: `server/src/swarm.ts`, `server/src/admin.ts`, `server/src/event.ts`, `server/test/admin.test.ts`, `server/test/event.test.ts`, `web/src/routes/Arena.tsx`, `server/scripts/admin.sh` (pembungkus `curl` untuk semua route admin)
- Bonus: `web/src/routes/Control.tsx` (rute `/control`)

**Interfaces:**
- Consumes: `bots.json`, `runDuelPair`, `setFeatured`, `setFundEnabled`, `createAgentStore`, `stats`.
- Produces:
  - `createSwarm(deps): { start(pairs: number, rounds: number): Promise<void>; stop(): void; running(): number }` — pasangan bot `createDuel` + `joinDuel`, lalu `runSide` tanpa LLM dengan `batchBlocks: 10` (±3 dtk, maks 30 tap per tx → ±7 tx per bot per duel); setiap duel selesai langsung mulai duel baru sampai `rounds` tercapai atau `stop()`. Bot yang saldonya di bawah biaya 1 duel dilewati, bukan dibiarkan gagal
  - Route admin (semua butuh header `x-admin-token` = `ADMIN_TOKEN`, selain itu `401`): `POST /admin/swarm {pairs, rounds}`, `POST /admin/swarm/stop`, `POST /admin/fund {enabled}`, `POST /admin/featured {duelId|null}`, `POST /admin/agent/reserve {p1: Hex|null}`, `POST /admin/agent/merge-train`, `POST /admin/event/reset` (nolkan leaderboard dan statistik saat event dimulai), `GET /admin/wallets` → `{ master, operator, agent, bots: {address, balance}[] }` (balance dalam string MON)
  - `createEventStats(deps: { dataDir; exclude: Set<Hex> /* bot */; agent: Hex }): { ingestDuel(d: DuelView): void; snapshot(): { uniquePlayers: number; totalDuels: number; leaderboard: LeaderboardEntry[] }; reset(): void }` — dipanggil poller setiap blok untuk duel di jendela aktif, **idempoten**: ID duel yang sudah dihitung (pemain unik saat `Active`, hasil saat `settled`) disimpan di `data/event.json`, sehingga duel yang terlihat berulang kali atau terbaca lagi setelah restart hanya dihitung sekali; `reset()` mencatat `fromDuelId = duelCount` dan mengabaikan duel di bawahnya; `cardId` di leaderboard = kartu dari duel terakhir yang dihitung untuk alamat itu; bot dikecualikan, AI Agent diberi `label: 'AI Agent'`; disimpan ke `data/event.json` supaya tidak hilang saat restart. Treasury = saldo kontrak `NadCards`, dibaca tiap 10 dtk. Hasilnya mengisi field baru di pesan `stats` dan pesan `leaderboard`
  - `/arena` memakai tema gelap (`document.documentElement.dataset.theme = 'dark'` saat rute dibuka) dan gutter `space-8`; duel utama (featured, atau duel non-bot terbaru), grid swarm (bar HP mini), `txTotal`, `txPerSec`, `avgLatencyMs`, nomor blok, panel AI Agent (level, winrate, "Simulated: X duels · Testnet: Y onchain duels", 5 pelajaran terakhir dengan `thresholdFrom → thresholdTo`). **Mode event:** header "{event.name}" + "Presented by {event.sponsor}" (kalau ada), baris statistik "{uniquePlayers} players · {totalDuels} duels · {txTotal} onchain tx · Treasury {treasury} MON", dan panel leaderboard top 10 (alamat dipendekkan `0xAb…12` atau label "AI Agent", `W · L`). Home juga menampilkan nama event
  - `admin.sh <perintah> [arg]`: membaca `ADMIN_TOKEN` dan `PUBLIC_URL` dari `.env` root; perintah `swarm <pairs> <rounds>`, `swarm-stop`, `fund on|off`, `featured <id|none>`, `reserve <alamat|none>`, `merge-train`, `event-reset`, `wallets`
  - *(Bonus)* `/admin`: token disimpan di `sessionStorage`; tombol untuk semua route di atas; daftar saldo dengan peringatan merah di bawah 0,1 MON

- [ ] **Step 1: Tulis test yang gagal**

```ts
test('admin routes reject missing or wrong token', async () => expect((await app.request('/admin/swarm', { method: 'POST' })).status).toBe(401));
test('swarm pairs capped by available bots', ...);  // pairs 50 dengan 20 bot → start(10, rounds)
test('swarm stops after the requested rounds', ...);
test('leaderboard ranks by wins, excludes bots, labels the agent', ...);
test('event stats survive restart and reset clears them', ...);
test('same settled duel ingested twice or after restart counts once', ...);
test('agent reserve blocks challenges from other p1 addresses', ...);
```

- [ ] **Step 2: Jalankan, pastikan gagal** — FAIL.
- [ ] **Step 3: Implementasi**
- [ ] **Step 4: Jalankan + uji beban kecil** — Run: `pnpm -F server test` → PASS. Lalu `bash server/scripts/admin.sh swarm 3 2`: swarm 3 pasang × 2 ronde → amati `/arena` (tx/dtk naik, tidak ada error relay/RPC di log).
Expected: kedua ronde selesai tanpa 429 di log server. (Swarm penuh 10 pasang × 4 ronde hanya dijalankan saat demo, karena biayanya ±3,4 MON per run.)
- [ ] **Step 5: Commit** — `git commit -m "feat: projector arena, bot swarm and admin controls"`

---

### Task 16 · Backend: Mulut (ejekan) + lore AI asli (14:40–15:10; dipotong pertama kalau terlambat). Frontend pada jam yang sama: halaman `/control` (bonus), gelembung ejekan sudah ada di Task 12

> ⚠️ **ADDENDUM 24 Okt (menang atas teks task ini, lihat `docs/ADDENDUM-2026-10-24.md`):** **DIPOTONG.** Jangan dikerjakan.

**Files:**
- Create: `server/src/agent/mouth.ts`, `server/test/mouth.test.ts`
- Modify: `server/src/cards/routes.ts` (aktifkan `createLlm` untuk `forgeLore`), `server/src/agent/runner.ts` (panggil mulut tiap ~5 dtk selama duel)

**Interfaces:**
- Consumes: `createLlm`, `AgentData.opponents`, state duel saat ini.
- Produces:
  - `taunt(ctx: { myHp, oppHp, oppAddress, memory?: OpponentMemory }, llm: Llm, timeoutMs = 2500): Promise<string | null>` — `null` saat timeout/error; hasil dipotong 80 karakter; broadcast `{ type: 'taunt', duelId, text }`
  - System prompt persona (spec §2.3): **bahasa Inggris**, santai, percaya diri, meledek dengan sopan, tidak menyerang pribadi, tidak memakai kata "bet"/"wager"/"gamble"

- [ ] **Step 1: Tulis test yang gagal**

```ts
test('returns null on timeout', ...);
test('truncates taunt to 80 chars', ...);
test('includes opponent memory in prompt when known', ...);
```

- [ ] **Step 2: Jalankan, pastikan gagal** — FAIL.
- [ ] **Step 3: Implementasi** — prompt lore: berikan nama Nadmon, tahap, elemen, rarity, dan stat; minta JSON `{title, lore}` (gelar ≤ 40 karakter, lore ≤ 160 karakter, **bahasa Inggris**, tanpa kata "bet"/"wager"/"gamble"); `name` tidak boleh diubah AI; validasi zod; timeout 4000. Kartu milik alamat bot (`bots.json`) tetap memakai `fallbackLore` supaya swarm tidak memakan kuota LLM.
- [ ] **Step 4: Jalankan, pastikan lulus** — PASS. Lalu verifikasi manual: pull kartu baru → lore `source: 'ai'`; duel vs AI Agent → minimal 2 ejekan muncul.
- [ ] **Step 5: Commit** — `git commit -m "feat(agent): live taunts and AI-written card lore"`

---

### Task 17 · Kedua jalur: Hardening, video final, submission (15:40–16:30)

> ⚠️ **ADDENDUM 24 Okt (menang atas teks task ini, lihat `docs/ADDENDUM-2026-10-24.md`):** urutan backend 15:40: (1) N8 deploy + verifikasi **mainnet** (chainId 143, `MAINNET_DEPLOYER_KEY`, simulasi dulu, laporkan biaya ke user), (2) README lengkap N3, (3) `pnpm local` N4 + uji di clone bersih, (4) cek secret. Langkah demo: `cloudflared` tidak dipakai, server ada di VPS. Submit 16:35.

**Files:**
- Create: `README.md`

- [ ] **Step 1: Tes perangkat** — iPhone + Android pakai data seluler: alur penuh PvP dan vs AI Agent; reload halaman di tengah duel lalu lanjut tap (Review Focus #1); dua HP scan QR yang sama (Review Focus #2).
Expected: semuanya berjalan sesuai harapan di Review Focus.
- [ ] **Step 2: Cek keamanan**

Run: `grep -rn "VITE_" web/src; pnpm -F server check-secrets` — skrip `server/scripts/check-secrets.ts` membaca `.env` root (dotenv), membuang nilai kosong dan tanda kutip, lalu mencari setiap nilai `MASTER_KEY`, `OPERATOR_KEY`, `AGENT_KEY`, `ADMIN_TOKEN`, `LLM_API_KEY`, dan private key di `bots.json` di semua file `web/dist`.
Expected: `CLEAN`. (Mencari nilai secret yang sebenarnya, bukan pola hex umum, karena library kriptografi di bundle berisi konstanta 64-hex yang akan jadi false positive.)
- [ ] **Step 3: Rekam video final** — satu take, dua jendela berdampingan (kiri `/duel/:id` mode HP di DevTools, kanan `/arena`): duel vs AI Agent, pelajaran baru muncul, swarm berjalan. Kalau gagal atau waktu habis, pakai video aman dari Task 12.
- [ ] **Step 4: README** — ringkasan, alamat kontrak + link explorer, cara menjalankan (`anvil`, `pnpm -F server e2e`, `train`), 4 keputusan khas Monad (spec §4.3), angka MIP-8 hasil ukur dari Task 3.
- [ ] **Step 5: Commit + push + submit** — backend: `git add README.md contracts shared server deployments && git commit -m "docs: README and demo notes"`; frontend: `git add web && git commit -m "feat(web): final build"`; user yang menjalankan `git push`; isi form submission sebelum 16:45.
- [ ] **Step 6: Persiapan demo (16:45–17:00)** — pastikan hasil latihan terakhir sudah di-merge, laptop dicolok ke charger, `cloudflared` masih jalan, `pnpm -F server setup-bots --pairs 10 --topup 0.2` (profil penuh) atau `--pairs 5 --topup 0.15` (profil hemat), `POST /admin/agent/reserve` dengan alamat burner-mu, nyalakan `/fund` hanya saat sesi tanya-jawab, siapkan kartu demo yang unggul elemen melawan kartu AI Agent, gladi run-sheet spec §12.
