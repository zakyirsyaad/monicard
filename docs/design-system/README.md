NadGacha memakai bahasa visual ekosistem Monad: latar terang yang bersih, satu warna aksi ungu, garis tipis alih-alih bayangan, dan angka dalam font mono. Kesan yang dicari adalah aplikasi resmi ekosistem Monad, bukan game neon. Energi game datang dari ukuran dan gerak (tombol tap besar, angka damage, bar HP yang turun), bukan dari dekorasi.

## Prinsip

- **Satu aksi, satu warna.** `purple` hanya untuk hal yang bisa ditekan atau milik pemain sendiri: `TapButton`, tombol utama, bar HP pemain. Jangan pakai `purple` untuk hiasan, latar, atau judul.
- **Lawan selalu `berry`.** Bar HP lawan, angka damage yang kamu berikan, bingkai Legendary, dan pesan error. Pemain = `purple`, lawan = `berry`, di semua layar.
- **Garis, bukan bayangan.** Kartu dan panel memakai `surface-raised` + border 1px `line` + `radius-md`. Tidak ada drop shadow, gradien, glow, atau blur.
- **Angka adalah fitur Monad.** Nomor blok, latency, HP, damage, dan hash tx selalu memakai gaya `data` / `data-lg` (font mono, tabular). Ini bukti kecepatan Monad, tampilkan dengan jelas.

## Konten

- **Semua teks yang dilihat pemain dan juri ditulis dalam bahasa Inggris:** UI, kartu, lore, ejekan AI Agent, pelajaran agent, pesan error, layar proyektor. Juri dan ekosistem Monad internasional. Dokumen internal boleh berbahasa Indonesia.
- Kalimat pendek, kata kerja di depan: "Pull a card", "Fight AI Agent", "Challenge a friend", "Create duel".
- Sentence case untuk judul dan tombol. HURUF BESAR hanya untuk gaya `label` (elemen, rarity, nama stat: "LIGHTNING · EPIC", "ATK 15") dan satu kata "TAP" di `TapButton`.
- Hasil duel satu kata besar di `display-tap`: "Victory", "Defeat", "Draw".
- Error menyebut apa yang terjadi lalu apa yang bisa dilakukan, tanpa "Error:" dan tanpa tanda seru: "This duel already started. Create a new one."
- Elemen: **Fire**, **Water**, **Lightning**. Nama Nadmon tidak diterjemahkan.
- Jangan pakai kata "bet", "wager", atau "gamble". Jangan pakai emoji di UI.
- Angka memakai pemisah ribuan koma: `1,950`, `#73,562,481`. Latency selalu dengan satuan: `312 ms`. Rekam menang/kalah ditulis `12 W · 4 L`.

## Warna

- Latar layar `surface`. Panel dan kartu `surface-raised`. Track bar HP dan sumur input `surface-sunken`.
- Teks utama `ink`; teks pendukung, label nomor blok, dan caption `ink-muted`. Teks ungu kecil memakai `purple-ink`, bukan `purple`.
- Isi `purple` selalu dengan teks `on-purple`. Isi `deep` selalu dengan teks `on-deep`.
- Chip dan baris terpilih: latar `purple-tint` + teks `purple-ink`. Toast error dan banner kalah: latar `berry-tint` + teks `berry`.
- Elemen memakai `element-fire`, `element-water`, `element-lightning` sebagai warna teks chip dan border jendela gambar kartu. Jangan dijadikan latar besar.
- Bingkai kartu sesuai rarity: `rarity-common` (abu), `rarity-rare` (teal), `rarity-epic` (deep), `rarity-legendary` (emas). Sengaja bukan `purple` atau `berry`, supaya warna pemain dan lawan tidak tertukar oleh rarity.
- Semua pasangan di atas sudah dicek: teks ≥ 4,5:1 dan garis/bingkai ≥ 3:1, di tema terang dan gelap.

## Tema

- HP pemain memakai tema **light** (default).
- Layar proyektor `/arena` memakai tema **dark** (`<html data-theme="dark">`). Ruangan pitch biasanya redup dan latar gelap lebih nyaman dilihat dari jauh.
- Token yang sama dipakai di kedua tema; jangan menulis warna hex langsung di komponen.

## Tipografi

- Font: **Schibsted Grotesk** (`--font-sans`) untuk semua teks, **JetBrains Mono** (`--font-mono`) untuk angka. Keduanya dari Google Fonts.
- `display-tap` (40/44, 800): kata di `TapButton` dan headline hasil. `display` (28/32, 700): nama kartu, judul layar.
- `title` (18/24, 600): judul bagian, label tombol, nama pemain. `body` (15/22): lore dan penjelasan. `label` (12/16, 600, uppercase, letter-spacing 0.06em).
- `data-lg` (22/26, mono 600): HP, damage, counter tx di proyektor. `data` (13/18, mono 500): nomor blok, latency, hash, stat.
- Selalu `font-variant-numeric: tabular-nums` untuk angka yang berubah, supaya tidak bergoyang saat HP turun.

