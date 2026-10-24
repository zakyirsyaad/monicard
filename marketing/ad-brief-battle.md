# Brief revisi video iklan: Monicard Card Battle (menggantikan versi "tap")

Produk sekarang: **duel kartu bergiliran best-of-3 ala Pokémon TCG Pocket, setiap langkah adalah transaksi onchain di Monad.** Mode tap-tap masih ada, tapi hanya mode kedua ("Tap Blitz"). **Video iklan harus memakai Card Battle sebagai bintang.** Format vertikal 1080×1920, 15–22 detik, tanpa audio wajib.

## Fakta yang BENAR (jangan keluar dari ini)
- Kartu PvP dibuat acak **onchain** saat ditarik. **Tidak berhubungan dengan NFT yang dimiliki.** Siapa pun bisa main tanpa wallet atau seed phrase (burner otomatis).
- Tiap pemain punya **tumpukan tertutup 10 kartu**. Setiap giliran **satu kartu acak ditarik ke tangan**. Tangan boleh menumpuk banyak.
- **Papan 3 slot.** Kartu di papan menyerang **1 kartu depan lawan** bersamaan. Damage dijumlahkan, dengan keunggulan elemen **×1.5** (Water > Fire > Lightning > Water), **×0.75** kalau kalah elemen.
- **Special:** sekali per match, menggandakan damage.
- **KO kartu lawan = 1 poin. Dua KO menang match.**
- **Satu giliran = satu transaksi** (±0,01 MON). Blok Monad ±300 ms, jadi papan bergerak secepat chain.
- **AI Agent** lawan yang belajar dari setiap duel (level naik, pelajaran tertulis tampil).
- Banyak match berjalan **paralel** (swarm bot di layar proyektor `/arena`).
- Live di **Monad testnet**. URL: **monicard.xyz**.
- Jangan menulis: "tap" sebagai mekanik utama, "bet", "wager", "gamble", klaim yang belum terbukti (mainnet sebelum ter-deploy, angka latensi yang belum diukur).

## Alur adegan (±20 dtk)
| # | Durasi | Visual | Teks di layar (Inggris) |
|---|---|---|---|
| 1 | 0–3 dtk | Tumpukan kartu tertutup (punggung kartu Monicard) di tengah, blok berjalan di pojok (`block #73,7xx,xxx`) | **Every move is a transaction.** (kicker: MONICARD) |
| 2 | 3–7 dtk | Kartu ditarik dari tumpukan ke tangan di bawah, flip, lencana **NEW**, Nadmon Legendary muncul dengan foil | **Draw a card. Every turn.** |
| 3 | 7–11 dtk | Kartu di tangan diketuk, meluncur ke slot papan 3-slot. Dua kartu lain tetap di tangan | **Place it. Or hold it.** |
| 4 | 11–15 dtk | Tiga kartu di papan menyerang 1 kartu depan lawan, angka damage melayang (`−420`, `−510`), label **Super effective ×1.5**, bar HP turun, KO, dua titik skor terisi, **Victory** | **Two KOs win.** |
| 5 | 15–18 dtk | Panel AI Agent: Lv.1→4, tiga pelajaran muncul bergantian (tema gelap `--deep`) | **An AI Agent that learns from every duel.** |
| 6 | 18–20 dtk | Grid 20 match mini berjalan paralel, penghitung `onchain tx / sec` naik | **Many duels. In parallel. 300 ms blocks.** |
| 7 | 20–22 dtk | Kartu penutup gelap | **Monicard** · Draw. Place. Win. · `monicard.xyz` · "Live on Monad testnet" |

## Aturan visual (design system proyek)
- Tema light untuk adegan 1–4 dan 6; adegan 5 dan 7 memakai latar `--deep` (#200052).
- Warna hanya dari token: `--purple #6e54ff` (pemain), `--berry #a0055d` (lawan), `--ink`, `--surface`, elemen `--element-fire/water/lightning`, rarity `--rarity-*`.
- **Tanpa shadow, glow, atau emoji. Satu-satunya gradien: kilau foil Legendary.**
- Font: **Schibsted Grotesk** (teks) dan **JetBrains Mono** (angka, hash, nomor blok, HP, damage; selalu tabular).
- Karakter: 9 Nadmon di `docs/design-system/assets/Nadmon/*.svg` (Infernad, Wavenad, Voltnad, dan lainnya). Jangan menambah karakter lain.
- Gerak hanya `transform` dan `opacity`. Banyak `ease-out`, tanpa pantulan berlebihan.

## Referensi tampilan nyata
Jalankan `https://monicard.xyz/battle` di HP atau browser lebar 375 untuk melihat papan sungguhan: bar atas (ronde dan skor), kartu lawan di atas, kartu kamu di bawah, tangan yang bisa digeser, tombol Attack dan Special. Jangan menyalin persis; sederhanakan untuk video.
