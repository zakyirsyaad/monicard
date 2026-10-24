# Nadmon

Sembilan makhluk original NadGacha: 3 elemen × 3 tahap evolusi. Terinspirasi budaya "monanimal" komunitas Monad (imut, ungu, akhiran "-nad"), tapi **desainnya milik NadGacha sendiri**. Jangan diganti dengan karakter komunitas (Chog, Molandak, dll.) atau wajah orang nyata tanpa izin tertulis pemiliknya.

| Elemen | Tahap 1 (Common, Rare) | Tahap 2 (Epic) | Tahap 3 (Legendary) |
|---|---|---|---|
| Fire | `embrit.svg` — Embrit | `blazenad.svg` — Blazenad | `infernad.svg` — Infernad |
| Water | `dripnad.svg` — Dripnad | `wavenad.svg` — Wavenad | `abyssnad.svg` — Abyssnad |
| Lightning | `sparkit.svg` — Sparkit | `voltnad.svg` — Voltnad | `tempestnad.svg` — Tempestnad |

- Spesies sebuah kartu **ditentukan dari elemen + rarity onchain**: Common & Rare = tahap 1, Epic = tahap 2, Legendary = tahap 3. Nama spesies = nama kartu.
- Setiap file 240 × 150 (rasio 8:5), sudah termasuk latar warna elemen. Di web tampilkan lewat `<img>` dengan `alt` = nama spesies. Di SVG kartu server, isinya disisipkan inline (lihat `GameCard`: ambil isi di antara tag akar, bungkus `<svg viewBox="0 0 240 150">` baru). Jangan mewarnai ulang atau memotong.
- Palet tetap (bukan token, karena SVG berdiri sendiri): garis `#200052` (deep), pipi `#a0055d` (berry), sorot `#ffffff`. Per elemen — Fire: latar `#ffe9dc`, tubuh `#ffe3d3`, aksen `#ff9a5c`, inner flame Infernad `#b8400b`. Water: latar `#e3f0ff`, tubuh `#dcebff`, aksen `#6cb8ff`, gelembung `#0b64be`. Lightning: latar `#fbf3d6`, tubuh `#e4dfff`, aksen `#f2cc4d`.
- Tahap 3 punya cincin aura putus-putus dan alis tegas; tahap 1 kecil dan polos. Kerumitan naik sesuai rarity.
