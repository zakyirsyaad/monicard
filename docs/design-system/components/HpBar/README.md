Bar HP satu sisi duel, selalu disertai nama dan angka supaya tidak bergantung pada warna saja.

**Consumer memberikan:** `side` (`self` | `opponent`), `name`, `hp` (**nilai chain** dari pesan WebSocket terakhir), `maxHp`, dan `pendingDamage` (perkiraan damage dari tx yang belum masuk blok; 0 untuk sisi yang tidak sedang kamu serang).

- Angka yang ditampilkan = `max(0, hp − pendingDamage)` / `maxHp`, gaya `data-lg`, tabular. Jangan mengurangi `pendingDamage` di luar komponen; komponen ini satu-satunya tempat pengurangan itu.
- Track `surface-sunken`, tinggi 12px, `rounded-chip`.
- Isi utama `purple` untuk `self`, `berry` untuk `opponent`, lebar `(hp − pendingDamage) / maxHp`.
- Potongan `pendingDamage`: elemen terpisah berwarna sama dengan `opacity: 0.4`, dari `(hp − pendingDamage)` sampai `hp`. Jangan pakai `bg-berry/40` (tidak menghasilkan CSS untuk warna token).
- Di proyektor `/arena`: sisi P1 = `purple`, sisi P2 / AI Agent = `berry`.
- Transisi lebar 250ms ease-out. Jangan menganimasikan angka.
