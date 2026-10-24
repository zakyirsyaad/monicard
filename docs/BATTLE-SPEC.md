# Monicard Card Battle — spesifikasi MVP v2 (bergiliran, tarik kartu, papan 3 slot)

Keputusan user 12:48, direvisi 12:57 (v2, menggantikan v1): duel utama = **duel kartu bergiliran ala Pokémon TCG Pocket**. Mode tap (BlitzArena) TIDAK dihapus; tetap live sebagai "Tap Blitz" dan cadangan. Mode baru dibangun di samping dengan kontrak baru `CardBattle`. Keputusan mode mana jadi demo utama di checkpoint 15:30.

## Aturan permainan (v2)
- **Tumpukan tarik (deck):** 1–5 kartu NFT milik pemain (`ownerOf == msg.sender`, tanpa duplikat token), dipilih saat `createMatch`/`joinMatch`. Tampil sebagai **tumpukan tertutup dengan punggung kartu** dan jumlah sisa.
- **Tangan (hand):** kartu yang sudah ditarik tapi belum ditaruh. **Boleh menumpuk banyak**; pemain boleh menahan kartu di tangan.
- **Papan (board):** **3 slot** per pemain. Kartu yang ditaruh di papan masuk ke permainan dengan HP penuh (HP persisten sampai KO).
- **Awal match:** setelah `joinMatch`, kedua pemain menarik **1 kartu acak** ke tangan. Siapa jalan pertama diundi acak (`prevrandao`).
- **Satu giliran = 1 tx `act(id, placeIdx, special)`:**
  1. **Tarik:** otomatis menarik 1 kartu acak dari tumpukan (tanpa pengembalian) ke tangan, jika tumpukan belum habis.
  2. **Taruh (opsional):** `placeIdx` = indeks slot tumpukan (0–4) dari kartu di tangan yang ditaruh ke slot papan kosong terkecil; `255` = tidak menaruh. Wajib kartu ada di tangan dan ada slot kosong.
  3. **Serang:** semua kartu di papan pemain menyerang **1 kartu depan lawan** (slot papan lawan terisi dengan indeks terkecil). Damage tiap kartu penyerang = `atk × DAMAGE_SCALE × elementMult(elemenKartu, elemenTarget) / 100`; damage total dijumlahkan. `special = true` menggandakan damage total, **sekali per match per pemain**. Tanpa kartu di papan penyerang, atau lawan tanpa kartu di papan, tidak ada serangan.
  4. Kartu target HP 0 → **KO**: kartu dibuang, **skor penyerang +1**. **Skor 2 menang match.**
  5. Giliran berpindah.
- **Kalah otomatis:** pemain yang tidak punya kartu di papan, di tangan, maupun di tumpukan kalah.
- **Timeout:** pemain yang giliran tidak bergerak dalam `TURN_TIMEOUT_BLOCKS = 100` blok (±30 dtk) → lawan memanggil `claimTimeout` dan menang.
- `elementMult(a, d)`: `(d+1)%3 == a` → 150; sama → 100; kalah → 75. Elemen: 0 Fire, 1 Water, 2 Lightning.
- Konstanta awal: `DAMAGE_SCALE = 35`, `MAX_PILE = 5`, `BOARD_SLOTS = 3`, `WIN_SCORE = 2`. Setel di test agar satu match ±14–20 tx (±30 dtk).

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
  uint32[5] pile1; uint32[5] pile2;       // token id tumpukan, 0 = kosong
  uint8 drawn1; uint8 drawn2;             // bitmask indeks tumpukan yang sudah ditarik
  uint8 hand1; uint8 hand2;               // bitmask indeks tumpukan yang sedang di tangan
  uint32[3] board1; uint32[3] board2;     // token id di slot papan, 0 = kosong
  uint16[3] hp1; uint16[3] hp2;           // HP kartu papan
  uint16[3] maxHp1; uint16[3] maxHp2;
  uint16[3] atk1; uint16[3] atk2;
  uint8[3] el1; uint8[3] el2;
}

