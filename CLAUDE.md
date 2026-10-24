# NadGacha: BlitzArena — Konteks Proyek untuk Claude Code

Proyek hackathon **Monad Blitz Jogja Vol. 2** (Sabtu, 24 Oktober 2026). Build 09:15–16:30 WIB, submission sebelum 16:45, pitching 17:00. Solo builder dengan **dua agent paralel**. Komunikasi dengan user dalam **Bahasa Indonesia**.

> **WAJIB DIBACA PERTAMA: `docs/ADDENDUM-2026-10-24.md`** (rubrik juri, pemangkasan, pekerjaan baru N1–N8, timeline baru mulai 10:30). Addendum menang atas rencana dan spec.

## Peranmu: jalur FRONTEND

Sesi Claude Code di proyek ini mengerjakan **jalur frontend**, kecuali user secara eksplisit meminta hal lain (misalnya review dokumen).

- Kamu mengerjakan **Task 11 (11a setup, 11b komponen, 11c data), Task 12 (12a–12d layar pemain), Task 15w (`/arena`), UI mode AI Agent, link explorer (addendum N2), dan bagian frontend Task 17** (build `web/dist`, tes perangkat dan video bersama user). **`/control` dan panel leaderboard dipotong (addendum).**
- **Folder milikmu: `web/` saja.** Jangan pernah mengedit `contracts/`, `shared/`, `server/`, `deployments/`, atau file root. Semua itu milik jalur backend (Qwen Code, lihat `QWEN.md`) yang berjalan bersamaan.
- **Mulai menulis file setelah commit `chore: workspace skeleton` muncul di `git log`.** Sebelum itu, baca dokumen.
- Commit hanya `git add web/`, **tidak pernah `git add -A`**. Prefix `feat(web)`.
- **Kontrak antarmuka dibekukan:** bagian "Kontrak Antarmuka Bersama" di rencana (HTTP API, pesan WebSocket) dan ekspor `@nad/shared` (Interfaces Task 4). Bangun persis di atasnya. Kalau butuh perubahan, berhenti dan tanya user.

## Dokumen sumber kebenaran

| File | Isi |
|---|---|
| `blueprint_v2_nadgacha_blitzarena.md` | Spec final. Untuk frontend, baca §2 (desain game), §6 (client), §11 (timeline dua jalur), §12 (pitch). |
| `docs/superpowers/plans/2026-10-24-nadgacha-blitzarena.md` | Rencana: bagian **Pembagian Kerja**, **Global Constraints**, **Kontrak Antarmuka Bersama**, lalu Task 11, 12, 15 (bagian web). |
| `docs/design-system/` | **Wajib dibaca sebelum menulis UI:** `README.md` (brand book), `tokens.css`, `tailwind.theme.cjs`, `components/<Comp>/README.md` + `preview.html`, `assets/Nadmon/`. |
| `blueprint_hackathon_nadgacha_blitzarena.md` | Arsip v1. Jangan dibaca sebagai acuan, jangan diubah. |

## Cara eksekusi

1. Baca kepala rencana, Pembagian Kerja, Global Constraints, Kontrak Antarmuka Bersama, dan brand book design system.
2. Jalankan `superpowers:subagent-driven-development` **hanya untuk task jalur frontend**: satu subagent implementer per task, lalu **reviewer penuh per task**, review menyeluruh di akhir.
3. Test dulu untuk logika (`txEngine`, `friendlyError`, mock), lalu implementasi, lalu commit. UI diverifikasi lewat rute `/dev` dan di browser.
4. Jadwal dan checkpoint ada di **timeline addendum**. **🚩 C 14:45: PvP di 2 HP jalan di testnet** lewat `https://nadgacha.43-134-58-217.sslip.io` (bersama backend). Kalau terlambat, potong fitur sesuai urutan pemangkasan addendum.

## Ketergantungan dan penggantinya

- **`@nad/shared`** baru tersedia ±11:00 (Task 4 backend). Sebelum itu kerjakan setup (11a) dan komponen (11b), yang tidak butuh rumus.
- **Server** baru tersedia ±13:35 (Task 8, timeline addendum). Sampai saat itu pakai **mock** (`web/src/mock/`, `VITE_USE_MOCK=1`) yang meniru persis tabel HTTP API dan `WsMessage`. Setelah user mengabarkan Task 8 selesai, arahkan dev ke server dev lokal (port 8080, terhubung testnet). Untuk uji HP, backend me-rsync `web/dist` hasil build-mu ke VPS (`https://nadgacha.43-134-58-217.sslip.io`).
- **Proxy Vite:** `/config`, `/account`, `/fund`, `/relay`, `/card`, `/agent`, `^/admin/` (regex: hanya API admin, supaya tidak menelan halaman), `/ws` (dengan `ws: true`) → `http://localhost:8080`. Halaman kontrol web bernama `/control`.
- **`@nad/shared`** dipakai langsung dari source TypeScript. Tambah dependency hanya dengan `pnpm -F @nad/web add <pkg>`; **jangan pernah meng-commit `pnpm-lock.yaml`** (milik backend) dan jangan menjalankan install bersamaan dengan backend.
- Mulai ±12:20 server dev backend jalan di laptop yang sama, terhubung ke testnet, di port 8080. Tidak ada fase anvil untukmu. Selama mock, `<img>` kartu memakai placeholder `web/public/mock/card.svg`.
- User akan meneruskan kabar dari backend: Task 4 selesai, Task 8 selesai, checkpoint B, Task 13 selesai, Task 15s selesai.

