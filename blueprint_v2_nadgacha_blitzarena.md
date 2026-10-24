# ⚡ Blueprint v2 — NadGacha: BlitzArena

> ⚠️ **ADDENDUM 24 Okt 10:25:** `docs/ADDENDUM-2026-10-24.md` menang atas spec ini: rubrik juri, mulai 10:20, timeline dan checkpoint baru (A 12:00 · B 14:25 · C 14:45 · D 15:40), hosting di VPS (`https://nadgacha.43-134-58-217.sslip.io`, bukan laptop + tunnel), verifikasi lewat API devnads, deploy mainnet setelah testnet, dan pemotongan Task 16, `/control`, serta `event.ts`/leaderboard.
**Real-Time 1v1 Onchain Card Duel + AI NPC yang Belajar, di Monad Testnet**
*Monad Blitz Jogja Vol. 2 · Sabtu, 24 Oktober 2026 · Solo builder · Versi final hasil diskusi 23 Oktober 2026*

> Dokumen ini menggantikan `blueprint_hackathon_nadgacha_blitzarena.md` (v1, disimpan sebagai arsip).
> Semua angka dan aturan di sini adalah **satu-satunya sumber kebenaran**. Kalau ada konflik dengan v1, ikuti v2.

---

## 0. Ringkasan Satu Halaman

**Apa:** Game kartu web mobile-first. Pemain pull 1 kartu gratis (stat diacak onchain, nama + lore ditulis AI), lalu duel 1v1 real-time 20 detik di mana **setiap batch tap adalah transaksi onchain**.

**Dua mode, satu kontrak:**
1. **PvP** — dua HP, manusia vs manusia (tantang lewat QR/link).
2. **vs AI Agent** — NPC AI dengan wallet sendiri yang **belajar** dari setiap duel (jurnal + parameter strategi).

**Bukti Monad di panggung:** duel live + **swarm ±10 duel bot paralel** di proyektor (state antar duel independen → parallel execution), latency nyata per tx, storage yang dirancang untuk MIP-8.

**Yang dibuang dari v1 (dan alasannya):**

| Dibuang | Alasan |
|---|---|
| Boss Raid massal | Semua tap menulis 1 slot `bossHP` → konflik total, kebalikan dari keunggulan parallel execution |
| Demo 50 penonton tap bersama | Risiko wifi venue, rate limit RPC, dan budget MON. Diganti: duel kamu + swarm bot yang terkendali |
| Dynamic / Privy | Burner wallet lebih cepat untuk onboarding QR, tanpa konfigurasi dashboard |
| ZeroDev / session keys | Burner sudah tanpa pop-up; setup bundler/paymaster terlalu berisiko waktunya |
| Gelato VRF | Ketersediaan di Monad testnet tidak terkonfirmasi → pseudo-random, VRF jadi roadmap |
| Envio / Ghost | 1 block watcher + `getDuels()` sudah cukup untuk 2 kontrak |
| AI Commentator terpisah | Dilebur jadi ejekan AI Agent |
| Klaim "finalitas 300ms" | Yang 300ms itu block time; finalitas penuh ~600ms. Tampilkan latency terukur |

---

## 1. Konteks Event

* **Lokasi:** Garuda Spark Innovation Hub (GSIH), Mlati, Yogyakarta.
* **Jadwal:** 07:00 datang · 08:30–09:00 Workshop Monad 101 · 09:15–16:30 build · 16:30–16:45 submission · 17:00–19:00 pitching.
* **Penilaian:** "sejauh apa projek utilizing Monad". Di beberapa Blitz (mis. Ankara) pemenang dipilih **voting audiens** → **cek apakah Jogja juga begitu**.
* **Lanskap:** dari 742 proyek hackathon Monad di 2026, 413 adalah agentic AI. Game yang bisa dimainkan juri akan menonjol; AI agent di sini **fitur pendukung, bukan inti**.

---

## 2. Desain Game

### 2.1 Kartu
| Atribut | Aturan |
|---|---|
| Rarity | Acak 0–99: `<60` Common (0), `<88` Rare (1), `<98` Epic (2), sisanya Legendary (3) |
| ATK | `10–14` acak `+ rarity` |
| HP | `1500–1800` acak `+ 100 × rarity` |
| Elemen | 0 Fire, 1 Water, 2 Lightning |
| Rekam | `wins`, `losses` tercatat onchain di NFT |
| Nama | Nama spesies **Nadmon** dari elemen + rarity (9 makhluk original: Embrit/Blazenad/Infernad, Dripnad/Wavenad/Abyssnad, Sparkit/Voltnad/Tempestnad) |
| Gelar & lore | Ditulis AI **sesuai** spesies, stat & elemen (AI tidak menentukan stat atau nama) |
| Gambar | Kartu bergaya TCG (`GameCard`): Nadmon sesuai spesies, HP di pojok, serangan Tap & Last stand dengan angka, unggul/lemah, flavor text. Tahap evolusi: Common & Rare = 1, Epic = 2, Legendary = 3. Legendary mendapat kilau foil. Tidak memakai karakter komunitas, wajah KOL, atau ciri merek Pokémon |

**Keunggulan elemen:** penyerang `a` unggul atas bertahan `d` jika `(d + 1) % 3 == a` → **Water > Fire, Lightning > Water, Fire > Lightning**.
Pengali (`mult`): unggul **150**, sama **100**, kalah **75** (persen).

Bonus rarity sengaja kecil: kartu Common yang unggul elemen bisa mengalahkan Legendary. Elemen, kecepatan tap, dan timing skill lebih menentukan daripada hoki gacha.

### 2.2 Duel
* **Countdown** 10 blok (~3 dtk), **durasi** 67 blok (~20 dtk).
* **Damage tap** = `taps × atk × mult / 100`.
* **Batas tap** = 3 per blok (~10 tap/dtk, setara manusia sangat cepat), maksimal 30 per tx.
* **Skill "Last Stand"** (1× per duel): `damage = atk × mult × (10·maxHp + 40·hpHilang) / (100·maxHp)`.
  HP penuh → ~10× ATK; HP sisa 10% → ~46× ATK. Dilema timing yang nyata.
* **Menang:** HP lawan 0 (KO), atau sisa HP lebih besar saat waktu habis. HP sama → **seri** (tidak dicatat).
* Tombol skill di layar menampilkan **damage saat ini** (mis. "Last stand · 380 dmg").

### 2.3 AI Agent (NPC)
* **Nama di UI:** "AI Agent".
* **Persona:** penjaga arena yang santai dan percaya diri, meledek dengan sopan. Bahasa Inggris. Contoh: *"Fast fingers… but you fired that skill way too early."* Tidak menyerang pribadi.
* **Main dengan aturan yang sama:** wallet sendiri, kartu dari `freePull()`, dibatasi kontrak yang sama.
* **Kecepatan tap 7–8/dtk** (dengan jitter). Jago karena **strategi**, bukan kecepatan.
* **Mengenali lawan** per alamat wallet (hasil terakhir, kebiasaan skill) untuk ejekan.
* **Belajar** (detail §5.2): parameter `skillHpThreshold` dan `finisher` diperbarui setelah setiap duel, dengan pelajaran tertulis yang tampil di proyektor.

---

## 3. Arsitektur

