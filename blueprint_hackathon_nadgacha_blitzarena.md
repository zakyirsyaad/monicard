# ⚡ Blueprint Hackathon: NadGacha — BlitzArena
**AI-Powered Onchain TCG Gacha & Real-Time 300ms Multiplayer Tap-Battle**
*Disusun khusus untuk Eksekusi Solo Senior Developer (Fullstack, AI, & Web3) di Monad Blitz Jogja Vol. 2*

---

## 1. Konteks Event & Aturan Main (Monad Blitz Jogja Vol. 2)

* **Nama Acara:** Monad Blitz Jogja Vol. 2 (Diselenggarakan oleh Monad Foundation, Kartikey Garg, & Dev Web3 Jogja)
* **Waktu & Lokasi:** Sabtu, 24 Oktober 2026 | 07:00 – 19:00 WIB | Garuda Spark Innovation Hub (GSIH), Kecamatan Mlati, Yogyakarta
* **Format Peserta:** Solo builder atau tim (maksimal 3 orang). Penggunaan AI (*vibe coding* / *AI-assisted coding*) sangat diperbolehkan oleh penyelenggara.
* **Alur & Estimasi Waktu Build (~6 Jam Efektif):**
  * `08:30 – 09:00 WIB`: Workshop Monad 101 & Hands-on Mentoring
  * `09:00 – 09:15 WIB`: Networking & Validasi Ide
  * `09:15 – 16:30 WIB`: **Sesi Build Berkecepatan Tinggi (~6–7 Jam)** hasta *Code Freeze*
  * `16:30 – 16:45 WIB`: Batas Pengumpulan (*Submission*)
  * `17:00 – 19:00 WIB`: Sesi *Live Demo / Pitching* di depan juri & peserta

---

## 2. Analisis Kriteria Juri: Apa Arti "Sejauh Apa Projek Utilizing Monad"?

Berdasarkan arahan DevRel (*"no main topic, sejauh apa projek yang dibikin utilizing Monad"*) serta riset dokumentasi dan pembaruan ekosistem Monad, proyek **NadGacha: BlitzArena** menjawab langsung dua dimensi penilaian utama:

### A. Pemanfaatan Keunggulan Teknis Inti Monad
1. **Kecepatan Ekstrem (10.000 TPS & Finalitas 300ms) + Near-Zero Fees:**
   Monad adalah Layer 1 EVM-compatible dengan *Parallel Execution* dan konsensus *MonadBFT* yang mampu memproses $10.000\text{ TPS}$ dengan waktu blok sub-detik yang kini telah ditingkatkan dari $400\text{ ms}$ menjadi **$300\text{ ms}$**, serta biaya gas mendekati nol. Game *real-time tap-battle* di mana setiap ketukan adalah transaksi *onchain* akan mengalami *bottleneck* parah di EVM biasa, tetapi berjalan seketika layaknya aplikasi Web2 di atas Monad.
2. **Optimasi Penyimpanan (Konsep MIP-8):**
   Berdasarkan penjelasan DevRel Monad (`@danielvf`), mengambil satu data dari *storage* secara terpisah cukup mahal. Prinsip **MIP-8** memungkinkan pengambilan sekumpulan nilai yang berdekatan (*chunk of nearby values*) sekaligus—di mana mengambil $128$ nilai membutuhkan waktu yang kurang lebih sama dengan mengambil $1$ nilai. Menerapkan struktur data yang berdekatan (*packed/contiguous storage arrays & structs*) pada status kartu TCG dan *leaderboard* arena akan menjadi nilai plus teknis yang sangat kuat di mata juri DevRel.

### B. Pemanfaatan Ekosistem & Tren Konsumen Monad (*Composability*)
* **Tren Collectibles & Gacha di Monad:** Ekosistem Monad sedang sangat aktif di sektor koleksi digital dan *gacha*, terbukti dari peluncuran aplikasi populer seperti **RE:VERSE** (`@reverse_tcg`), **Oripa** (*Pull. Collect. Win.*), **PlayKami** (*Gamified Collectibles Marketplace*), dan **Omnia** (*Pet Battling & Adventure Game*).
* **Integrasi Infrastruktur Native Monad:** Memadukan *Account Abstraction / Session Keys* (**ZeroDev** / **Gelato**), *Embedded Wallets* (**Dynamic** / **Privy**), *Onchain Randomness* (**Gelato VRF**), serta *Real-Time Indexer* (**Envio** / **Ghost**).

---