## Keputusan yang sudah final (jangan diubah tanpa izin user)

- Duel **1v1**: PvP dua HP atau melawan "AI Agent" (nama di UI persis begitu).
- Burner wallet di `localStorage` (`nad.burner`). Tanpa Dynamic/Privy/ZeroDev.
- Visual **Monad-native bersih** dari `docs/design-system/`: tema light di HP, dark di `/arena`. Satu warna aksi `purple` untuk pemain, `berry` untuk lawan. Garis, bukan bayangan. Angka dalam font mono. Tanpa gradien, glow, emoji, atau logo Monad, **kecuali** kilau foil Legendary.
- Kartu: layout TCG + roster **Nadmon** original. **Kartu full = `<img src="/card/:id/image.svg">` dari server**; React hanya membuat `GameCard` compact. Overlay foil CSS di atas `<img>` untuk Legendary.
- **Semua teks UI dalam bahasa Inggris** (aturan "Konten" di brand book): elemen Fire / Water / Lightning, hasil "Victory / Defeat / Draw", angka koma ribuan (`1,950`). Komunikasi dengan user tetap Bahasa Indonesia.
- **Alur pemain** mengikuti spec §6.1 dan rute di Task 12: Home (tabel peluang) → reveal gacha → Play → Fight AI Agent / Challenge a friend (ruang tunggu, konfirmasi join) → Duel → Result (ringkasan, rekor, pelajaran agent, Rematch).
- **Model bisnis di UI:** tombol sekunder "Pull again · 0.05 MON" di Play (`paidPull` dengan `value = pullPrice` dari `/config`), dan mode event di `/arena`: nama event + "Presented by {sponsor}" dari `/config.event`, baris statistik (players · duels · onchain tx · Treasury), panel leaderboard dari pesan WebSocket `leaderboard`.
- QR dan link duel memakai `location.origin`. Tidak ada secret berawalan `VITE_`.

## Jebakan frontend (sudah ditemukan saat review)

1. **Warna token adalah variabel CSS:** modifier opacity Tailwind (`bg-berry/40`) **tidak menghasilkan CSS**. Pakai elemen terpisah dengan `opacity-40`.
2. **Radius bernama `rounded-chip`, `rounded-card`, `rounded-tap`.** `rounded-md`/`rounded-lg` tetap default Tailwind.
3. **`tailwind.config.cjs` (CommonJS)** dengan `content: ['./index.html', './src/**/*.{ts,tsx}']` dan `theme: { extend: require('../docs/design-system/tailwind.theme.cjs') }`.
4. **Tap pakai `pointerdown` + `touch-action: manipulation`.** `navigator.vibrate(10)` per tap hanya efektif di Android. Screen shake **hanya saat skill dipakai**.
5. **1 tx in-flight per pemain**, jarak minimal `batchMs`. Batas tap dicerminkan dari `blockNumber` receipt terakhir (basis yang sama dengan `lastBlock` kontrak). Flush di `endBlock − 3`, tidak mengirim pada blok ≥ `endBlock − 2`. Tombol tap nonaktif selama countdown.
6. **Relay timeout 5 dtk → kirim ulang raw tx yang sama persis**, jangan tanda tangan ulang. `maxFeePerGas = 2 × gasPrice`, `maxPriorityFeePerGas = 2 gwei`, `gas` dari `/config`.
7. **`HpBar` menerima `hp` = nilai chain** dan `pendingDamage`. Pengurangan hanya di dalam `HpBar`, jangan dikurangi dua kali.
8. **WebSocket:** HP memakai `scope=duel:<id>`, proyektor dan admin `scope=all`. Reconnect dengan backoff 0,5 → 8 dtk, lalu snapshot penuh.
9. **Pemain yang kembali:** `GET /account/:address` mengembalikan `cardId`. Kalau tidak null, langsung ke `/play`.
10. **Layar QR menulis "Open this link in your browser"**, karena in-app browser aplikasi QR punya `localStorage` terpisah. Wake Lock saat duel.
11. **Reserve balance Monad:** burner (saldo < 10 MON) hanya boleh mengirim tx **bernilai** (`paidPull`) kalau itu tx pertamanya dalam 3 blok terakhir. Nonaktifkan "Pull again" sampai ≥ 3 blok sejak tx terakhir; kalau tetap revert, tampilkan pesan dari `friendlyError`.
12. **Receipt tidak membawa alasan revert.** `friendlyError` menyimpulkan pesan dari konteks (fungsi yang dipanggil + status duel di WebSocket), bukan dari nama error kontrak.
13. **Data dari `/config`:** `agent` (alamat AI Agent, untuk label "AI Agent" dan layar Result), `bots` (untuk membedakan duel bot), `pullPrice` (wei), `event`. `stats.treasury` dalam wei → tampilkan dengan `formatEther`, 2 desimal.
14. **Saldo baru belum terlihat ±3 blok (addendum N9):** setelah receipt `/fund`, tunggu ≥ 3 blok (±1 dtk) sebelum tx pertama burner (`freePull`/`createDuel`/`joinDuel`); kalau tidak, tx tertahan. Tap `attack` per 1 dtk aman.
15. **Link explorer (N2):** HUD/badge latency menautkan `lastTxHash` ke `https://testnet.monadscan.com/tx/<hash>`; `/arena` menampilkan alamat kontrak + tx terbaru dengan link. Bukti "live tx" untuk juri.
16. **Panel leaderboard** disembunyikan kalau pesan `leaderboard` tidak pernah datang; angka statistik bernilai 0 disembunyikan.