```text
 HP kamu            HP lawan (PvP)            Laptop proyektor
 ┌──────────┐       ┌──────────┐              ┌──────────────────────┐
 │ burner   │       │ burner   │              │ /arena: duel utama,   │
 │ wallet   │       │ wallet   │              │ grid swarm, tx/dtk,   │
 └──┬────▲──┘       └──┬────▲──┘              │ blok, panel AI Agent  │
    │ tx │ WebSocket   │    │                 └──────────▲───────────┘
    ▼    │             ▼    │                            │
 ┌────────┴────────────────┴────────────────────────────┴──┐
 │ GAME SERVER (1 service Node: Hono + ws + viem, laptop)   │
 │ /config · /fund · /relay · /card/:id · /admin/*          │
 │ block watcher (1× eth_getBlockReceipts per blok)         │
 │ poller (getDuels → broadcast) · settle otomatis          │
 │ agent (otot · pelatih · mulut) · swarm bot               │
 │ antrean berurutan per wallet server                      │
 └──────────────────────────┬───────────────────────────────┘
                            ▼ RPC berbayar (+ cadangan)
            Monad Testnet 10143: NadCards.sol + BlitzArena.sol
```

### 3.1 Keputusan kunci
| # | Keputusan | Alasan |
|---|---|---|
| D1 | HP menandatangani tx, server **meneruskan** (relay) | Tx tetap milik pemain; tidak kena rate limit per-IP wifi; API key RPC tidak ke client |
| D2 | Matchmaking: `createDuel` → QR/link → `joinDuel`; mode AI: server menyuruh agent join | Sederhana, cocok untuk 1v1 |
| D3 | Server membaca sekali, **broadcast** ke semua lewat WebSocket | Beban RPC konstan, tidak tergantung jumlah pemain |
| D4 | 1 service Node (Vite React statis + Hono + ws) **di laptop sendiri**, dibuka ke internet lewat **Cloudflare Tunnel** (`cloudflared` quick tunnel: HTTPS gratis, tanpa akun, mendukung WebSocket) | Tidak ada langkah deploy; data tersimpan di disk laptop; latihan anvil dan server ada di mesin yang sama; laptop memang harus ada di venue untuk proyektor. Vercel serverless tidak cocok untuk state in-memory & WebSocket |

### 3.2 Tiga sumber kebenaran
* **Chain** menentukan hasil (damage, pemenang, rekam kartu).
* **Server** hanya meneruskan, membaca, menyiarkan, dan memanggil `settle()` (boleh dipanggil siapa saja).
* **Client** meramalkan (UI optimistis) lalu mengikuti chain.
Kalau server mati di tengah duel, duel tetap valid onchain.

### 3.3 Konfigurasi jaringan (sudah diuji 23 Okt)
| Parameter | Nilai |
|---|---|
| Chain ID | `10143` (`0x279f`) |
| RPC publik | `https://testnet-rpc.monad.xyz` (rate limit ±20 rps, hanya untuk cadangan baca) |
| Gas price | ~102 gwei (base fee 100 + priority 2) |
| Block time | ~300 ms; `timestamp` beresolusi 1 detik → pakai `block.number` |
| Explorer | `https://testnet.monadscan.com` (merespons, dicek 23 Okt) |
| Verifikasi kontrak | `forge verify-contract … --chain 10143 --verifier sourcify --verifier-url https://sourcify-api-monad.blockvision.org/` (tanpa API key) |

### 3.4 Struktur repo
```text
monad-tcg/
├── contracts/   Foundry: src/NadCards.sol, src/BlitzArena.sol, test/, script/Deploy.s.sol
├── server/      Hono: chain, walletQueue, fund, relay, blockWatcher, poller, cards, agent/, swarm, admin
├── web/         Vite + React + Tailwind: rute §6, lib/txEngine.ts, lib/burner.ts
└── scripts/     setup-bots.ts, e2e.ts, train.ts (anvil), swarm.ts
```

---

## 4. Smart Contract (Foundry · Monad Testnet 10143)

### 4.1 `NadCards.sol` — ERC-721 (OpenZeppelin) + Ownable
```solidity
struct Card {            // 18 byte → 1 slot
    uint16 atk;
    uint16 hp;
    uint8  element;      // 0 Fire, 1 Water, 2 Lightning
    uint8  rarity;       // 0..3
    uint16 wins;
    uint16 losses;
    uint64 mintedAt;     // block.number saat mint
}
```
| Fungsi | Akses | Isi |
|---|---|---|
| `freePull()` | siapa saja, **1× per alamat**, `require(msg.sender == tx.origin)` | Set flag `pulled` dulu, acak rarity & stat, lalu `_mint` (bukan `_safeMint`) |
| `paidPull()` | siapa saja, payable, **`msg.value == PULL_PRICE` (0.05 MON)**, boleh berkali-kali | Pack berbayar: kartu baru jadi kartu aktif (`cardOf`), kartu lama tetap milik pemain. Uang tinggal di kontrak sebagai treasury |
| `withdraw(to)` | owner | Menarik saldo treasury |
| `royaltyInfo` (ERC-2981) | view | Royalti marketplace 5% ke owner |
| `cardOf(address)` | view | ID kartu milik alamat (0 = belum pull). Dipakai client, agent, dan bot untuk tahu `cardId` tanpa enumerasi token |
| `recordResult(winId, loseId)` | **hanya Arena** | `wins++`, `losses++` |
| `setArena(addr)` | owner, **sekali** lalu terkunci | — |
| `setBaseURI(uri)` | owner | `tokenURI` → `https://<server>/card/{id}` |

**Keacakan:** `keccak256(block.prevrandao, msg.sender, tokenId)`. Sudah dicek di testnet: `prevrandao` (field `mixHash`) berbeda di setiap blok (§13). Disebut terus terang di pitch sebagai pseudo-random testnet; VRF di roadmap.

### 4.2 `BlitzArena.sol` — duel paralel
**Penyimpanan:** `Duel[] duels` (**array, bukan mapping**) → elemen berurutan di storage, ~42 duel per page MIP-8.

```solidity
enum Status { Open, Active, P1Won, P2Won, Draw }

struct Duel {
    // slot 1 — sisi P1 (31 byte)
    address p1; uint16 hp1; uint16 atk1; uint8 mult1;
    uint32 lastBlock1; bool skill1; Status status;
    // slot 2 — sisi P2 (30 byte)
    address p2; uint16 hp2; uint16 atk2; uint8 mult2;
    uint32 lastBlock2; bool skill2;
    // slot 3 — meta (17 byte)
    uint32 startBlock; uint32 card1; uint32 card2;
    uint16 maxHp1; uint16 maxHp2; bool settled;
}
```

| Konstanta | Nilai |
|---|---|
| `COUNTDOWN_BLOCKS` | 10 |
| `DUEL_BLOCKS` | 67 |
| `MAX_TAPS_PER_BLOCK` | 3 |
| `MAX_TAPS_PER_TX` | 30 |

| Fungsi | Aturan |
|---|---|
| `createDuel(cardId)` | `ownerOf(cardId) == msg.sender`; push duel `Open`; return `duelId` |
| `joinDuel(id, cardId)` | Status `Open`, `msg.sender != p1`, pemilik kartu. Salin atk/hp/mult kedua sisi ke duel; `startBlock = block.number + COUNTDOWN_BLOCKS`; `lastBlock1 = lastBlock2 = startBlock`; status `Active` |
| `attack(id, taps, useSkill)` | Hanya peserta (bukan peserta → revert). Kalau duel sudah selesai (KO / sudah di-settle) → **return tanpa efek**, karena tx yang in-flight saat lawan KO adalah kondisi normal. Lihat langkah di bawah. **Tanpa panggilan ke kontrak lain.** |
| `settle(id)` | Siapa saja. Jika `Active` dan waktu habis → tentukan pemenang dari sisa HP. Lalu jika sudah selesai dan `!settled` → `settled = true`, `recordResult` (kecuali seri) |
| `getDuels(from, count)` | `view` untuk poller |