## 3. Gambaran Besar Game (Gameplay & User Experience)

**"NadGacha: BlitzArena"** adalah game **Web3 Trading Card Game (TCG) Gacha & Real-Time Tap-Battle** berbasis *browser* (*mobile-first*) yang menggabungkan kecerdasan buatan (AI) dengan kecepatan eksekusi $300\text{ ms}$ Monad.

Permainan terbagi menjadi dua fase utama yang cepat, intuitif, dan adiktif:

### Fase 1: AI Gacha Pull (Koleksi Kartu Unik)
* **Onboarding Tanpa Gesekan:** Pemain masuk ke aplikasi web menggunakan *Passkey* atau *Google Login* (via Dynamic atau Privy) tanpa perlu mencatat *seed phrase*. Dompet *embedded* otomatis dibuatkan di balik layar.
* **Sentuhan AI Generatif:** Saat pemain menekan tombol *Gacha Pull* menggunakan token testnet `MON`, sistem AI secara *on-the-fly* menghasilkan nama karakter, *lore* (cerita latar belakang), elemen (misal: *Monad Lightning Mage*, *Jogja Cyber Ronin*), dan distribusi atribut serangan yang unik.
* **Onchain Minting & VRF:** Kartu langsung di-*mint* sebagai NFT (ERC-721/ERC-1155) ke dompet pemain di Monad Testnet dalam waktu $300\text{ ms}$, dengan tingkat kelangkaan (*rarity*) yang dapat diverifikasi menggunakan *randomness* onchain (atau Gelato VRF).

### Fase 2: The 300ms Blitz Arena (Pertarungan Tap-Battle)
* **Mode Pertarungan:** Pemain memilih kartu terbaik mereka untuk masuk ke arena pertarungan **1v1** atau **PvE Mass Boss Raid** (melawan Boss raksasa bersama pemain lain secara *real-time*).
* **Mekanik Tap = Onchain Transaction:** Untuk menyerang atau mengaktifkan *skill* kartu, pemain harus mengetuk (*tap*) layar dengan cepat. Berkat **Session Keys**, setiap ketukan mengirim transaksi *onchain* di latar belakang tanpa pop-up konfirmasi dompet.
* **Real-Time Settlement + AI Commentator:** Karena finalitas Monad hanya $300\text{ ms}$, setiap ketukan langsung mengurangi *Health Bar* (HP) Boss di layar utama secara *real-time*. Di sudut layar, **Live AI Battle Commentator** memberikan komentar seru berdasarkan jalannya pertarungan.

### 🎬 Skenario "Killer Demo" Saat Pitching di Panggung (17:00 WIB)
1. Tampilkan antarmuka **BlitzArena** dan sebuah **QR Code** besar di layar proyektor GSIH Yogyakarta.
2. Ajak seluruh juri DevRel dan peserta di ruangan (30–50 orang) untuk memindai QR Code tersebut menggunakan HP masing-masing.
3. Dalam 5 detik, semua orang di ruangan sudah masuk ke dalam *room* yang sama dengan *embedded wallet* yang terisi otomatis oleh *faucet/sponsor gas*.
4. Nyalakan **30-Second Boss Raid**: Seluruh juri dan penonton mengetuk layar HP mereka secepat mungkin secara bersamaan.
5. Layar proyektor menampilkan ratusan transaksi masuk ke Monad Testnet dan mengurangi HP Boss secara *real-time* tanpa *lag* atau *revert*, disusul pengumuman pemenang *Top Damage Dealer* di *Leaderboard* instan.

---

## 4. Blueprint Arsitektur Teknis & Tech Stack

### Diagram Arsitektur Sistem
```text
[ Frontend: Next.js (App Router) + TailwindCSS + Viem/Wagmi ]
       │
       ├──► 1. Auth & Embedded Wallet: Dynamic SDK (via Dynamic MCP) / Privy
       ├──► 2. Gasless & Auto-Sign: ZeroDev (4337 Session Keys) / Gelato Relay
       ├──► 3. Real-Time State Read: Envio (HyperSync/HyperIndex) / Ghost GraphQL
       │
[ AI Layer: OpenAI API / KIMI (Moonshot AI) ]
       ├──► Dynamic Card Generator (Lore, Nama, Elemen, & Visual Prompt)
       └──► Live AI Battle Commentator (Narasi real-time aksi arena)
       │
[ Smart Contract Layer: Monad Testnet (Chain ID: 10143) - Foundry ]
       ├──► NadGacha.sol: Kontrak Minting Kartu TCG + Rarity Logic / Gelato VRF
       ├──► BlitzArena.sol: Kontrak Tap-Battle, Boss HP Pool, & Damage Settlement
       └──► MIP-8 Storage Pattern: Packed Structs & Contiguous Storage Slots
```

