# NadGacha: BlitzArena — Konteks Proyek untuk Qwen Code

Proyek hackathon **Monad Blitz Jogja Vol. 2** (Sabtu, 24 Oktober 2026). Build 09:15–16:30 WIB, submission sebelum 16:45, pitching 17:00. Solo builder dengan **dua agent paralel**. Komunikasi dengan user dalam **Bahasa Indonesia**.

> **WAJIB DIBACA PERTAMA: `docs/ADDENDUM-2026-10-24.md`** (rubrik juri, pemangkasan, pekerjaan baru N1–N8, timeline baru mulai 10:30). Addendum menang atas rencana dan spec.

## Peranmu: jalur BACKEND

- Kamu (Qwen Code) mengerjakan **Task 1–10, 13, 14, 15s (server: `swarm.ts`, `admin.ts`, `admin.sh`), 16, dan bagian backend Task 17** (cek secret, README).
- **Folder milikmu:** `contracts/`, `shared/`, `server/`, `deployments/`, dan file root (`package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.gitignore`, `.env.example`).
- **Jangan pernah menyentuh `web/`.** Frontend dikerjakan Claude Code di sesi terpisah pada saat yang sama. Lewati Task 11, 12, dan 15w.
- **Langkah pertamamu (Task 1 Step 1):** `git init`, kerangka workspace root, `.gitignore`, lalu commit `chore: workspace skeleton` dalam ±5 menit **bersama semua dokumen yang sudah ada** (`blueprint_*.md`, `docs/`, `QWEN.md`, `CLAUDE.md`). Frontend menunggu commit ini.
- Commit hanya folder milikmu (`git add contracts shared server deployments` + file root), **tidak pernah `git add -A`**.
- **Kontrak antarmuka dibekukan:** bagian "Kontrak Antarmuka Bersama" di rencana dan ekspor `@nad/shared` (Interfaces Task 4). Kalau perlu mengubahnya, berhenti dan tanya user, karena frontend sudah membangun di atasnya.
- Setelah Task 4, Task 8 (server dev jalan), Task 9 (kartu SVG), checkpoint B, Task 13, dan Task 15s selesai, **beri tahu user** dalam satu kalimat supaya diteruskan ke frontend (titik serah-terima, aturan 5 "Pembagian Kerja").

## Dokumen sumber kebenaran

| File | Isi | Aturan |
|---|---|---|
| `blueprint_v2_nadgacha_blitzarena.md` | Spec final (desain game, kontrak, server, client, budget MON, timeline, pitch) | **Sumber kebenaran.** Kalau ada konflik dengan file lain, ikuti ini — **kecuali** penyimpangan yang dinyatakan eksplisit di kepala rencana (skrip di `server/scripts/`, paket `shared/`); penyimpangan itu yang berlaku |
| `docs/superpowers/plans/2026-10-24-nadgacha-blitzarena.md` | Rencana implementasi: 17 task, Global Constraints, Review Focus, kontrak antarmuka bersama | Kerjakan task **berurutan**; nama fungsi, tipe, dan nilai harus persis seperti di rencana |
| `docs/design-system/` | Design system "Monad-native bersih": `tokens.json`, `tokens.css`, `tailwind.theme.cjs`, brand book `README.md`, dan `components/<Comp>/README.md` + `preview.html` | Wajib dibaca untuk Task 9 (SVG kartu server): warna dari `tokens.json` lewat `resolveTokenHex`, layout dari `components/GameCard/README.md`. Jangan menulis hex langsung |
| `blueprint_hackathon_nadgacha_blitzarena.md` | Blueprint v1 (arsip) | **Jangan diubah dan jangan dihapus.** Banyak isinya sudah dibatalkan di v2 |

## Cara eksekusi