**Langkah `attack()`:**
1. Jika `block.number >= startBlock + DUEL_BLOCKS` → tutup duel berdasarkan HP, **abaikan tap**, return.
2. Jika `block.number < startBlock` → return tanpa efek (clamp, bukan revert).
3. `allowed = min(taps, (block.number − lastBlock) × 3, 30)`; set `lastBlock = block.number`.
4. Hitung damage tap + skill (jika `useSkill` dan belum dipakai) **dalam `uint256`**.
5. `hpLawan = dmg >= hpLawan ? 0 : hpLawan − dmg`.
6. Jika `hpLawan == 0` → status `P1Won`/`P2Won`. Emit `Attacked(id, attacker, allowed, dmg, hpLawan)`.

**Event:** `DuelCreated`, `DuelStarted`, `Attacked`, `DuelEnded`. `DuelEnded` dipancarkan **di mana pun status berubah jadi selesai**: KO di `attack()`, waktu habis di `attack()` langkah 1, atau waktu habis di `settle()`.
**Akses admin:** owner hanya `setArena`. Tidak ada fungsi yang bisa mengubah HP, pemenang, atau stat.

### 4.3 Prinsip desain khas Monad (bahan pitch)
1. **Clamp, jangan revert.** Tx revert tetap membayar penuh `gasLimit`; tap kelebihan/terlambat adalah kondisi normal.
2. **Jalur panas kecil, biaya tetap.** `attack()` hanya menyentuh 3 slot duelnya sendiri; pekerjaan berat (`recordResult`) dipindah ke `settle()`. Dengan begitu `gasLimit` ketat dan bisa diprediksi.
3. **State terisolasi per duel** → duel berbeda tidak pernah konflik → parallel execution optimal.
4. **MIP-8 menghemat biaya di setiap tap.** Satu duel = 3 slot berurutan, jadi `attack()` membayar 1 baca page dingin (±8.100 gas) + 2 baca murah (±100 gas), bukan 3 baca dingin (±24.300 gas). Penghematan ±16.000 gas per tx itu **langsung mengecilkan `gasLimit`**, dan karena Monad menagih dari `gasLimit`, biaya setiap tap ikut turun. Bonusnya, `Duel[]` yang berurutan membuat `getDuels()` cepat dibaca poller.
   *Angka 8.100/100 berasal dari liputan berita MIP-8, belum dari dokumen resmi. Selain itu, akses `duels[id]` juga membaca `duels.length` (slot lain di page lain), dan duel 3 slot kadang melintasi batas page. Jadi di pitch **hanya sebut angka hasil ukur `cast estimate`**.*
   *Catatan untuk pitch: `getDuels()` adalah `view` yang dipanggil lewat `eth_call`, jadi tidak ada biaya gas yang dibayar. Jangan jual MIP-8 sebagai "getDuels jadi murah". Jual sebagai "setiap tap jadi lebih murah".*
5. **Semua aritmetika di `uint256`** (checked arithmetic Solidity 0.8 pada `uint16` akan overflow).

### 4.4 Test Foundry (test-first, wajib)
1. Tap dipotong sesuai selisih blok dan batas per tx
2. Pengali elemen 150 / 100 / 75 sesuai aturan `(d+1)%3 == a`
3. Skill hanya 1×; rumus skill pada HP penuh dan HP 10%
4. Duel tertutup saat HP 0 dan saat waktu habis; tap setelah waktu habis diabaikan
5. Seri tidak mencatat menang/kalah
6. Bukan peserta tidak bisa `attack`
7. `recordResult` hanya dari Arena; `settle` tidak bisa mencatat dua kali
8. `freePull` 1× per alamat dan menolak pemanggil kontrak
9. **Fuzz:** kombinasi tap & blok acak tidak pernah overflow/underflow

`gasLimit` tiap fungsi = hasil **`cast estimate` di Monad testnet** setelah deploy × 1,2, dipakai sebagai nilai tetap di client. Jalur `attack` diukur dalam dua kondisi: tap biasa dan tap yang menghasilkan KO.
> ⚠️ Jangan pakai `forge test --gas-report` untuk ini. Foundry menjalankan EVM lokal dengan harga gas Ethereum, bukan harga Monad (SLOAD dingin 8.100, page MIP-8), jadi angkanya meleset.

---

## 5. Game Server

### 5.1 Modul
| Modul | Tugas | Pengaman |
|---|---|---|
| `chain.ts` | Client viem ke RPC berbayar + daftar RPC cadangan, ABI, alamat | Semua private key hanya di env server |
| `walletQueue.ts` | **Satu antrean berurutan per wallet server** (master, operator, agent, bot) | Mencegah bentrok nonce |
| `/config` | `{chainId, contracts, gasLimits, gasPrice, batchMs, pullPrice, event}` (`event` = nama event + sponsor dari env); `gasPrice` diperbarui tiap ~10 dtk | — |
| `/fund {address}` | Kirim **0,3 MON** (cukup untuk pull + ±2 duel); isi ulang 0,3 MON jika saldo < **0,1 MON** | Status awal dari env `FUND_ENABLED` (default mati; `.env` dev menyalakannya), lalu diatur lewat `admin.sh fund on|off`. Saat pitch, nyalakan hanya saat dibutuhkan. Transfer dari master memberi jeda ≥ 3 blok (aturan reserve balance). Maks **3× per alamat**, 10 per IP / 10 menit, budget total `FUND_BUDGET_MON` (default 3). Jatah dicadangkan secara atomik (request paralel tidak bisa lolos bersamaan) dan ledger disimpan ke `data/fund.json` supaya tidak reset saat restart |
| `GET /account/:address` | `{nonce, balance, cardId}` lewat RPC berbayar, supaya HP tidak memakai RPC publik dan pemain yang kembali langsung tahu kartunya | Cache 1 dtk per alamat |
| `/relay {rawTx}` | Decode & validasi, daftarkan penunggu receipt **sebelum** mengirim, kirim, tunggu receipt dari block watcher, return `{hash, latencyMs, events}` (`events.tokenId` / `events.duelId` didekode dari log) | Maks 3 tx/dtk per pengirim dan 30 tx/dtk per IP; tolak kalau saldo pengirim tidak cukup untuk gas; `chainId` 10143, `to` ∈ {NadCards, BlitzArena}, selector ∈ {freePull, paidPull, createDuel, joinDuel, attack, settle}, `value = 0` kecuali `paidPull` (`value = PULL_PRICE`), `gasLimit` ≤ batas. `already known` / `nonce too low` → cek hash, mungkin sudah sukses |
| `blockWatcher.ts` | Per blok baru: **1× `eth_getBlockReceipts`** → selesaikan relay yang menunggu, hitung event `Attacked` (tx counter), deteksi mint → buat lore | Failover ke RPC cadangan |
| `poller.ts` | Sekali per blok baru (±300 ms): `getDuels()` untuk jendela duel aktif → broadcast (dengan `blockNumber`); panggil `settle()` untuk duel yang selesai/habis waktu tapi belum `settled` | Lewat antrean wallet operator |
| `cards.ts` | `GET /card/:id` (metadata ERC-721, status `forging` sampai siap), `GET /card/:id/image.svg` (bukan `/card/:id.svg`, yang di Hono ikut menangkap `/card/5`). Lore dibuat otomatis saat mint terdeteksi; kalau mint terlewat saat server mati, lore template dibuat saat pertama kali diminta | Stat **dibaca dari chain**; cache per tokenId; LLM timeout 4 dtk → template |
| `agent/` | AI Agent (§5.2) | 1 duel per waktu; `/agent/challenge` maks 5 per IP / 10 menit; hanya join duel yang `Open`, dibuat ≤ 200 blok terakhir, dan bukan milik agent sendiri; admin bisa **mencadangkan** agent untuk satu alamat (dipakai saat pitch supaya pengunjung tidak bisa menyibukkan agent) |
| `swarm.ts` | `POST /admin/swarm {pairs}` | `ADMIN_TOKEN` |
| `event.ts` | Statistik event (pemain unik, total duel, treasury) dan **leaderboard top 10** dari duel yang selesai; bot dikecualikan; disimpan di `data/event.json`; di-reset dari admin saat event mulai | — |
| `admin` | Swarm (`pairs`, `rounds`), reset event, pilih duel utama di proyektor, fund on/off, cadangkan agent, merge hasil latihan, saldo semua wallet server | `ADMIN_TOKEN` |