constructor(address cards);
function createMatch(uint32[5] calldata pile) external returns (uint256 id);   // Open
function joinMatch(uint256 id, uint32[5] calldata pile) external;              // bukan pembuat; Active; tarikan awal; undi giliran
function act(uint256 id, uint8 placeIdx, bool special) external;               // hanya pemain yang giliran
function claimTimeout(uint256 id) external;
function getMatch(uint256 id) external view returns (MatchView memory);
function getMatches(uint256 from, uint256 count) external view returns (MatchView[] memory);
function matchCount() external view returns (uint256);
function elementMult(uint8 a, uint8 d) public pure returns (uint256);

event MatchCreated(uint256 indexed id, address indexed p1);
event MatchJoined(uint256 indexed id, address indexed p2);
event Acted(uint256 indexed id, address indexed player, uint8 drawnIdx, uint8 placedIdx, bool special, uint256 damage, bool ko);
event MatchEnded(uint256 indexed id, address indexed winner);
```
Revert untuk input salah (bukan giliranmu, bukan Active, kartu bukan di tangan, tidak ada slot kosong, pile tidak valid) itu benar. Aritmetika `uint256`, HP jenuh. Timing `block.number`, tanpa `block.timestamp`. Tanpa `payable`. `act` tidak memanggil kontrak lain; stat kartu dibaca dari `NadCards.cards(id)` saat kartu ditaruh. Undi: `keccak256(abi.encode(block.prevrandao, id, side, turnCounter))` modulo jumlah kartu belum ditarik.

## Server (HTTP + WS), tambahan opsional kompatibel
- `GET /config`: `contracts.battle?`; `gasLimits.createMatch|joinMatch|act|claimTimeout?`.
- `POST /relay` menerima keempat fungsi itu ke alamat `battle` (value 0, gas ≤ gasLimits). Respons `events.matchId?: string`.
- Pesan WS `{ type:'matches', block: string, featuredId: string|null, matches: MatchViewJson[] }`; scope `all` dan `match:<id>`. Pesan lama tidak berubah.
- `POST /agent/battle {matchId}` → `{ok:true}` | `409 {reason}` | `429`: AI Agent bergabung ke match Open dengan tumpukan dari kartu miliknya (hingga 5), lalu bermain: tiap giliran taruh kartu terkuat di tangan bila ada slot, dan `special` bila damage-nya cukup KO atau HP kartu depan sendiri rendah (gaya `decideSkill`).
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
Lobi `/battle`: pilih tumpukan (centang sampai 5 kartu milikmu, compact), **Create match** (QR + link `/battle/:id`), **Fight AI Agent**. Join lewat QR memakai semua kartu milikmu (maks 5). Rute `/battle`, `/battle/:id`. Di layar Play: entri utama "Card Battle", entri kedua "Tap Blitz".

## Pembagian (terminal Qwen-4, -5, -6)
- **Qwen-4 (kontrak):** `contracts/src/CardBattle.sol`, `contracts/test/CardBattle.t.sol`, `contracts/script/DeployBattle.s.sol`, deploy + verifikasi testnet, gas, key `battle` di `deployments/testnet.json`, `battleAbi`/`battleBytecode` di `@nad/shared`. **ABI/antarmuka dulu** (kompilasi + ekspor ±15 menit).
- **Qwen-5 (server):** relay allowlist, `/config`, poller + WS `matches`, runner agent battle + `/agent/battle`, wiring di `app.ts`/`main.ts`.
- **Qwen-6 (frontend):** `web/src/routes/battle/**`, `web/src/lib/battle/**`, edit kecil `App.tsx` dan `Play.tsx`; mock dulu.
- Edit file bersama hanya dengan edit kecil terarah; baca ulang file sebelum mengedit.

## Jadwal
ABI 13:15 · kontrak deploy + Verified 13:45 · UI mock 14:15 · server 14:30 · tersambung + uji 2 HP 15:15 · **keputusan mode utama 15:30**.