1. Baca kepala rencana + **Global Constraints** + **Kontrak Antarmuka Bersama** sebelum menyentuh kode.
2. Jalankan skill `superpowers:subagent-driven-development` pada rencana **hanya untuk task jalur backend**: satu subagent implementer per task (tool `agent`), lalu satu reviewer per task, review menyeluruh di akhir.
3. Setiap task: test dulu (harus gagal) → implementasi → test lulus → commit. Jangan lompat ke task berikutnya kalau test task ini belum lulus.
4. **Reviewer penuh untuk setiap task — tidak ada peralihan ke eksekusi tanpa reviewer.** Kalau terlambat, potong **fitur** mengikuti urutan pemangkasan dan tabel titik keputusan di spec §11: checkpoint **A 12:00** (kontrak live + verified), **B 14:25** (e2e + live di VPS), **🚩 C 14:45** (PvP di 2 HP, bersama frontend), **D 15:40** (agent belajar + swarm). Task 16 sudah dipotong (addendum).
5. Kalau ingin menyimpang dari Global Constraints atau spec, **tanya user dulu**.

## Keputusan yang sudah final (jangan diubah tanpa izin user)

- Format: duel **1v1** (PvP dua HP, atau melawan AI Agent). Tidak ada boss raid, tidak ada demo 50 penonton.
- Nama NPC di UI: **"AI Agent"** (bukan nama persona lain).
- Hosting: server jalan di **VPS user** (`ssh 0xAlvary3`) lewat pm2 (`nadgacha`, `PORT=8090`) di belakang nginx + HTTPS yang sudah disiapkan: **`https://nadgacha.43-134-58-217.sslip.io`** (addendum N5). Jangan mengubah aplikasi lain di VPS. Tidak memakai Railway/Vercel/Docker/cloudflared. Data di folder `data/` di VPS.
- Wallet: burner wallet di `localStorage`. Tidak ada Dynamic/Privy/ZeroDev/Gelato VRF/Envio.
- Kartu: **layout TCG + roster Nadmon original** (9 SVG di `docs/design-system/assets/Nadmon/`, spesies dari elemen + rarity lewat `nadmonFor`). Jangan memakai karakter komunitas Monad, wajah KOL, atau ciri merek Pokémon.
- **Semua teks yang dilihat pemain dan juri dalam bahasa Inggris** (UI, kartu SVG, lore, gelar, ejekan, pelajaran agent, pesan error, template fallback). Elemen: Fire / Water / Lightning. Komunikasi dengan user tetap Bahasa Indonesia.
- Visual: **Monad-native bersih** — latar terang, satu warna aksi ungu (`purple`), lawan `berry`, garis bukan bayangan, angka mono. Tanpa gradien, glow, emoji, atau logo Monad — kecuali kilau foil Legendary (satu-satunya gradien). Kartu full = SVG dari server ditampilkan lewat `<img>`; React hanya `GameCard` compact. Warna token tidak bisa dipakai dengan modifier opacity Tailwind (`/40`).
- **Model bisnis yang dibangun:** `paidPull()` payable (`PULL_PRICE = 0.05 ether`, uang tinggal di `NadCards` sebagai treasury, `withdraw` owner), royalti ERC-2981 5%, dan mode event (`EVENT_NAME`/`EVENT_SPONSOR`, `server/src/event.ts`: pemain unik, total duel, treasury, leaderboard top 10). **Duel dengan taruhan hanya roadmap: `BlitzArena` tidak boleh punya fungsi `payable`.** Relay hanya menerima `value > 0` untuk `paidPull` dengan nilai tepat `pullPrice`.
- Latihan AI Agent di **anvil lokal** (`server/scripts/train.ts`), bukan di testnet.

## Fakta lingkungan (sudah diverifikasi 23 Okt)

- Tools terpasang: Foundry 1.7.1, Node 22, pnpm, `cloudflared` 2026.10.3. Folder ini **belum repo git** (Task 1 menjalankan `git init`).
- Monad testnet: chainId `10143`, RPC publik `https://testnet-rpc.monad.xyz` (URL `rpc.testnet.monad.xyz` dari v1 **mati**), explorer `https://testnet.monadscan.com`, gas price ±102 gwei, block time ±300 ms, `timestamp` beresolusi 1 detik.
- Verifikasi kontrak: `forge verify-contract … --chain 10143 --verifier sourcify --verifier-url https://sourcify-api-monad.blockvision.org/` (tanpa API key).
- Quick Tunnel: HTTP dan WebSocket sudah terbukti jalan dari laptop dan dari HP pakai data seluler (RTT ±60 ms, edge Singapura).

## Jebakan yang sudah ditemukan saat review (wajib diingat)

