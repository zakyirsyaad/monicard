Badge nomor blok dan latency tx terakhir, bukti kecepatan Monad yang terlihat di setiap layar duel.

**Consumer memberikan:** `block` (dari pesan WebSocket) dan `latencyMs` (dari respons `/relay` terakhir, atau `null` sebelum tx pertama).

- Font `data`, tabular. Format: "#73,562,481" lalu "312 ms".
- Latency < 1,000 ms: latar `purple-tint`, teks `purple-ink`. 1,000–2,000 ms: latar `surface-sunken`, teks `ink`. > 2,000 ms: latar `berry-tint`, teks `berry`.
- `null`: tampilkan "— ms" di `ink-muted`.
- Jangan membulatkan latency ke detik; angka ms apa adanya adalah poin demonya.
