# Monicard Card Battle — spesifikasi MVP (BO3, bergiliran)

Keputusan user 12:48: duel utama berubah dari tap-tap menjadi **duel kartu bergiliran best-of-3** ala Pokémon TCG Pocket. **Mode tap (BlitzArena) TIDAK dihapus**: tetap live sebagai cadangan dan sebagai "Tap Blitz". Mode baru dibangun di samping, dengan kontrak baru `CardBattle`. Keputusan mana yang jadi demo utama diambil di checkpoint 15:30 (mana yang stabil).

## Aturan permainan
- **Deck:** 1–3 kartu NFT milik pemain (`NadCards`). Slot kosong = 0. Tidak boleh duplikat token. Kartu harus milik `msg.sender` (`ownerOf`).
- **Match:** best-of-3 ronde; **yang lebih dulu menang 2 ronde menang match**.
- **Tarikan acak:** di awal setiap ronde, tiap pemain mendapat 1 kartu aktif yang **diundi acak dari deck-nya** (`prevrandao`, dengan pengembalian). HP kartu aktif penuh di awal ronde.
- **Giliran:** ronde 1 yang jalan pertama diundi acak. Ronde berikutnya yang **kalah** ronde sebelumnya jalan pertama.
- **Aksi per giliran (1 tx):**
  - `Strike`: damage = `atk × DAMAGE_SCALE × elementMult / 100`.
  - `Special`: **1× per ronde per pemain**, damage = 2 × Strike.
- **KO:** kartu aktif lawan HP 0 → ronde selesai, pemenang ronde skor +1, ronde baru (undi kartu baru, HP penuh). Skor 2 → match selesai.
- **Timeout:** kalau pemain yang giliran tidak bergerak dalam `TURN_TIMEOUT_BLOCKS = 100` blok (±30 dtk), lawan boleh memanggil `claimTimeout` dan menang match.
- `elementMult`: penyerang `a` vs bertahan `d`: `(d+1)%3 == a` → 150; sama → 100; kalah → 75. Elemen: 0 Fire, 1 Water, 2 Lightning (sama dengan BlitzArena).
- Konstanta: `DAMAGE_SCALE = 30`, `MAX_ROUNDS = 3`. Tujuan: ±4–5 aksi per sisi per ronde, ±20–27 tx per match (±40 dtk). Boleh disetel saat test kalau tidak sesuai.

## Kontrak `CardBattle` (Solidity 0.8.24, Foundry, OpenZeppelin v5)
```solidity
enum Status { Open, Active, P1Won, P2Won }

struct MatchView {
  address p1; address p2;
  Status status;
  uint8 round;            // 1..3
  uint8 score1; uint8 score2;
  uint8 turn;             // 1 = p1 bergerak, 2 = p2 bergerak
  uint32 lastMoveBlock;
  uint32[3] deck1; uint32[3] deck2;       // token id, 0 = slot kosong
  uint32 card1; uint32 card2;             // kartu aktif ronde ini
  uint16 hp1; uint16 maxHp1; uint16 atk1; uint8 el1;
  uint16 hp2; uint16 maxHp2; uint16 atk2; uint8 el2;
  bool special1; bool special2;           // special sudah dipakai di ronde ini
}

constructor(address cards);
function createMatch(uint32[3] calldata deck) external returns (uint256 id);   // status Open
function joinMatch(uint256 id, uint32[3] calldata deck) external;              // bukan pembuat; jadi Active, undi ronde 1
function act(uint256 id, bool special) external;                               // hanya pemain yang giliran
function claimTimeout(uint256 id) external;                                    // lawan dari pemain yang giliran, setelah timeout
function getMatch(uint256 id) external view returns (MatchView memory);
function getMatches(uint256 from, uint256 count) external view returns (MatchView[] memory);
function matchCount() external view returns (uint256);
function elementMult(uint8 a, uint8 d) public pure returns (uint256);
function damageOf(uint16 atk, uint8 a, uint8 d, bool special) public pure returns (uint256);

event MatchCreated(uint256 indexed id, address indexed p1);
event MatchJoined(uint256 indexed id, address indexed p2);
event Acted(uint256 indexed id, address indexed player, bool special, uint256 damage, uint16 hpLeft, uint8 round);
event RoundEnded(uint256 indexed id, uint8 round, uint8 winnerSide, uint8 score1, uint8 score2);
event MatchEnded(uint256 indexed id, address indexed winner);
```
Aturan implementasi: **clamp, bukan revert** untuk aksi tak berguna? Tidak: ini kontrak giliran, jadi revert untuk input salah (bukan giliranmu, match belum Active, deck tidak valid) itu benar. Aritmetika `uint256`, HP dikurangi jenuh. Timing memakai `block.number`, tidak pernah `block.timestamp`. Tanpa `payable`. `act` tidak memanggil kontrak lain (baca stat kartu terjadi saat `createMatch`/`joinMatch`/undi ronde, lewat `NadCards.cards(id)` dan `ownerOf`). Undi acak: `uint256(keccak256(abi.encode(block.prevrandao, id, round, side, salt)))`.