1. **Solidity 0.8 checked arithmetic:** `uint16 × uint16` overflow → revert. Cast ke `uint256` sebelum menghitung damage; pengurangan HP harus jenuh.
2. **Monad menagih dari `gasLimit`, bukan gas terpakai.** Clamp, jangan revert. `attack()` tidak boleh memanggil kontrak lain (pencatatan menang/kalah ada di `settle()`).
3. **`gasLimit` diukur dengan `cast estimate` di testnet**, bukan `forge test --gas-report` (Foundry memakai harga gas Ethereum).
4. **viem `waitForTransactionReceipt` default polling 4 detik.** Jangan dipakai per tx; receipt diambil block watcher lewat `eth_getBlockReceipts` sekali per blok.
5. **`forge script --broadcast` menggantung kalau anvil automine mati.** Skrip e2e/train deploy lewat viem + `anvil_mine`.
6. **Semua timing pakai `block.number`**, tidak pernah `block.timestamp`.
7. **Kirim ulang tx = raw tx yang sama persis** (hash sama), jangan tanda tangan ulang dengan nonce baru.
8. **Tidak ada secret berawalan `VITE_`.** Semua private key hanya di `.env` server.
9. `getDuels()` adalah `view` (gratis). Klaim MIP-8 di pitch: **setiap tap jadi lebih murah** (3 slot berurutan per duel), bukan "getDuels jadi murah".
10. **Route Hono `/card/:id.svg` rusak** (ikut menangkap `/card/5`, `id` = `undefined`; sudah dibuktikan). Pakai `/card/:id{[0-9]+}` dan `/card/:id{[0-9]+}/image.svg`.
11. **`forge init --no-commit` ditolak Foundry 1.7.1.** Pakai `forge init contracts --no-git`.
12. **`pnpm -F server …` berjalan dengan cwd `server/`**, sedangkan `serve.sh` dari root. Semua path di-resolve dari root repo, `.env` dibaca dari root. `pnpm -F <paket>` juga diam saja (exit 0) kalau paketnya belum ada.
13. **Receipt hub: daftarkan penunggu sebelum `sendRawTransaction`** dan simpan receipt ±200 blok terakhir. Dengan blok 300 ms, receipt bisa datang sebelum penunggu terdaftar.
14. **Nonce wallet server hanya naik setelah kirim berhasil**; setelah error apa pun, sinkronkan ulang dari chain.
15. **Anvil selalu `--chain-id 10143`**; e2e/train menyalakan anvil sendiri di port 8546.
16. **`"packageManager": "pnpm@12.10.1"`** (versi terpasang). `pnpm@9` membuat semua perintah pnpm gagal. Bootstrap juga membuat **stub `shared/`** supaya install di `web/` tidak gagal sebelum Task 4.
17. **Reserve balance Monad:** wallet bersaldo < 10 MON hanya boleh mengirim tx **bernilai** kalau itu tx pertamanya dalam 3 blok terakhir; kalau tidak, revert dan tetap bayar gas. Antrean wallet menunggu ≥ 3 blok sebelum tx bernilai (`/fund`, `setup-bots`, `estimate.sh` sebelum `paidPull`).
18. **Gas fallback:** kalau pengukuran dipotong, pakai 300.000 untuk semua fungsi kecuali `attack`.
19. **`event.ts` harus idempoten:** poller melihat duel yang sama setiap blok; simpan ID duel yang sudah dihitung.
20. **Server dev untuk frontend:** setelah Task 8, jalankan `pnpm -F server dev` terhubung ke testnet di port 8080 dengan `FUND_ENABLED=true`, lalu beri tahu user. Di Task 10, beri tahu user sebelum menggantinya dengan `serve.sh`. `pnpm-lock.yaml` milikmu: commit di Task 4 dan setiap checkpoint.
21. **Saldo baru belum terlihat ±3 blok (addendum N9):** wallet yang baru diisi menunggu ≥ 3 blok setelah receipt pengisian sebelum tx pertamanya (`setup-bots`, `estimate.sh`, e2e di testnet). Tap `attack` per 1 dtk dari wallet bersaldo kecil aman.
22. **Block time terukur 305 ms (testnet) dan 302 ms (mainnet)**, base fee minimum 100 gwei. Angka "400 ms" di MONSKILLS sudah usang; MONSKILLS hanya referensi, rencana dan addendum yang berlaku.