**WebSocket:** HP berlangganan `scope=duel:<id>` (hanya duelnya sendiri), proyektor `scope=all`. Kalau semua koneksi menerima semua duel, tiap HP menarik ±95 KB/dtk.
**Penyimpanan:** `cards.json`, `agent.json`, `bots.json`, `fund.json` di folder `data/` di laptop. Semua path di-resolve dari root repo. URL tunnel tetap sama selama proses `cloudflared` tidak dimatikan, walaupun server di-restart. Kalau `cloudflared` terpaksa di-restart, URL-nya berubah: perbarui `PUBLIC_URL` dan panggil `setBaseURI` lagi.
**AI:** API Kimi (kompatibel OpenAI, cukup ganti `baseURL`) atau OpenAI. Output JSON mode + validasi zod.
**Beban RPC tetap:** block watcher (`eth_blockNumber` tiap 150 ms + `eth_getBlockReceipts` per blok) + poller (`getDuels` sekali per blok; `duelCount` dilacak dari event `DuelCreated`) ≈ 13 rps, ditambah `sendRawTransaction` ≈ `pairs × 2` per detik. **Ukuran swarm dibatasi dua hal:** paket RPC (paket 50 rps → maksimal ~20 pasang) dan budget MON (§9 → **10 pasang**). Ambil yang lebih kecil.

### 5.2 AI Agent — otot, pelatih, mulut
| Peran | Kapan | Tugas |
|---|---|---|
| **Otot** (`agent/policy.ts` + `agent/runner.ts`) | selama duel, per receipt | **Satu-satunya yang memutuskan aksi.** Tap 7–8/dtk + jitter. Pakai skill jika HP sendiri ≤ `skillHpThreshold`, atau jika `finisher` aktif dan damage skill cukup untuk KO |
| **Pelatih** (`agent/coach.ts`, LLM) | **setelah** duel di-settle | Input: ringkasan duel (timeline HP, kapan skill dipakai, elemen, hasil). Output: `{pelajaran ≤120 karakter, thresholdDelta ∈ [−10, +10], finisher}`. Divalidasi; threshold dijaga di [10, 90]. Fallback aturan: kalah & skill tak terpakai → +10; kalah setelah skill dipakai saat HP > 50% → −10; menang → ±3 acak |
| **Mulut** (`agent/mouth.ts`, LLM) | selama duel, tiap ~5 dtk | Ejekan ≤80 karakter; boleh mengutip memori lawan. Timeout → diam |

**Level & disiplin:** `level = min(6, 1 + floor(totalWins / 10))`. Di awal setiap duel dikocok **sekali**: di Lv.1 peluang 50% duel itu tidak mengikuti kebijakan (skill dipakai di titik acak); berkurang 10% per level, jadi 0% di Lv.6. (Kalau dikocok di setiap keputusan, hampir tidak ada duel yang sepenuhnya mengikuti kebijakan, dan pelatih tidak pernah belajar.) Agent jadi jago karena **lebih disiplin & pintar**, bukan lebih cepat.
**Data bersih:** setiap duel menyimpan flag `ikutKebijakan`; **pelatih hanya belajar dari duel yang mengikuti kebijakan.**
**Konkurensi:** 1 duel per waktu (1 wallet = 1 nonce). Tantangan saat sibuk → "AI Agent is in another duel. Try again in a moment."
**Statistik jujur:** tampil terpisah, mis. *"Simulated: 300 duels · Testnet: 12 onchain duels"*. Rekam onchain ada di kartu NFT agent.

### 5.3 Latihan di anvil (`server/scripts/train.ts`)
* Kontrak **yang sama persis** dideploy ke anvil lokal; gas gratis.
* Automine dimatikan. Setiap tick: agent & bot mengirim tx, lalu `anvil_mine(3)` (≈1 dtk waktu game). Deterministik dan secepat CPU.
* Syarat: **loop otot dan bot berbasis blok, bukan waktu** (`tap = kecepatan × blok yang lewat × 0,3 dtk`). Kode yang sama jalan di testnet dan anvil.
* Bot latihan: tap 5–9/dtk acak, **memakai skill dengan threshold acak**, supaya ada yang bisa dipelajari.
* Mulut dimatikan saat latihan. Pelatih LLM hanya dipanggil tiap duel ke-10 (`--llm-every 10`), sisanya pelatih berbasis aturan, supaya 300 duel selesai dalam hitungan menit.
* Latihan melanjutkan `data/agent.json` yang sudah ada dan menulis hasilnya ke `data/agent.train.json`. Untuk memasang: `POST /admin/agent/merge-train`, yang mengambil `policy` hasil latihan, menambahkan statistik simulasi, menggabung pelajaran, dan **mempertahankan** statistik testnet serta memori lawan dari data live. Tidak perlu restart server.

### 5.4 Swarm (`server/src/swarm.ts` / `server/scripts/setup-bots.ts`)
* `setup-bots`: buat (atau muat) 2×N wallet bot, isi saldo tiap bot sampai 0,15 MON (hanya selisihnya), `freePull` untuk yang belum punya kartu, isi wallet agent sampai 1 MON dan operator sampai 0,5 MON. **Dijalankan ulang sebelum gladi dan sebelum demo.** `--sweep` menarik sisa saldo bot ke master.
* Saat demo: `POST /admin/swarm {pairs, rounds}`. N pasang bot `createDuel` + `joinDuel`, lalu loop tanpa LLM (tap 5–9/dtk), mengirim 1 tx per ±10 blok (±3 dtk, maks 30 tap per tx, ±7 tx per bot per duel), lalu mulai duel baru sampai jumlah ronde tercapai. Bot yang saldonya kurang untuk 1 duel dilewati.
* Bot tidak memicu pembuatan lore AI (pakai template).

---

## 6. Client (Vite + React + Tailwind + viem)

**Design system:** `docs/design-system/` (arah "Monad-native bersih", juga ter-publish sebagai artifact *NadGacha Design System*). HP memakai tema terang, proyektor `/arena` tema gelap. Satu warna aksi (`purple`) untuk pemain dan tombol, `berry` untuk lawan, garis tipis bukan bayangan, angka dalam font mono. Spesifikasi komponen: `GameCard`, `HpBar`, `TapButton`, `SkillButton`, `LatencyBadge`.

