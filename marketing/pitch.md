# Monicard — Pitch 3 Menit (demo live, tanpa deck)

Bahasa panggung: Inggris (teks di bawah). Arahan panggung dalam [kurung siku], bahasa Indonesia.
Prinsip: hanya demo fitur yang sudah terbukti jalan di HP (rubrik "all announced functions working").

## Layar
- **Proyektor:** laptop menampilkan `/arena` (layar penuh, tema gelap) di URL live. QR "Scan to play" tampil di sudut.
- **Tanganmu:** HP dengan data seluler, burner sudah ada.
- **Tab cadangan di laptop:** MonadScan arena (testnet), repo GitHub, video demo.

## Run-sheet

**0:00 – 0:15 · Hook**
> "This is Monicard: a trading-card battle where **every move is a transaction**, on Monad."
[Tunjuk blok yang berjalan dan total tx onchain di /arena.]

**0:15 – 1:50 · Demo live: Card Battle melawan AI Agent**
[Di HP: Card Battle → Fight AI Agent. Layar HP dimirror atau tunjuk papan di proyektor.]
> "No wallet, no seed phrase: my burner wallet was created and funded for me."
[Awal giliran: kartu baru sudah di tangan, lencana NEW.]
> "Every turn I draw a random card, generated onchain. I can hold it, or place it on my three-slot board."
[Taruh kartu di papan, tekan Attack.]
> "All my board cards strike the opponent's front card together. Water beats Fire, Fire beats Lightning, Lightning beats Water — that's the ×1.5."
[Pakai Special sekali.]
> "Special doubles my damage, once per match. Two KOs win."
[Klik tx terbaru → MonadScan, kembali.]
> "Each of these moves is a real transaction, about 0.01 MON in gas, and the board moves at Monad speed."

**1:50 – 2:10 · AI Agent**
[Tunjuk panel agent: level dan pelajaran terbaru.]
> "The opponent is an AI Agent with its own wallet. It plays through the same relay as any human, and it learns: after each duel in Tap Blitz a coach updates its policy and publishes the lesson."

**2:10 – 2:30 · Menguji batas Monad**
[Jalankan swarm: `bash server/scripts/admin.sh swarm 10 4` (sudah diketik, tinggal Enter).]
> "Now ten bot duels at once, plus everyone in this room. Each match lives in its own storage, so Monad runs them in parallel. [Baca tx/s puncak dari layar.]"

**2:30 – 2:50 · Pasar dan bisnis (PMF + revenue)**
> "Who pays? Event organizers, like this one. Every meetup and hackathon needs an onchain onboarding moment, and most people never get past installing a wallet. Here you scan, and you're playing in three seconds. Today, **[X] people in this room pulled a card and sent [Y] transactions**.
> The battle is free to play: that's our funnel. Revenue sits around it, already onchain: sponsored event mode, like this projector screen; paid packs at 0.05 MON into a contract treasury, **[Z] MON collected today**; a 5% royalty on every resale; and staked duels with a 5% rake. A battle action costs about 0.01 MON in gas, so a full match is about 0.2 MON, funded by the event package; packs and stake rake sit on top. Next: staking in Card Battle itself."

[X, Y, Z dihitung koordinator tepat sebelum pitch (event `CardMinted`, jumlah tx, saldo treasury NadCards); bacakan, jangan dikarang. Kalau Staked Card Battle sempat jadi, ganti kalimat terakhir menjadi "And staking is live in Card Battle too."]

**2:50 – 3:00 · Sebutkan dengan lantang (wajib, rubrik Basic)**
> "Everything is public:
> - **Repo:** github.com/zakyirsyaad/monicard
> - **Contracts:** CardBattle, NadCards, BlitzArena and StakeVault, **verified on MonadScan**, deployed on **Monad testnet**[, and on **Monad mainnet** too — hanya ucapkan kalau sudah ter-deploy].
> - **Live:** [monicard.xyz — hanya kalau DNS sudah aktif; kalau belum, sebut URL sslip] — running right now.
> Thank you."

## Isi sebelum naik panggung
| Placeholder | Sumber |
|---|---|
| Alamat testnet | README / `deployments/testnet.json` |
| Alamat mainnet | `deployments/mainnet.json` (setelah deploy) |
| [X] kartu dan [Y] tx | dihitung koordinator menjelang pitch |
| tx/s puncak | dibaca langsung dari layar `/arena` saat swarm jalan |

## Checklist 16:15 – 16:45
- [ ] `git push` terakhir, README berisi URL, alamat, dan link video serta post.
- [ ] `setup-bots` sesuai saldo master; saldo AI Agent ≥ 0,5 MON.
- [ ] `admin.sh fund on` hanya saat sesi tanya-jawab.
- [ ] Perintah swarm sudah diketik di terminal laptop, belum di-Enter.
- [ ] HP: baterai > 50%, data seluler, brightness penuh, auto-lock mati.
- [ ] Satu match Card Battle penuh sudah diuji di HP beberapa menit sebelumnya.
- [ ] Tab cadangan terbuka: video demo, MonadScan, repo.

## Kalau ada masalah
- **Battle macet atau RPC tersendat:** pindah ke **Tap Blitz** (Play → Tap Blitz), lalu putar video demo kalau perlu.
- **Testnet lambat:** putar video demo, tetap buka MonadScan untuk menunjukkan tx asli.
- **AI Agent busy:** tantang duel PvP dengan satu juri lewat QR.