## Ruang dan tata letak

- HP: lebar acuan 375px, gutter kiri-kanan `space-4`, jarak antar bagian `space-6`.
- Layar duel dari atas ke bawah: baris status (nomor blok + `LatencyBadge`) → `HpBar` lawan → kartu kecil kedua pemain → `HpBar` pemain → `SkillButton` → `TapButton` di zona jempol (paling bawah, tinggi minimal 112px).
- Proyektor: gutter `space-8`, duel utama di kiri (2/3), panel AI Agent dan counter tx di kanan, grid swarm di bawah. Di proyektor tidak ada "pemain sendiri": sisi P1 (atau manusia di duel utama) = `purple`, sisi P2 / AI Agent = `berry`, termasuk di tile swarm.

## Bentuk

- `radius-sm` untuk chip, badge, bar HP. `radius-md` untuk kartu, tombol, toast, panel. `radius-lg` hanya untuk `TapButton`.
- Border 1px `line` untuk pemisah. Border 2px untuk kartu compact, jendela gambar kartu, dan focus ring. Border 3px hanya untuk bingkai luar kartu full.

## Gerak

- Tekan `TapButton`: skala 0,97 selama 80ms, kembali dalam 120ms. Dipicu `pointerdown`, bukan `click`.
- Angka damage muncul di atas bar lawan, naik 24px dan memudar dalam 400ms.
- Bar HP turun dengan transisi lebar 250ms ease-out. Bagian damage yang masih in-flight digambar sebagai elemen terpisah berwarna sama dengan `opacity: 0.4` di ujung bar (jangan pakai sintaks Tailwind `bg-berry/40`, karena warna token adalah variabel CSS dan modifier itu tidak menghasilkan CSS).
- Getar HP: `navigator.vibrate(10)` **per tap, hanya di Android**. Screen shake (panel duel bergetar horizontal 4px, 3 kali, 240ms) **hanya saat skill dipakai**, di semua perangkat. Jangan shake per tap.
- Hormati `prefers-reduced-motion`: matikan getar dan animasi angka, pertahankan perubahan bar.

## Kartu TCG dan Nadmon

- Kartu memakai layout TCG: tahap evolusi, nama, HP di pojok, elemen, gambar, dua serangan dengan angka damage, unggul/lemah, flavor text, nomor set. Setiap angka di kartu adalah data asli yang dipakai di duel (detail: komponen `GameCard`).
- Gambar kartu adalah **Nadmon**, sembilan makhluk original (grup aset `Nadmon`). Spesies ditentukan elemen + rarity onchain; nama spesies = nama kartu, AI hanya menulis gelar dan lore.
- Gaya TCG adalah konvensi genre. Jangan meniru ciri khas merek lain: tidak ada bingkai kuning, simbol energi, atau nama dan logo Pokémon.
- Karakter komunitas Monad (Chog, Molandak, Moyaki, dll.) dan wajah KOL/orang nyata **tidak dipakai** tanpa izin tertulis pemiliknya.
- Satu-satunya efek dekoratif di seluruh sistem: kilau foil di kartu Legendary (lihat `GameCard`). Ini satu-satunya tempat gradien boleh dipakai.
- Kartu full dirender **sekali, di server**, sebagai SVG (`/card/:id/image.svg`); web menampilkannya lewat `<img>`. React hanya membuat versi compact. Ukuran teks di SVG kartu memakai skala tetap milik kartu (lihat `GameCard`), bukan gaya teks layar.

## Ikonografi

- Tidak ada set ikon. Status ditulis dengan teks dan angka. Elemen ditulis sebagai chip `label` ("FIRE", "WATER", "LIGHTNING").
- Tidak ada logo NadGacha; nama ditulis dengan `display`. **Jangan menggambar atau meniru logo Monad.** Kalau perlu menyebut jaringan, tulis teks "Monad testnet".

## Aksesibilitas

- Focus ring 2px solid `focus` dengan offset 2px pada setiap elemen yang bisa ditekan.
- Bar HP tidak hanya dibedakan warna: selalu ada label "You" / nama lawan dan angka HP di sampingnya.
- `TapButton` punya `aria-label="Attack"` dan target minimal 112px × lebar penuh.

## Implementasi (Vite + Tailwind)

- Salin variabel CSS dari `tokens.css` ke `web/src/styles/tokens.css` dan set `data-theme` di `<html>`.
- Di `web/tailwind.config.cjs` (CommonJS), pakai `content: ['./index.html', './src/**/*.{ts,tsx}']` dan `theme: { extend: require('../docs/design-system/tailwind.theme.cjs') }`. Radius bernama `rounded-chip`, `rounded-card`, `rounded-tap` (bukan `rounded-md`/`rounded-lg`). Opacity modifier (`/40`) tidak bekerja untuk warna token. Jangan menulis hex di `className`.