### 6.1 Rute
| Rute | Isi |
|---|---|
| `/` | **Home.** Burner dibuat otomatis (`localStorage`). Pemain yang sudah punya kartu (`/account` → `cardId`) langsung ke `/play`. Tabel peluang rarity ("Rolled onchain"), tombol **Pull your first card · free**. Pesan jelas kalau `/fund` sedang dimatikan; banner "Open this link in your browser" di in-app browser |
| `/pull` | **Reveal gacha:** kartu tertutup → bingkai menyala warna rarity → kartu TCG terbuka (`<img>` SVG dari server, kilau foil kalau Legendary) → "Forging lore…" → gelar dan lore AI. Nomor blok tempat kartu diacak |
| `/play` | Kartu full + rekor. **Fight AI Agent** atau **Challenge a friend**. Tombol sekunder **Pull again · 0.05 MON** (pack berbayar, reveal yang sama) |
| `/duel/:id` | **Ruang tunggu** (pembuat duel): QR besar, salin link, "Waiting for opponent…". **Konfirmasi join** (penantang): pemain baru onboarding + pull dulu, lalu "Join duel vs 0x…" dengan kartu kedua pihak. **Duel:** countdown → bar HP kedua sisi, tombol tap besar, tombol skill dengan damage saat ini, badge latency, nomor blok, gelembung ejekan. **Result:** Victory / Defeat / Draw, ringkasan (damage, jumlah tx, rata-rata latency, link explorer), "Recording result onchain…" sampai rekor kartu ter-update, **pelajaran baru AI Agent** (kalau melawan agent), tombol Rematch dan Back to Play |
| `/arena` | Proyektor: **nama event + "Presented by {sponsor}"**, statistik "players · duels · onchain tx · Treasury", **leaderboard top 10**, duel utama besar, grid swarm, tx total & tx/dtk, rata-rata latency, nomor blok, panel AI Agent (level, winrate, pelajaran terbaru + perubahan threshold) |
| `/control` | Halaman kontrol (bonus): tombol untuk route admin §5.1. Nama sengaja bukan `/admin` supaya tidak bertabrakan dengan API `/admin/*` |

### 6.2 Mesin tx (`txEngine.ts`)
1. Tap ditampung di buffer (event `pointerdown`). Client **meniru batas kontrak** (3 tap per blok yang lewat **sejak `blockNumber` receipt tx terakhir**, basis yang sama dengan `lastBlock` di kontrak) supaya angka optimistis sama dengan chain.
2. **1 tx in-flight per pemain**, dan jarak antar tx minimal `batchMs` (default 1.000 ms; 2.000 ms kalau MON terbatas). Jika tidak ada tx in-flight, `batchMs` sudah lewat, buffer berisi, dan duel masih di jendela waktu → tandatangani `attack(id, min(buffer, 30), skill)` dengan `gasLimit` dari `/config`, `maxFeePerGas = 2 × gasPrice`, `maxPriorityFeePerGas = 2 gwei`, dan nonce lokal → `/relay`.
3. Receipt → badge latency → kirim batch berikutnya.
4. Relay timeout >5 dtk → **kirim ulang tx yang sama persis** (hash sama), jangan tanda tangan ulang.
5. Error nonce → sinkronkan dari chain, coba 1× lagi. Error lain → buang tx, toast kecil, game jalan terus.
6. **Flush terakhir:** di `endBlock − 3`, sisa buffer langsung dikirim tanpa menunggu `batchMs` (asal tidak ada tx in-flight). Pada blok ≥ `endBlock − 2`, tidak mengirim lagi. Tanpa aturan ini, dengan `batchMs` 2.000 ms tap di ±2 detik terakhir bisa hilang.
7. Tombol tap **nonaktif selama countdown**, supaya tap tidak menumpuk di buffer sebelum duel mulai.

**UI optimistis:** HP lawan = nilai chain − damage dari tx yang **belum masuk** ke blok `blockNumber` pesan WebSocket terakhir.

### 6.3 Detail mobile
* `touch-action: manipulation` (cegah zoom saat tap cepat); Wake Lock API.
* Getar (`navigator.vibrate`) hanya Android; iOS → getaran visual (screen shake).
* Layar QR menulis *"Open this link in your browser"* (in-app browser aplikasi QR punya `localStorage` terpisah).

---

## 7. Error Handling

| Kegagalan | Perilaku |
|---|---|
| RPC down / 429 | Pindah ke RPC cadangan (relay & block watcher). Client: toast "Network is busy. Trying again.", buffer tetap |
| Relay timeout | Kirim ulang tx yang sama (hash sama) |
| Error nonce | Sinkronkan ulang, coba 1× |
| Tx revert (mis. duel sudah penuh) | Pesan jelas: "This duel already started. Create a new one." |
| Saldo burner hampir habis | `/fund` isi ulang (maks 3× per alamat) |
| LLM timeout/error | Lore → template; pelatih → aturan; mulut → diam |
| Server crash | Server dijalankan dalam loop restart otomatis; duel aman onchain; data aman di disk laptop; client reconnect + snapshot penuh |
| WebSocket putus | Reconnect dengan jeda bertambah, lalu snapshot penuh |
| Lawan kabur | Waktu habis → poller `settle()` → pemenang dari sisa HP |
| Wallet server kehabisan MON | `admin.sh wallets` (atau halaman `/control`) menampilkan saldo + peringatan di bawah ambang |
| Wifi venue mati | HP pakai data seluler; laptop pakai hotspot HP; terakhir: video cadangan |

---

## 8. Testing

| Lapis | Apa | Kedalaman |
|---|---|---|
| Kontrak | §4.4 (8 test + fuzz) | Ketat, test-first — bug kontrak tidak bisa diperbaiki setelah deploy |
| Fungsi murni server | Validasi relay; aturan pelatih (batas ±10, rentang [10, 90]) | Unit test singkat |
| End-to-end | `server/scripts/e2e.ts` di anvil: deploy → 2 burner → duel penuh → settle → cek rekor | Satu harness, dipakai juga oleh `train.ts` & swarm |
| Beban | Swarm di testnet: 3 pasang × 2 ronde, pantau rps & error | Sekali, ±15:30 |
| Perangkat | iPhone + Android sungguhan, **data seluler** | Sekali, ±15:40 |

*Pengecualian yang disengaja dari aturan coverage 80%:* untuk hackathon 7 jam, test ketat hanya untuk kontrak dan fungsi murni kritis; UI & glue code diuji lewat e2e dan perangkat.

---

## 9. Budget MON (Testnet)

**Data terukur di testnet (23 Okt, 22:2x WIB):** `gasPrice` **102 gwei** (base fee 100 gwei + priority 2 gwei).
**Asumsi:** `gasLimit(attack)` ≈ 60.000 (ganti dengan hasil `cast estimate` besok).
→ **1 tx attack ≈ 60.000 × 102 gwei ≈ 0,006 MON.** Satu pemain dalam satu duel (~20 tx) ≈ 0,12 MON.

**Faucet hanya ~1 MON per wallet per faucet per hari**, padahal rencana awal (~3.400 tx) butuh ~21 MON. Karena itu, budget dipangkas jadi:

Bot swarm mengirim 1 tx per ±3 dtk (±7 tx per bot per duel ≈ 0,042 MON). Swarm di demo dinyalakan di detik 0:40 dan dibahas sampai 2:15, jadi butuh ±4 ronde.

