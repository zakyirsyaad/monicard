Kartu NFT bergaya TCG. Versi **full** dirender sekali di server sebagai SVG (`/card/:id/image.svg`) dan ditampilkan web lewat `<img>`; versi **compact** adalah komponen React untuk layar duel.

## Data

Server membaca `card` dari chain (`{ id, atk, hp, element, rarity, wins, losses, mintedAt }`, `mintedAt` = nomor blok mint), spesies dari `nadmonFor(element, rarity)`, dan `{ title, lore }` dari penyimpanan lore. Metadata `/card/:id` selalu berisi semuanya di `nadgacha: { …card, nadmon, title, lore, status: 'ready' | 'forging' }`, termasuk saat lore belum siap.

## Full — SVG 300 × 560 (dirender server)

Ukuran teks di SVG memakai skala tetap kartu ini, bukan gaya teks layar. Warna diambil dari nilai **tema light** di `tokens.json` (alias `{nama}` di-resolve dulu). Font: `font-family='Schibsted Grotesk, Helvetica Neue, Arial, sans-serif'` dan `'JetBrains Mono, Menlo, monospace'`. Font web tidak termuat di dalam `<img>`, jadi lebar teks dihitung dengan margin (maks ±44 karakter per baris 11px). Semua teks di-escape XML.

| y (baseline) | Isi | Gaya |
|---|---|---|
| 0–560 | Bingkai: rect 300×560, rx 14, isi `surface-raised`, stroke 3px warna rarity | — |
| 26 | `STAGE n` | 10px 600, letter-spacing .06em, `ink-muted` |
| 52 | Nama Nadmon (kiri) · `HP 1,950` (kanan, `text-anchor=end`) | nama 24px 800 `ink` · HP 13px mono 600 `ink` |
| 62–80 | Chip elemen (teks warna elemen) dan chip rarity (`purple-tint` + `purple-ink`) | 10px 600 |
| 88–260 | Jendela gambar x=12, w=276, h=172, rx 8, stroke 2px warna elemen; isi = Nadmon (lihat di bawah) | — |
| 278 | Meta tengah: "Lightning · from Sparkit · Block #73,562,481" (tahap 1: "Lightning · basic · Block #…"), maks 48 karakter | 10px `ink-muted` |
| 290–380 | Dua serangan, masing-masing: garis `line`, nama + angka (kanan), keterangan. **Tap** = ATK, "Damage per tap. ×1.5 vs {strong}." · **Last stand** = `10×ATK–50×ATK`, "Once per duel, at neutral element." | nama 15px 600, angka 18px mono 600, keterangan 11px `ink-muted` |
| 390–422 | Garis `line`, tiga kolom: "Strong vs" {element} · "Weak to" {element} · "Record" "12 W · 4 L" | label 10px `ink-muted`, nilai 12px 600 |
| 434–526 | Kotak flavor: rect rx 8 stroke `line`; gelar (12px 600) lalu lore (11px `ink-muted`, tegak, maks 4 baris, elipsis). Saat `forging`: gelar "Forging lore…", tanpa lore | — |
| 548 | "Blitz Jogja · {id}" kiri, simbol rarity kanan: Common ●, Rare ◆, Epic ◆◆, Legendary ★ | 10px mono `ink-muted`; ★ warna `rarity-legendary` |

**Menyisipkan Nadmon:** ambil isi file `docs/design-system/assets/Nadmon/<id>.svg` **di antara** tag `<svg …>` dan `</svg>` (tanpa tag akarnya), lalu bungkus `<svg x="12" y="88" width="276" height="172" viewBox="0 0 240 150">…</svg>`. Jangan menempelkan file utuh: atribut `width`/`height` akarnya akan terduplikasi dan XML menjadi tidak valid.

Aturan elemen: Water beats Fire, Lightning beats Water, Fire beats Lightning.

## Di web

- Layar reveal dan koleksi: `<img src="/card/:id/image.svg?v={status}">` lebar 280–320px, `alt` = nama Nadmon. Saat `status` berubah dari `forging` ke `ready`, ganti `v` supaya gambar dimuat ulang.
- **Legendary saja — kilau foil:** elemen overlay di atas jendela gambar (`left 4%`, `top 15.7%`, `width 92%`, `height 30.7%` dari ukuran `<img>`), `repeating-linear-gradient` diagonal tipis bergerak 6 dtk loop, `mix-blend-mode: screen`. Satu-satunya gradien di sistem; matikan saat `prefers-reduced-motion`.

## Compact — komponen React (layar duel)

**Consumer memberikan:** `nadmon` (`{ id, name }`), `element`, `rarity`, `atk`.

- Tinggi 72px, `surface-raised`, border 2px warna rarity, `rounded-card`, padding `space-3`, gap `space-3`.
- Thumbnail `/nadmon/<id>.svg` 64×40, `rounded-chip`. Nama gaya `title`. Chip elemen gaya `label`. `ATK n` gaya `data` di kanan.
- Tanpa serangan, lore, atau footer. Jangan menaruh logo Monad, emoji, atau wajah orang nyata di kartu.
