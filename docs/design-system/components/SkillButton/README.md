Tombol skill "Last Stand" yang menampilkan damage saat ini dan hanya bisa dipakai sekali per duel.

**Consumer memberikan:** `damage` (hasil `skillDamage` dari `@nad/shared`, dihitung ulang setiap HP berubah), `used` (boolean), dan `onUse`.

- Isi `deep`, teks `on-deep`. Label `title` "Last stand", angka damage `data-lg` di kanan.
- Damage naik saat HP pemain turun; tampilkan angka terbaru, bukan rentang.
- `used`: isi `surface-sunken`, teks `ink-muted`, label "Skill used".
- Tinggi 56px, `radius-md`, lebar penuh, tepat di atas `TapButton` dengan jarak `space-3`.