| Kebutuhan | Profil penuh | Profil hemat |
|---|---|---|
| Latihan agent | 0 (anvil) | 0 (anvil) |
| Swarm uji/gladi | 3 pasang × 2 ronde ≈ 84 tx | 3 pasang × 1 ronde ≈ 42 tx |
| Swarm demo | 10 pasang × 4 ronde ≈ 560 tx | 5 pasang × 3 ronde ≈ 210 tx |
| Duel agent di testnet | ~11 duel ≈ 220 tx | ~7 duel (`batchMs` 2.000) ≈ 70 tx |
| Pemain manusia | ~15 duel ≈ 300 tx | ~10 duel (`batchMs` 2.000) ≈ 100 tx |
| Setup + `settle` | ~100 tx | ~60 tx |
| **Total terpakai** | **~1.260 tx ≈ 7,6 MON** + deploy 0,5 | **~480 tx ≈ 2,9 MON** + deploy 0,5 |

**Aturan hemat selama build:** semua uji fungsional dijalankan di **anvil** (`e2e.ts`). Testnet hanya dipakai untuk verifikasi akhir tiap tahap. Satu kali redeploy kontrak ≈ 0,5 MON, jadi pastikan test Foundry lulus sebelum deploy. Sisihkan cadangan **±20%** di luar tabel di atas.

**Tuas penghemat:** `BATCH_MS` (jarak minimal antar tx per pemain, §6.2). Default 1.000 ms; ubah ke **2.000 ms** kalau MON kurang, sehingga jumlah tx attack pemain dan agent terpangkas separuh. Damage tetap tampil instan di layar lewat UI optimistis.

**Sumber MON malam ini:** faucet resmi (cooldown ~6 jam), QuickNode (12 jam; drip dobel kalau share di X), Alchemy (24 jam; butuh aktivitas di Ethereum mainnet). Setiap faucet punya syarat aktivitas mainnet, jadi pakai wallet milikmu yang memenuhi syarat.

**Saldo yang harus ada di master wallet di depan** (diisi oleh `setup-bots --topup`, hanya selisihnya):

| Pos | Profil penuh | Profil hemat |
|---|---|---|
| Bot swarm | 20 × 0,2 = 4 MON | 10 × 0,15 = 1,5 MON |
| Agent | 1,5 MON | 1 MON |
| Operator (`settle`) | 0,5 MON | 0,3 MON |
| Budget `/fund` | 3 MON | 1,5 MON (`FUND_BUDGET_MON=1.5`) |
| Deploy | 0,5 MON | 0,5 MON |
| **Total** | **9,5 MON** (+20% cadangan ≈ 11 MON) | **4,8 MON** (+20% ≈ 6 MON) |

Sisa saldo bot ditarik kembali dengan `setup-bots --sweep`. Pilih profil di jam 16:45 sesuai saldo master saat itu.

**Pack berbayar** memakai saldo pemain sendiri (0,05 MON per tarikan, masuk treasury). Untuk demo, kamu membeli 1–2 pack dari burner-mu (sudah tercakup budget `/fund` 0,3 MON per alamat).

**Aturan reserve balance (sudah dicek di dokumen Monad):** wallet bersaldo di bawah 10 MON hanya boleh mengirim tx **bernilai** (`value > 0`) kalau itu tx pertamanya dalam 3 blok terakhir; kalau tidak, tx masuk blok tetapi revert dan tetap membayar gas. Dampaknya: master wallet (saat `/fund` dan `setup-bots`) dan burner pemain (saat `paidPull`) harus memberi jeda ≥ 3 blok sejak tx sebelumnya sebelum mengirim tx bernilai. Tx tanpa nilai (`attack`, `createDuel`, `settle`) tidak terdampak.

Jangan pakai smart account EIP-7702 untuk burner (saldo tidak boleh turun di bawah 10 MON karena aturan reserve balance).

---

## 10. Persiapan Malam Ini (23 Oktober)

1. **Cek aturan & syarat submission** (Luma/Telegram): boleh menyiapkan kode sebelum event? Repo harus publik? Wajib video? Alamat kontrak?
   * **Boleh boilerplate:** tulis `NadCards` + `BlitzArena` + test malam ini (hemat ~75 menit besok).
   * **Harus dari nol:** kerjakan poin 2–6 saja.
2. **Akun & key:** RPC berbayar Monad testnet (cek rps & dukungan `eth_getBlockReceipts`; RPC publik sudah terbukti mendukung), API Kimi/OpenAI (tes 1 panggilan), `cloudflared` (tes sekali: `cloudflared tunnel --url http://localhost:8080`, lalu buka URL-nya dari HP pakai data seluler, **termasuk koneksi WebSocket**; sudah lolos dari laptop dan dari HP pakai data seluler pada 23 Okt, lihat §13), repo GitHub.
3. **Testnet MON:** kumpulkan dari semua faucet di §9. **Target minimal ±6 MON (profil hemat), idealnya ±11 MON (profil penuh).**
4. **Tools:** `foundryup`, Node 20+, pnpm, `brew install cloudflared`; pastikan `forge --version` jalan.
5. **Non-kode:** finalkan persona AI Agent, nama & warna elemen, draf prompt (lore, pelatih, mulut), 3 slide pitch.
6. **Tidur minimal 6 jam.**

---

## 11. Timeline Besok (24 Oktober) — dua agent paralel

**Pembagian:** **Qwen Code** mengerjakan jalur backend (kontrak, `shared/`, server, agent, swarm). **Claude Code** (sesi baru di app Claude) mengerjakan jalur frontend (`web/` saja). Keduanya memakai subagent implementer + **reviewer penuh per task**. Aturan koordinasi ada di bagian "Pembagian Kerja" rencana implementasi. Frontend tidak lagi menunggu backend: sampai server siap, layar dibangun dengan mock yang mengikuti kontrak API yang sama.

| Jam | Backend · Qwen Code | Frontend · Claude Code | ✅ Checkpoint |
|---|---|---|---|
| 07:00–08:30 | Cek venue: latency wifi ke RPC, sinyal data seluler, colokan proyektor | | — |
| 08:30–09:15 | Workshop | | — |
| 09:15–09:40 | Task 1 `NadCards` (langkah pertama: `git init` + kerangka workspace root, commit) | Baca dokumen; mulai setelah commit kerangka workspace muncul | — |
| 09:40–10:20 | Task 2 `BlitzArena` | Task 11a: setup Vite + Tailwind + token + font + Nadmon | — |
| 10:20–10:45 | Task 3 deploy + `cast estimate` | Task 11b: komponen `TapButton`, `SkillButton`, `HpBar`, `LatencyBadge`, `GameCard` compact + halaman `/dev` | **A · 10:45: kontrak live di testnet** |
| 10:45–11:00 | Task 4 paket `shared/` | (lanjut 11b) | — |
| 11:00–11:45 | Task 5 server inti · Task 6 relay (sampai 11:45) | Task 11c: burner + `api` + mock + `txEngine` (memakai `@nad/shared`) | — |
| 11:45–12:20 | Task 7 `/fund` · Task 8 poller + WebSocket | Task 12a: layar Home, Pull, Play dengan mock | — |
| 12:20–12:45 | Task 9 kartu SVG + lore template | Task 12b: layar Duel dengan mock; mulai memakai server lokal (anvil) | — |
| 12:45–13:10 | Task 10 e2e + `setup-bots` + tunnel publik | Task 12c: integrasi ke server lokal | **B · 13:10: e2e lulus, `/config` terbuka lewat tunnel** |
| 13:10–13:20 | *Makan* | *Makan* | — |
| 13:20–13:45 | Task 13 AI Agent (otot + `/agent/challenge`) | Task 12d: integrasi testnet lewat tunnel, uji di 2 HP | **🚩 C · 13:45: PvP 2 HP jalan end-to-end di testnet**, lalu rekam **video aman** (±5 menit) |
| 13:50–14:15 | Task 14 pelatih + latihan anvil | Task 15w: layar proyektor `/arena` | — |
| 14:15–14:40 | Task 15s: swarm + route admin + `admin.sh` | UI mode AI Agent: tombol lawan agent, gelembung ejekan, panel pelajaran di `/arena` | — |
| 14:40–15:10 | Task 16 mulut + lore AI (dipotong pertama kalau terlambat) | Halaman kontrol `/control` (dipotong pertama kalau terlambat) | **D · 15:10: duel vs agent jalan, policy berubah setelah latihan, swarm tampil di `/arena`** |
| 15:10–15:35 | Task 15 lanjutan: `event.ts` (statistik event + leaderboard, idempoten) | Branding event, baris statistik, panel leaderboard di `/arena`; polish (foil, animasi) | Leaderboard tampil di `/arena` |
| 15:35–15:40 | Buffer | Buffer | — |
| 15:40–16:05 | Task 17: tes perangkat bersama (data seluler), perbaikan, **rekam video final** | ← sama | Video final tersimpan |
| 16:05–16:30 | Task 17: cek secret, README, submission | Task 17: build produksi `web/dist`, cek tampilan proyektor | **Submit sebelum 16:45** |
| 16:30–16:45 | *Buffer submission* | | — |
| 16:45–17:00 | Gladi run-sheet, `setup-bots --topup` sesuai profil §9, merge hasil latihan terakhir, **`admin.sh event-reset`** (supaya leaderboard dan statistik di proyektor hanya menghitung saat pitch), cadangkan agent, siapkan kartu demo unggul elemen | | — |

