# Monicard Card Battle — spesifikasi MVP v2 (bergiliran, tarik kartu, papan 3 slot)

Keputusan user 12:48, direvisi 12:57 (v2; v3 12:59 menggantikan v1/v2): duel utama = **duel kartu bergiliran ala Pokémon TCG Pocket**. Mode tap (BlitzArena) TIDAK dihapus; tetap live sebagai "Tap Blitz" dan cadangan. Mode baru dibangun di samping dengan kontrak baru `CardBattle`. Keputusan mode mana jadi demo utama di checkpoint 15:30.

## Aturan permainan (v3)
- **Kartu PvP bersifat sementara dan TIDAK berhubungan dengan NFT yang dimiliki pemain.** Tidak ada cek kepemilikan, tidak ada `NadCards` di kontrak ini, dan siapa pun boleh bermain. Tumpukan tarik setiap pemain = **10 kartu acak yang dibuat onchain saat ditarik** (tampil sebagai tumpukan tertutup dengan punggung kartu Monicard dan jumlah sisa).
- **Kartu yang ditarik:** elemen, rarity, ATK, dan HP diundi dengan `keccak256(prevrandao, matchId, side, drawNo)` memakai distribusi yang sama dengan gacha: rarity roll 0-99 (<60 Common 0, <88 Rare 1, <98 Epic 2, selain itu Legendary 3), `atk = 10 + (0..4) + rarity`, `hp = 1500 + (0..300) + 100*rarity`, `element = 0..2`. Stat disimpan saat kartu ditarik. Frontend menampilkan Nadmon lewat `nadmonFor(element, rarity)` dari `@nad/shared`.
- **Tangan (hand):** kartu yang sudah ditarik dan belum ditaruh. **Boleh menumpuk banyak**; pemain boleh menahan kartu di tangan.
- **Papan (board):** **3 slot** per pemain. Kartu yang ditaruh masuk permainan dengan HP penuh (HP persisten sampai KO).
- **Awal match:** setelah `joinMatch`, kedua pemain menarik **1 kartu acak** ke tangan. Siapa jalan pertama diundi acak.
- **Satu giliran = 1 tx `act(id, handIdx, special)`:**
  1. **Tangan sudah berisi:** tidak ada tarikan di awal `act`. Kartu yang didapat pada akhir giliran lawan sudah ada di tangan, jadi pemain melihatnya sebelum memutuskan.
  2. **Taruh (opsional):** `handIdx` = nomor tarikan (0-9) dari kartu di tangan yang ditaruh ke slot papan kosong terkecil; `255` = tidak menaruh. Kartu harus ada di tangan dan ada slot kosong.
  3. **Serang:** semua kartu di papan pemain menyerang **1 kartu depan lawan** (slot papan lawan terisi dengan indeks terkecil). Damage tiap kartu = `atk x DAMAGE_SCALE x elementMult(elemenKartu, elemenTarget) / 100`, dijumlahkan. `special = true` menggandakan damage total, **sekali per match per pemain**. Tanpa kartu di papan penyerang atau lawan, tidak ada serangan.
  4. Target HP 0 -> **KO**: kartu dibuang, **skor penyerang +1**. **Skor 2 menang.**
  5. **Akhir giliran:** giliran berpindah. Jika match masih Active, **pemain berikutnya langsung menarik 1 kartu acak baru** (jika `drawn < 10`), sehingga kartu itu sudah di tangan saat gilirannya dimulai. Kalau match selesai, tidak ada tarikan. `Acted.drawnNo` = nomor tarikan yang diterima pemain berikutnya (255 kalau tidak ada).
- **Kalah otomatis:** pemain tanpa kartu di papan, di tangan, dan tumpukan kosong.
- **Timeout:** `TURN_TIMEOUT_BLOCKS = 100` (+-30 dtk) -> lawan memanggil `claimTimeout` dan menang.
- `elementMult(a, d)`: `(d+1)%3 == a` -> 150; sama -> 100; kalah -> 75. Elemen: 0 Fire, 1 Water, 2 Lightning.
- Konstanta awal: `DAMAGE_SCALE = 35`, `MAX_DRAWS = 10`, `BOARD_SLOTS = 3`, `WIN_SCORE = 2`. Setel di test agar satu match +-14-20 tx (+-30 dtk).