### Spesifikasi Jaringan Monad (Cheat Sheet Konfigurasi)

| Parameter | Monad Testnet (Fokus Hackathon) | Monad Mainnet (Referensi) |
| :--- | :--- | :--- |
| **Chain ID** | `10143` | `143` |
| **RPC URL** | `https://rpc.testnet.monad.xyz` | `https://rpc.monad.xyz` |
| **Block Explorer** | `https://testnet.monadscan.com` / `https://monadvision.com` | `https://monadscan.com` |
| **Native Token** | `MON` | `MON` |
| **Faucet URL** | `https://faucet.monad.xyz` | - |

### Rincian Tech Stack Pilihan
* **Smart Contract Framework:** **Foundry** (kompilasi, pengujian, dan *deployment* super cepat menggunakan skrip Solidity).
* **Authentication & Wallet:** **Dynamic** (`@dynamic_xyz`) — manfaatkan fitur **Dynamic MCP** yang terhubung langsung ke editor kode berbasis AI untuk mengotomasi pembuatan alur login Google/Email dan *embedded wallet* dalam hitungan menit. Alternatif: **Privy** (`@privy_io`).
* **Account Abstraction & Gasless UX:** **ZeroDev** (smart account tanpa gas, tanpa pop-up konfirmasi, dan tanpa *seed phrase*) atau **Gelato** (mendukung *gasless transactions* & **Gelato VRF** untuk pengacakan gacha).
* **Data Indexing:** **Envio** (`HyperIndex` / `HyperSync` / `HyperRPC`) atau **Ghost** (tulis transformasi indeks dalam Solidity, *query* via GraphQL) agar *frontend* tidak perlu melakukan *polling* RPC mentah terus-menerus.
* **AI Engine:** **KIMI (Moonshot AI)** (salah satu mitra *bounty* resmi ekosistem hackathon Monad) atau **OpenAI API**.

---

## 5. Timeline Eksekusi Solo Builder (6 Jam: 09:15 – 16:30 WIB)

* **08:30 – 09:15 WIB (Persiapan & Validasi Mentor):**
  Ikuti *Monad 101 Workshop* dan sapa mentor dari **Dev Web3 Jogja** serta **Monad DevRel**. Sampaikan konsep *NadGacha: BlitzArena* untuk mendapatkan masukan awal dan membangun *awareness* juri sejak pagi.
* **Jam 1 (09:15 – 10:15 WIB) — Smart Contract & MIP-8 Optimization:**
  * Setup proyek Foundry dan tulis `NadGacha.sol` serta `BlitzArena.sol`.
  * Terapkan pengemasan variabel (*struct packing*) dan penempatan *array* berdekatan sesuai prinsip **MIP-8** agar pembacaan *state* kartu dan daftar pemain di arena sangat hemat gas dan cepat.
  * Deploy & verifikasi kontrak di Monad Testnet (`10143`) via `testnet.monadscan.com`.
* **Jam 2 & 3 (10:15 – 13:00 WIB) — Frontend, Wallet & Session Keys:**
  * Bangun UI Next.js bertema ungu futuristik khas Monad (*mobile-first*).
  * Integrasikan **Dynamic SDK** / **Privy** beserta **ZeroDev Session Keys** (atau *burner/embedded auto-signer* yang di-sponsori *master faucet wallet* agar peserta yang scan QR langsung punya saldo gas untuk *tap*).
* **Jam 4 (13:00 – 14:30 WIB) — Integrasi AI Layer & Indexer:**
  * Hubungkan API AI untuk men-generate atribut dan cerita kartu saat *gacha* ditarik, plus fitur *AI Commentator* di layar utama.
  * Pasang **Envio** atau *event listener* berbasis WebSocket/Viem untuk memantau berkurangnya HP Boss dan memperbarui *Leaderboard* secara *real-time*.
* **Jam 5 (14:30 – 15:30 WIB) — Optimasi UX & Simulasi Multi-User:**
  * Uji coba alur *scan QR -> auto-wallet -> gacha -> tap-battle* menggunakan 2–3 perangkat/tab berbeda.
  * Tambahkan umpan balik visual (*damage numbers*, animasi getar saat *tap*, dan indikator *latency* `~300ms` di layar untuk memamerkan kecepatan Monad).