**Urutan pemangkasan kalau terlambat** (berlaku di checkpoint mana pun; potong dari atas):
0. Task 16 (ejekan + lore AI → lore template, agent tanpa ejekan), leaderboard event (→ statistik saja), tombol "Pull again" (fungsi `paidPull` tetap ada di kontrak), dan halaman kontrol `/control` (→ `admin.sh` lewat `curl`); animasi reveal gacha (→ kartu langsung tampil) dan ringkasan Result (→ hanya Victory/Defeat/Draw + link explorer).
1. Verifikasi kontrak di explorer (Task 3) dan pengukuran gas selain `attack` → pakai 300.000 untuk semua fungsi kecuali `attack` (`attack` tetap hasil ukur × 1,2). `createDuel`, `paidPull`, dan `settle` jauh lebih mahal dari `attack`, jadi `attack × 1,2` akan kehabisan gas.
2. `/fund` (Task 7) → diganti skrip `pnpm -F server fund <alamat>` yang kamu jalankan manual saat juri mau main.
3. Swarm dikecilkan ke 3 pasang × 2 ronde.
4. Pelatih LLM → pelatih berbasis aturan saja (agent tetap belajar, pelajaran dari template).
5. Swarm dibuang total (narasi paralel cukup dari duel live + penjelasan state per duel).

**Tidak pernah dipotong:** kontrak, PvP, otot AI Agent, video aman, submission.

**Cara rekam (tanpa editing):** `Cmd+Shift+5`, satu take, dua jendela browser berdampingan di laptop: kiri `/duel/:id` dengan mode tampilan HP di DevTools (tap pakai klik), kanan `/arena`. Kalau form submission mewajibkan video, upload (YouTube unlisted / Google Drive) di blok 16:05–16:30.

**Titik keputusan:**
| Checkpoint | Terlambat > 15 menit | Terlambat > 30 menit |
|---|---|---|
| A · 10:45 | Potong poin 0–1 | Potong poin 0–2 |
| B · 13:10 | Potong poin 0–2 | Potong poin 0–3, makan sambil kerja |
| 🚩 C · 13:45 | Potong poin 0–3 | Potong poin 0–4 |
| D · 15:10 | Potong poin 0–4 | Potong poin 0–5; `/arena` hanya duel utama |

---

## 12. Demo & Pitch (3 menit)

**Sebelum naik panggung:** kartumu sudah di-pull, server sudah memuat `agent.json` hasil latihan terakhir, laptop dicolok ke charger dan `caffeinate` aktif, swarm siap, saldo terisi, video cadangan terbuka di tab lain.

| Waktu | Isi |
|---|---|
| 0:00–0:20 | Hook: *"Game kartu onchain biasanya berbasis giliran karena chain-nya lambat. Di Monad, tidak harus begitu."* |
| 0:20–0:40 | Kartumu: stat onchain, lore AI, rekam menang/kalah |
| 0:40–1:10 | **Duel live vs AI Agent** (agent sudah dicadangkan untuk burner-mu) — narasikan badge latency (dan ejekan agent, kalau Task 16 bonus sempat dikerjakan). **Nyalakan swarm di sini** (`pairs`/`rounds` sesuai profil §9) |
| 1:10–1:30 | Pelajaran baru AI Agent muncul di proyektor, threshold berubah |
| 1:30–2:15 | *"N duel paralel, X tx/dtk"* — state antar duel independen, dan Monad menghitung konflik per slot → benar-benar paralel. Satu duel = 3 slot berurutan → MIP-8 membuat setiap tap lebih murah (sebut angka hasil ukur sendiri) |
| 2:15–3:00 | 4 keputusan khas Monad (§4.3: clamp · `gasLimit` ketat · attack/settle · block watcher) → model bisnis (tunjuk treasury, leaderboard, statistik di proyektor) → roadmap → *"Silakan coba melawan AI Agent di HP Bapak/Ibu."* |

**Sesi tanya-jawab:** nyalakan `/fund` dan lepas cadangan agent, lalu juri scan QR dan duel PvP melawanmu atau melawan AI Agent.

**Bahasa di pitch:** "blok ~300ms, finalitas di bawah 1 detik", "onboarding di bawah 10 detik", "pseudo-random untuk testnet". Duel dengan taruhan boleh disebut sebagai roadmap; di demo tidak ada fitur taruhan.

**Roadmap (disebut, tidak dibangun):** duel dengan taruhan (PvP stakes, pemenang mengambil pot, fee 5% ke treasury), kontrak escrow hadiah turnamen dari dana sponsor, tarikan dari kemenangan (season pass), VRF, identitas agent ERC-8004, marketplace kartu sendiri, RL sungguhan untuk agent.

**Model bisnis (untuk slide pitch):**

| # | Model | Status di demo |
|---|---|---|
| 1 | **Pack berbayar**: tarikan pertama gratis, berikutnya 0.05 MON, peluang ditampilkan dan diacak onchain | ✅ Jalan (`paidPull`, treasury terlihat di proyektor) |
| 2 | **Royalti marketplace 5%** setiap kartu diperdagangkan; kartu dengan rekor menang tinggi bernilai lebih. **Pendapatan tambahan, bukan utama:** ERC-2981 hanya permintaan yang boleh diabaikan marketplace; jaminan penuh butuh marketplace sendiri (roadmap) | ✅ Ada di kontrak (ERC-2981) |
| 3 | **Duel dengan taruhan**: pot pemenang, fee 5% | Roadmap |
| 4 | **Arena event bersponsor (B2B)**: penyelenggara dan sponsor membayar untuk arena bermerek, leaderboard, dan laporan statistik | ✅ Jalan (demo ini sendiri: branding, leaderboard, statistik di proyektor) |

