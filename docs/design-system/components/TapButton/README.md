Tombol serang raksasa di zona jempol; satu-satunya elemen dengan `radius-lg`.

**Consumer memberikan:** `state` (`countdown` | `active` | `ended`), angka countdown saat `countdown`, dan handler `onTap` yang dipanggil di `pointerdown`.

- Isi `purple`, teks `on-purple` dengan gaya `display-tap`. Lebar penuh, tinggi minimal 112px, `radius-lg`.
- `countdown`: isi `surface-sunken`, teks `ink-muted`, menampilkan angka (3, 2, 1). Tidak menerima tap.
- `active`: teks "TAP". Saat ditekan, skala 0,97 selama 80ms.
- `ended`: isi `surface-sunken`, teks "Done" di `ink-muted`.
- Pakai `touch-action: manipulation` dan `pointerdown`, jangan `click`.
- Jangan menaruh angka damage atau teks lain di dalam tombol.