* **Jam 6 (15:30 – 16:30 WIB) — Security Check, Code Freeze & Pitch Prep:**
  * **Catatan Keamanan Vibe Coding dari `@monad_dev`:** Pastikan tidak ada *private key* atau kontrol admin yang bocor di sisi *client* (*frontend*), pasang *access control* yang tepat pada fungsi *minting* dan *reset boss*, serta jaga kode tetap ramping.
  * Lakukan *Code Freeze* pukul `16:30 WIB` dan *Submit* sebelum `16:45 WIB`.

### Strategi Pitching 3 Menit (Pukul 17:00 WIB)
1. **Bukti Nyata 300ms (Bukan Sekadar Klaim):** Langsung minta juri & audiens scan QR code dan rasakan sendiri bagaimana puluhan orang melakukan transaksi *tap* secara bersamaan tanpa *delay*.
2. **Inovasi UX (Zero-Friction Web3 Gaming):** Tekankan perpaduan *Passkey Onboarding*, *Session Keys* (tanpa pop-up tanda tangan), dan *AI Generative Cards* yang membuat pengguna Web2 pun bisa langsung bermain dalam 5 detik.
3. **Kedalaman Teknis Monad (MIP-8):** Tunjukkan bagaimana struktur penyimpanan kontrak pintarmu dirancang memanfaatkan arsitektur pembacaan data berdekatan (*nearby storage chunks*) khas Monad.

---

## 6. Daftar Lengkap Sumber & Referensi (Sources)

Berikut adalah seluruh sumber resmi yang digunakan dalam analisis dan perancangan dokumen ini:

### A. Halaman Acara & Komunitas Lokal
1. **Monad Blitz Jogja Vol. 2 (Luma Event Page):**
   * URL: https://luma.com/blitz-jogja-okt-2026?tk=KVKPC9 (dan https://lu.ma/blitz-jogja-okt-2026)
   * Penyelenggara & Co-Host:
     * Monad Foundation Events: https://luma.com/MonadFoundation?k=c | https://monad.xyz
     * Kartikey Garg: https://x.com/geeky_kartikey
     * Dev Web3 Jogja: https://x.com/devweb3jogja | https://instagram.com/devweb3jogja
   * Mitra Komunitas: IndoNads (`https://x.com/indonads_`, `https://t.me/indonads`), IDNFT (`https://www.idnft.id/`), BlockDev (`https://blockdev.id/`), ETH Jakarta (`https://x.com/ethjkt`), Mancer (`https://mancer.work/`).