**Pendapatan utama:** model 1 (uang pack masuk langsung ke kontrak) dan model 4 (penyelenggara membayar di muka). **Struktur biaya:** gas mint tarikan berbayar dibayar pemain; biaya terbesar kita adalah subsidi gas pemain gratis (tarikan pertama dan duel, ±20 tx per pemain per duel) dan panggilan AI untuk lore, yang idealnya ditanggung sponsor event. Di testnet treasury tidak bernilai uang; ia membuktikan mekanismenya. Di pitch sebut struktur ini, bukan angka profit.

Kalimat pitch: *"Tonight's demo is the product: a plug-and-play onchain arena for any event. Treasury, leaderboard and player count on the screen are live from Monad."* Peluang rarity selalu ditampilkan; pasar peluncuran dipilih sesuai aturan loot box setempat.

---

## 13. Fakta Teknis yang Sudah Diverifikasi

| Pertanyaan | Jawaban | Sumber | Dampak ke desain |
|---|---|---|---|
| Deteksi konflik parallel execution: per slot atau per page? | **Per slot.** FAQ Monad: *"all state contention is evaluated on a slot-by-slot basis"* | docs.monad.xyz/faq | Duel yang bersebelahan di array **tidak** saling konflik. Tidak perlu jarak antar duel |
| `block.prevrandao` di testnet berguna? | **Ya.** `mixHash` di 4 blok berturut-turut selalu berbeda (dicek lewat RPC) | Uji langsung `eth_getBlockByNumber` | Dipakai untuk keacakan `freePull` |
| MIP-8 aktif di testnet? | **Ya, sejak 12 Agustus 2026 14:30 UTC** (v0.16.0, MONAD_TEN). Mainnet sejak 2 September 2026 | Changelog testnet Monad | Cerita `getDuels()` hemat berlaku di testnet. Ukur sendiri dengan `cast estimate` untuk angka di pitch |
| Testnet MON | Faucet ~1 MON per wallet per hari | Halaman faucet Alchemy, QuickNode, panduan Backpack | Budget dipangkas (§9) |

**Temuan tambahan dari uji RPC:**
* RPC publik testnet yang benar: **`https://testnet-rpc.monad.xyz`** (chainId `0x279f` = 10143). URL `rpc.testnet.monad.xyz` di blueprint v1 **tidak merespons**.
* `eth_getBlockReceipts` didukung RPC publik.
* **Beberapa blok berturut-turut punya `timestamp` yang sama** (resolusi 1 detik, sementara blok ~300ms). Ini mengonfirmasi bahwa semua timing di kontrak harus memakai `block.number`, bukan `block.timestamp`.
* Nomor blok saat ini ±73,5 juta, masih jauh di bawah batas `uint32` (±4,29 miliar).

**Uji Cloudflare Quick Tunnel (23 Okt, 22:39 WIB, `cloudflared` 2026.10.3):**
* Tunnel tersambung lewat edge Singapura (`sin15`) dengan protokol QUIC.
* HTTP 200 lewat tunnel (request pertama ±1 dtk, termasuk DNS hostname baru).
* **WebSocket berfungsi:** 10 ping-pong echo, RTT 59–73 ms. Dikonfirmasi juga dari HP pakai data seluler. Desain broadcast WebSocket (D3) aman dipakai lewat tunnel.

---

## 14. Risiko Utama

| Risiko | Mitigasi |
|---|---|
| PvP belum jalan di checkpoint C (13:45) | Urutan pemangkasan dan tabel titik keputusan §11 |
| MON tidak cukup | Latihan di anvil; semua faucet malam ini; profil hemat di §9 (`BATCH_MS` 2.000, swarm 5 pasang × 3 ronde) |
| Pengunjung menguras saldo atau menyibukkan agent lewat URL publik | `/fund` mati secara default; ledger fund persisten; agent dicadangkan saat pitch; batas per IP & per pengirim di `/relay` |
| Rate limit RPC | Relay + block watcher + RPC cadangan; ukuran swarm mengikuti paket |
| Wifi venue | Data seluler, hotspot, video cadangan |
| LLM lambat/gagal | Semua jalur AI punya fallback; game tidak bergantung pada AI |
| Agent terlalu kuat di panggung | Kartu demo unggul elemen; kalah pun tetap memunculkan pelajaran baru |
| Laptop sleep atau internet laptop putus | `caffeinate -dis` selama server hidup, laptop dicolok ke charger, hotspot HP sebagai cadangan internet laptop, video cadangan |
| URL tunnel berubah | Jangan matikan `cloudflared` setelah 11:15; kalau terpaksa, perbarui `PUBLIC_URL` + `setBaseURI`. QR memakai alamat halaman yang sedang dibuka (`location.origin`), jadi tidak perlu build ulang |
| Tunnel mati atau diblokir jaringan venue | Quick Tunnel tidak punya jaminan uptime (batas 200 request bersamaan). Kalau QUIC/UDP diblokir: `cloudflared tunnel --protocol http2 --url …`. Darurat: HP dan laptop di wifi yang sama, buka `http://<IP-laptop>:8080` (game tetap jalan, Wake Lock nonaktif karena bukan HTTPS) |

---

## 15. Sumber

* Monad docs — FAQ (konflik dihitung per slot): https://docs.monad.xyz/faq
* Monad docs — changelog testnet (MIP-8 aktif 12 Agustus 2026): https://docs.monad.xyz/developer-essentials/changelog/testnet.md
* Faucet: Alchemy https://www.alchemy.com/faucets/monad-testnet · QuickNode https://faucet.quicknode.com/monad · panduan Backpack https://learn.backpack.exchange/zh-tw/articles/monad-faucet
* Monad docs — current facts: https://docs.monad.xyz/ai/current-facts
* Monad docs — gas pricing (biaya dari gas limit): https://docs.monad.xyz/developer-essentials/gas-pricing
* Monad docs — gas on Monad: https://docs.monad.xyz/developer-essentials/gas-on-monad
* Monad docs — reserve balance: https://docs.monad.xyz/developer-essentials/reserve-balance
* Monad docs — carriage cost & reserve balance: https://docs.monad.xyz/technical-discussion/consensus/carriage-cost-and-reserve-balance
* Monad docs — deployment summary: https://docs.monad.xyz/developer-essentials/summary
* Monad docs — testnet (RPC & rate limit): https://docs.monad.xyz/developer-essentials/testnet
* Monad docs — build with NFTs: https://docs.monad.xyz/guides/build-with-nfts
* Block time 300ms / finalitas 600ms: https://yespress.io/monad
* MIP-8 live di mainnet: https://cryptoslate.com/monads-mainnet-upgrade-makes-storing-data-together-98-cheaper/
* Monad blog — home for builders (statistik hackathon 2026): https://monad.xyz/blog/home-for-builders
* Monad ecosystem highlights July 2026: https://monad.xyz/blog/monad-ecosystem-highlights-july-2026
* Bankless — culture apps on Monad: https://www.bankless.com/read/culture-apps-on-monad
* Monad Blitz Ankara v3 (voting audiens): https://luma.com/blitz-ankara-27-Jun
* Referensi game AI-card: AI Sentinels https://ethglobal.com/showcase/ai-sentinels-dehgp · Abyss https://abysscards.notion.site/Abyss-by-Taste-Foundation-1bb99607873780da85a3fc58d7470262 · Neural Deck https://www.moddb.com/games/neural-deck
* MegaETH real-time apps (pembanding narasi): https://www.megaeth.com/blog-news/omega-projects-only-possible-on-megaeth