## Kontrak `CardBattle` (Solidity 0.8.24, Foundry, OpenZeppelin v5)
```solidity
enum Status { Open, Active, P1Won, P2Won }

struct MatchView {
  address p1; address p2;
  Status status;
  uint8 turn;                 // 1 = p1 bergerak, 2 = p2
  uint8 score1; uint8 score2;
  uint32 lastMoveBlock;
  bool special1; bool special2;           // special sudah dipakai
  uint8 drawn1; uint8 drawn2;             // jumlah tarikan (0..10)
  uint16 placed1; uint16 placed2;         // bitmask nomor tarikan yang sudah ditaruh ke papan
  uint8[10] el1; uint8[10] el2;           // elemen kartu hasil tarikan ke-i
  uint8[10] rar1; uint8[10] rar2;         // rarity
  uint16[10] atk1; uint16[10] atk2;       // ATK
  uint16[10] maxHp1; uint16[10] maxHp2;   // HP penuh
  uint16[10] hp1; uint16[10] hp2;         // HP saat ini (0 setelah KO)
  uint8[3] board1; uint8[3] board2;       // nomor tarikan di slot papan, 255 = kosong
}

constructor();   // tanpa dependensi NadCards
function createMatch() external returns (uint256 id);                           // Open; tarikan awal pembuat
function joinMatch(uint256 id) external;                                       // bukan pembuat; Active; tarikan awal; undi giliran
function act(uint256 id, uint8 handIdx, bool special) external;               // hanya pemain yang giliran
function claimTimeout(uint256 id) external;
function getMatch(uint256 id) external view returns (MatchView memory);
function getMatches(uint256 from, uint256 count) external view returns (MatchView[] memory);
function matchCount() external view returns (uint256);
function elementMult(uint8 a, uint8 d) public pure returns (uint256);

event MatchCreated(uint256 indexed id, address indexed p1);
event MatchJoined(uint256 indexed id, address indexed p2);
event Acted(uint256 indexed id, address indexed player, uint8 drawnNo, uint8 placedNo, bool special, uint256 damage, bool ko);
event MatchEnded(uint256 indexed id, address indexed winner);
```
Revert untuk input salah (bukan giliranmu, bukan Active, kartu bukan di tangan, tidak ada slot kosong, pile tidak valid) itu benar. Aritmetika `uint256`, HP jenuh. Timing `block.number`, tanpa `block.timestamp`. Tanpa `payable`. `act` tidak memanggil kontrak lain; tanpa panggilan ke kontrak lain dan tanpa cek kepemilikan.

## Server (HTTP + WS), tambahan opsional kompatibel
- `GET /config`: `contracts.battle?`; `gasLimits.createMatch|joinMatch|act|claimTimeout?`.
- `POST /relay` menerima keempat fungsi itu ke alamat `battle` (value 0, gas ≤ gasLimits). Respons `events.matchId?: string`.
- Pesan WS `{ type:'matches', block: string, featuredId: string|null, matches: MatchViewJson[] }`; scope `all` dan `match:<id>`. Pesan lama tidak berubah.
- `POST /agent/battle {matchId}` → `{ok:true}` | `409 {reason}` | `429`: AI Agent bergabung ke match Open (tanpa deck; tumpukan acak dibuat kontrak), lalu bermain: tiap giliran taruh kartu terkuat di tangan bila ada slot, dan `special` bila damage-nya cukup KO atau HP kartu depan sendiri rendah (gaya `decideSkill`).
- Poller membaca `getMatches` (64 terakhir) tiap blok baru dan menyimpan cache `getMatch(id)` untuk runner.

## Frontend: HUD ala Pokémon TCG Pocket (MVP rapi)
Papan vertikal 375×812, tema light design system, tanpa shadow/gradien/emoji. Dari atas ke bawah:
1. **Bar atas:** "Opponent / AI Agent · Lv.N", skor sebagai **2 titik** per pemain, sisa blok giliran.
2. **Sisi lawan:** tumpukan tertutup (punggung kartu Monicard, jumlah sisa) di kiri, **3 slot papan** (kartu compact + bar HP berry + angka HP mono). Kartu depan (target) ditandai.
3. **Tengah:** banner giliran ("Your turn" ungu / "Opponent's turn" berry), angka damage melayang, label "Super effective ×1.5".
4. **Sisi kamu:** 3 slot papan (bar HP ungu), tumpukan tertutupmu dengan jumlah sisa.
5. **Tangan:** strip kartu yang bisa discroll horizontal. Ketuk kartu → terpilih (garis ungu) → "Place on board" otomatis ke slot kosong. Kartu tak dipilih tetap di tangan.
6. **Aksi bawah:** tombol besar **Attack** (ungu; kirim `act(placeIdx|255, false)`) dan **Special** (gelap, sekali per match, menampilkan perkiraan damage). Nonaktif saat bukan giliranmu. Animasi tarik kartu ("Drawing…") dari tumpukan ke tangan, transform/opacity saja, hormati reduced-motion.
7. Layar akhir "Victory / Defeat" + ringkasan + link MonadScan.
Lobi `/battle`: **tanpa pilih deck** (kartu PvP tidak berhubungan dengan NFT). Tombol **Create match** (QR + link `/battle/:id`) dan **Fight AI Agent**; join lewat QR langsung. Rute `/battle`, `/battle/:id`. Di layar Play: entri utama "Card Battle", entri kedua "Tap Blitz".

## Pembagian (terminal Qwen-4, -5, -6)
- **Qwen-4 (kontrak):** `contracts/src/CardBattle.sol`, `contracts/test/CardBattle.t.sol`, `contracts/script/DeployBattle.s.sol`, deploy + verifikasi testnet, gas, key `battle` di `deployments/testnet.json`, `battleAbi`/`battleBytecode` di `@nad/shared`. **ABI/antarmuka dulu** (kompilasi + ekspor ±15 menit).
- **Qwen-5 (server):** relay allowlist, `/config`, poller + WS `matches`, runner agent battle + `/agent/battle`, wiring di `app.ts`/`main.ts`.
- **Qwen-6 (frontend):** `web/src/routes/battle/**`, `web/src/lib/battle/**`, edit kecil `App.tsx` dan `Play.tsx`; mock dulu.
- Edit file bersama hanya dengan edit kecil terarah; baca ulang file sebelum mengedit.

## Jadwal
ABI 13:15 · kontrak deploy + Verified 13:45 · UI mock 14:15 · server 14:30 · tersambung + uji 2 HP 15:15 · **keputusan mode utama 15:30**.