## Server (HTTP + WS), tambahan opsional kompatibel
- `GET /config`: `contracts.battle?: Hex`; `gasLimits.createMatch`, `joinMatch`, `act`, `claimTimeout` (opsional).
- `POST /relay` menerima `createMatch`, `joinMatch`, `act`, `claimTimeout` ke alamat `battle`, `value = 0`, `gas ≤ gasLimits[fn]`. Respons `events` ditambah `matchId?: string`.
- Pesan WS baru `{ type: 'matches'; block: string; featuredId: string | null; matches: MatchView-JSON[] }` (id string; semua angka number; deck dan alamat apa adanya). Lingkup `/ws?scope=all` menerima semua, `?scope=match:<id>` hanya match itu. Pesan lama (`duels`, `stats`, `agent`) tidak berubah.
- `POST /agent/battle {matchId}` → `{ok:true}` / `409 {reason}` / `429`: AI Agent bergabung ke match `Open` milik pemain (dengan deck dari kartu miliknya) lalu bermain sampai selesai. Kebijakan: pakai `Special` lewat `decideSkill`-style (`server/src/agent/policy.ts`) dan `Strike` selain itu; boleh menyimpan pelajaran seperti mode tap.
- Poller membaca `getMatches` (jendela 64 match terakhir) tiap blok baru, dengan cache `getMatch(id)` untuk runner.

## Frontend: HUD ala Pokémon TCG Pocket (MVP, tetap indah)
Referensi: papan vertikal di HP. Layout dari atas ke bawah (375×812, tema light design system, tanpa shadow/gradien/emoji):
1. **Bar atas:** "Round 2 of 3", skor lawan dan skor kamu sebagai **3 titik bulat** (terisi = menang ronde), nama lawan atau "AI Agent · Lv.N", jam giliran (sisa blok).
2. **Kartu aktif lawan** (besar, di atas tengah): ilustrasi Nadmon, nama, elemen, ATK, **angka HP besar di pojok kanan atas kartu** + bar HP berry. Panah elemen unggul/kalah.
3. **Garis tengah:** banner giliran ("Your turn" ungu / "Opponent's turn" berry), angka damage melayang saat aksi, indikator keunggulan elemen ("Super effective ×1.5").
4. **Kartu aktif kamu** (besar): sama, bar HP ungu.
5. **Deck-mu** (strip 3 kartu compact, kartu aktif ditandai).
6. **Tombol aksi di bawah:** `Strike` (besar, ungu) dan `Special` (gelap, sekali per ronde, menampilkan damage; nonaktif setelah dipakai). Nonaktif saat bukan giliranmu.
7. Transisi: kartu masuk saat undi ronde ("Drawing…"), shake kecil saat terkena Special, layar akhir ronde ("Round won" / "Round lost"), layar akhir match "Victory / Defeat" dengan ringkasan dan link MonadScan.
Lobi `/battle`: pilih deck (centang sampai 3 kartu milikmu, tampil compact), tombol "Create match" (menampilkan QR + link `/battle/:id`), dan "Fight AI Agent". Join lewat QR memakai deck default (kartu aktif pemain).
Rute: `/battle` (lobi), `/battle/:id` (papan). Di layar Play tambahkan entri utama "Card Battle · Best of 3" dan "Tap Blitz" sebagai entri kedua.

## Pembagian (3 terminal Qwen baru, file terpisah)
- **Qwen-4 (kontrak):** `contracts/src/CardBattle.sol`, `contracts/test/CardBattle.t.sol`, `contracts/script/DeployBattle.s.sol`, deploy + verifikasi testnet (devnads verify API, chainId 10143), ukur gas (`cast estimate` × 1,2), key `battle` + `gasLimits.createMatch/joinMatch/act/claimTimeout` ditambahkan ke `deployments/testnet.json`, lalu `battleAbi` di `@nad/shared` (`shared/scripts/export-abi.ts`, `shared/src/abi.ts`). **Kerjakan antarmuka dulu** (compile, ABI diekspor dalam ±15 menit) supaya yang lain bisa mulai.
- **Qwen-5 (server):** allowlist relay, `/config`, poller `getMatches` + pesan WS `matches`, runner AI Agent battle + `POST /agent/battle`, dan pemasangan di `app.ts`/`main.ts`.
- **Qwen-6 (frontend):** hanya `web/src/routes/battle/**`, `web/src/lib/battle/**`, dan edit kecil di `App.tsx` (rute) serta `Play.tsx` (entri). Mock dulu sampai ABI dan server siap.
- Batas: jangan menyentuh file milik sesi lain. Edit file bersama (`app.ts`, `main.ts`, `App.tsx`) hanya dengan edit kecil terarah, baca ulang file sebelum edit.

## Jadwal
ABI siap 13:10 · kontrak deploy + verified 13:40 · server battle 14:30 · UI mock 14:00, UI nyata 15:00 · uji 2 HP 15:15 · **keputusan 15:30** (mode mana yang jadi demo utama).