### B. Dokumentasi & Portal Developer Resmi Monad
2. **Monad Official Website:** https://monad.xyz/
   * Statistik Jaringan & Ekosistem: `~989M` Transaksi, `9M+` Active Wallets, `143+` Apps Live, `$1B` DeFi TVL (https://defillama.com/chain/monad).
3. **Monad Developer Hub:** https://monad.xyz/developers
   * Dokumentasi Teknis & Arsitektur (MonadBFT & Parallel EVM): https://docs.monad.xyz/ | https://docs.monad.xyz/monad-arch/
   * Developer Essentials & Quickstart Guides: https://docs.monad.xyz/developer-essentials/ | https://docs.monad.xyz/guides/
   * Panduan Deploy Foundry: https://docs.monad.xyz/guides/deploy-smart-contract/foundry
   * Panduan Deploy Hardhat: https://docs.monad.xyz/guides/deploy-smart-contract/hardhat
   * Panduan Deploy Remix: https://docs.monad.xyz/guides/deploy-smart-contract/remix
   * Testnet Hub & Faucet: https://testnet.monad.xyz/ | https://faucet.monad.xyz/
   * Block Explorers: https://monadscan.com/ | https://testnet.monadscan.com/ | https://monadvision.com/

### C. Direktori Infrastruktur & Tooling Monad (Untuk Tech Stack NadGacha)
4. **Monad Infrastructure Directory:** https://monad.xyz/infra | https://docs.monad.xyz/tooling-and-infra/
   * **Foundry (Smart Contract Framework):** https://getfoundry.sh/
   * **Dynamic (Auth, Embedded Wallets & Dynamic MCP):** https://x.com/dynamic_xyz
   * **Privy (Embedded Wallets & Onboarding):** https://x.com/privy_io
   * **ZeroDev (Smart Accounts & Gasless Session Keys):** https://zerodev.app/ | https://x.com/zerodev_app
   * **Gelato (Gasless Relay & Verifiable Random Function / VRF):** https://www.gelato.network/ | https://x.com/gelatonetwork
   * **MetaMask Delegation Toolkit (Smart Accounts & Permission Delegation):** https://docs.metamask.io/smart-accounts-kit | https://x.com/MetaMaskDev
   * **Envio (Real-Time HyperIndex, HyperSync, HyperRPC):** https://envio.dev/ | https://x.com/envio_indexer
   * **Ghost (Solidity & GraphQL Smart Contract Indexer):** https://tryghost.xyz/ | https://twitter.com/0xGhostLogs
   * **Thirdweb (Full-stack Web3 SDK & Wallets):** https://thirdweb.com/ | https://x.com/thirdweb
   * **Sequence (Embedded & Smart Contract Wallets):** https://sequence.xyz/ | https://x.com/0xsequence
   * **Alchemy (RPC & Developer Infra):** https://x.com/Alchemy

### D. Referensi Aplikasi Ekosistem Monad (Inspirasi Gacha, Collectibles & Gaming)
5. **Monad App Hub & Portal:** https://app.monad.xyz/ | https://monad.xyz/app-hub
   * **RE:VERSE (Onchain TCG & Box Opening di Monad):** https://x.com/reverse_tcg
   * **Oripa ("Pull. Collect. Win." Collectibles & Entertainment):** https://app.monad.xyz/app-hub/oripa
   * **PlayKami (Gamified Collectibles Marketplace):** https://app.monad.xyz/app-hub/playkami
   * **Omnia (Pet Battling & Adventure Game):** https://app.monad.xyz/app-hub/omnia
   * **LootGO (Collectibles & Entertainment):** https://app.monad.xyz/app-hub/lootgo
   * **Monad Cards Onchain:** https://cards.monad.xyz/

### E. Wawasan Teknis, Tips Hackathon & Update dari X (Twitter) Resmi
6. **Monad Devs (`@monad_dev`):** https://x.com/monad_dev
   * **Optimasi Storage MIP-8 oleh `@danielvf` (9 Okt 2026):** Penjelasan teknis mengenai pengambilan sekumpulan nilai yang berdekatan (*chunk of 128 nearby values*) dari *storage* dalam waktu yang setara dengan mengambil 1 nilai.
   * **Keamanan Vibe Coding & Prinsip Sistem Ramping (7 & 9 Okt 2026):** Peringatan untuk menghindari *client-side admin controls*, *missing access controls*, dan eksposur data saat menggunakan AI untuk coding cepat, serta menjaga permukaan sistem tetap kecil.
   * **Integrasi Cepat Dynamic MCP oleh `@MatthewFoyle` (25 & 26 Sep 2026):** Panduan menghubungkan Dynamic MCP ke editor berbasis AI untuk mengotomasi pembuatan alur *sign-in* Google/email dan *embedded wallet*, serta fokus membangun aplikasi yang terasa sangat nyaman digunakan (*feel genuinely good to use*).
   * **Arsitektur Indexer untuk Frontend (23 Sep & 3 Okt 2026):** Rekomendasi penggunaan **Envio** (`HyperIndex`, `HyperSync`, `HyperRPC`) agar *frontend* tidak perlu melakukan *query* langsung ke blockchain untuk setiap kebutuhan data.
   * **Bounty AI KIMI Moonshot (4 Okt 2026):** Dukungan pengembangan aplikasi berbasis AI menggunakan **KIMI (`@Kimi_Moonshot`)** di ekosistem hackathon Monad (https://monad.xyz/metropolis).
   * **Strategi Produk & Retensi oleh `@pareen`, `@danielvf`, & `@harpaljadeja` (25 Sep, 1 Okt, 12 Okt 2026):** Fokus pada utilitas yang jelas, retensi pengguna berulang, dan membuat sekelompok pengguna awal benar-benar menyukai pengalaman produk yang dibangun.
7. **Monad APAC (`@Monad_APAC`):** https://x.com/Monad_APAC
   * **Peningkatan Kecepatan Blok 300ms (8 Jun & 24 Jul 2026):** *"If you liked Monad at 400ms, you're gonna love it at 300ms."*
   * **Tren TCG & Collectibles di APAC (23 Jul, 30 Jul, & 4 Okt 2026):** Peluncuran publik **RE:VERSE** (`@reverse_tcg`) di Monad serta kehadiran ekosistem Monad di *Collectible Con Korea 2026*.