// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {INadCards} from "./interfaces/INadCards.sol";

/// @title BlitzArena
/// @notice Parallel 1v1 card duels. Taps are clamped — late, early and oversized
///         taps never revert, because a revert on Monad still pays the full gasLimit.
///         `attack()` makes no external calls; win/loss recording happens in `settle()`.
contract BlitzArena {
    enum Status {
        Open,
        Active,
        P1Won,
        P2Won,
        Draw
    }

    /// @dev Exactly 3 storage slots; field order is load-bearing (see spec §4.2).
    struct Duel {
        // slot 1 — P1 side (31 bytes)
        address p1;
        uint16 hp1;
        uint16 atk1;
        uint8 mult1;
        uint32 lastBlock1;
        bool skill1;
        Status status;
        // slot 2 — P2 side (30 bytes)
        address p2;
        uint16 hp2;
        uint16 atk2;
        uint8 mult2;
        uint32 lastBlock2;
        bool skill2;
        // slot 3 — meta (17 bytes)
        uint32 startBlock;
        uint32 card1;
        uint32 card2;
        uint16 maxHp1;
        uint16 maxHp2;
        bool settled;
    }

    uint32 public constant COUNTDOWN_BLOCKS = 10;
    uint32 public constant DUEL_BLOCKS = 67;
    uint16 public constant MAX_TAPS_PER_BLOCK = 3;
    uint16 public constant MAX_TAPS_PER_TX = 30;

    error NotCardOwner();
    error NotOpen();
    error SelfJoin();
    error NotParticipant();
    error NotFinished();
    error AlreadySettled();

    event DuelCreated(uint256 indexed id, address indexed p1, uint256 card1);
    event DuelStarted(uint256 indexed id, address indexed p2, uint32 startBlock);
    event Attacked(uint256 indexed id, address indexed attacker, uint16 taps, uint256 damage, uint16 hpLeft);
    event DuelEnded(uint256 indexed id, Status status);

    INadCards public immutable cards;

    Duel[] private duels;

    constructor(INadCards cards_) {
        cards = cards_;
    }

    // ------------------------------------------------------------------ create

    /// @notice Open a duel with one of your cards.
    function createDuel(uint256 cardId) external returns (uint256 id) {
        if (cards.ownerOf(cardId) != msg.sender) revert NotCardOwner();

        id = duels.length;
        duels.push();
        Duel storage d = duels[id];
        d.p1 = msg.sender;
        // NadCards token ids are sequential and far below 2^32; the spec packs them as uint32.
        // forge-lint: disable-next-line(unsafe-typecast)
        d.card1 = uint32(cardId);

        emit DuelCreated(id, msg.sender, cardId);
    }

    /// @notice Join an open duel. Snapshots both cards' stats and starts the countdown.
    function joinDuel(uint256 id, uint256 cardId) external {
        Duel storage d = duels[id];
        if (d.status != Status.Open) revert NotOpen();
        if (msg.sender == d.p1) revert SelfJoin();
        if (cards.ownerOf(cardId) != msg.sender) revert NotCardOwner();

        INadCards.Card memory c1 = cards.cards(d.card1);
        INadCards.Card memory c2 = cards.cards(cardId);

        d.hp1 = c1.hp;
        d.maxHp1 = c1.hp;
        d.atk1 = c1.atk;
        d.mult1 = elementMult(c1.element, c2.element);

        d.p2 = msg.sender;
        d.hp2 = c2.hp;
        d.maxHp2 = c2.hp;
        d.atk2 = c2.atk;
        d.mult2 = elementMult(c2.element, c1.element);
        // Same bounded token id as card1.
        // forge-lint: disable-next-line(unsafe-typecast)
        d.card2 = uint32(cardId);

        // Block numbers stay far inside uint32 for the lifetime of this game.
        // forge-lint: disable-next-line(unsafe-typecast)
        d.startBlock = uint32(block.number) + COUNTDOWN_BLOCKS;
        d.lastBlock1 = d.startBlock;
        d.lastBlock2 = d.startBlock;
        d.status = Status.Active;

        emit DuelStarted(id, msg.sender, d.startBlock);
    }

    // ------------------------------------------------------------------ attack

    /// @notice Tap to deal damage. Clamps taps; never reverts on timing races.
    /// @dev Makes no external calls: the whole hot path touches only this duel's 3 slots.
    function attack(uint256 id, uint16 taps, bool useSkill) external {
        Duel storage d = duels[id];

        bool isP1 = msg.sender == d.p1;
        if (!isP1 && msg.sender != d.p2) revert NotParticipant();

        // 1. Finished or not yet joined: swallow the tap (in-flight tx is normal).
        if (d.status != Status.Active) return;

        // 2. Past the duel window: close by remaining HP and ignore the taps.
        if (block.number >= uint256(d.startBlock) + DUEL_BLOCKS) {
            _closeByHp(d, id);
            return;
        }

        // 3. Before the countdown ended: no effect.
        if (block.number < d.startBlock) return;

        // 4. Clamp taps to elapsed blocks and the per-tx cap.
        uint256 allowed = (block.number - (isP1 ? uint256(d.lastBlock1) : uint256(d.lastBlock2))) * MAX_TAPS_PER_BLOCK;
        if (allowed > MAX_TAPS_PER_TX) allowed = MAX_TAPS_PER_TX;
        if (allowed > taps) allowed = taps;
        // `allowed` is clamped to MAX_TAPS_PER_TX (30), so the downcast cannot truncate.
        // forge-lint: disable-next-line(unsafe-typecast)
        uint16 allowedTaps = uint16(allowed);
        // Block numbers stay far inside uint32 for the lifetime of this game.
        // forge-lint: disable-next-line(unsafe-typecast)
        if (isP1) d.lastBlock1 = uint32(block.number);
        else d.lastBlock2 = uint32(block.number);

        // 5. Damage in uint256; "Last stand" reads the ATTACKER's pre-attack HP (addendum N11).
        uint16 atk = isP1 ? d.atk1 : d.atk2;
        uint8 mult = isP1 ? d.mult1 : d.mult2;
        uint16 myHp = isP1 ? d.hp1 : d.hp2;
        uint16 myMaxHp = isP1 ? d.maxHp1 : d.maxHp2;
        uint16 oppHp = isP1 ? d.hp2 : d.hp1;

        uint256 dmg = tapDamage(allowedTaps, atk, mult);

        if (useSkill) {
            if (isP1) {
                if (!d.skill1) {
                    d.skill1 = true;
                    dmg += skillDamage(atk, mult, myHp, myMaxHp);
                }
            } else if (!d.skill2) {
                d.skill2 = true;
                dmg += skillDamage(atk, mult, myHp, myMaxHp);
            }
        }

        // 6. Saturating subtraction, then KO handling.
        // `dmg < oppHp` in this branch, so the difference always fits uint16.
        // forge-lint: disable-next-line(unsafe-typecast)
        uint16 hpLeft = dmg >= oppHp ? 0 : uint16(uint256(oppHp) - dmg);
        if (isP1) d.hp2 = hpLeft;
        else d.hp1 = hpLeft;

        emit Attacked(id, msg.sender, allowedTaps, dmg, hpLeft);

        if (hpLeft == 0) {
            Status finalStatus = isP1 ? Status.P1Won : Status.P2Won;
            d.status = finalStatus;
            emit DuelEnded(id, finalStatus);
        }
    }

    // ------------------------------------------------------------------ settle

    /// @notice Close a timed-out duel and record the result on both cards.
    function settle(uint256 id) external {
        Duel storage d = duels[id];

        if (d.status == Status.Active && block.number >= uint256(d.startBlock) + DUEL_BLOCKS) {
            _closeByHp(d, id);
        }

        if (d.settled) revert AlreadySettled();
        if (d.status != Status.P1Won && d.status != Status.P2Won && d.status != Status.Draw) {
            revert NotFinished();
        }

        d.settled = true;

        if (d.status == Status.P1Won) cards.recordResult(d.card1, d.card2);
        else if (d.status == Status.P2Won) cards.recordResult(d.card2, d.card1);
        // Draw records nothing.
    }

    // ------------------------------------------------------------------- views

    function duelCount() external view returns (uint256) {
        return duels.length;
    }

    /// @notice Page of duels for the poller; `count` is clipped to the array length.
    function getDuels(uint256 from, uint256 count) external view returns (Duel[] memory page) {
        uint256 len = duels.length;
        if (from >= len) return new Duel[](0);

        uint256 end = count > len - from ? len : from + count;
        page = new Duel[](end - from);
        for (uint256 i; i < page.length; ++i) {
            page[i] = duels[from + i];
        }
    }

    // ------------------------------------------------------------------- maths

    /// @notice Element multiplier: 150 when `a` beats `d`, 100 on a mirror, else 75.
    function elementMult(uint8 a, uint8 d) public pure returns (uint8) {
        if ((uint256(d) + 1) % 3 == uint256(a)) return 150;
        if (a == d) return 100;
        return 75;
    }

    /// @notice Damage from `taps` taps; integer division floors.
    function tapDamage(uint16 taps, uint16 atk, uint8 mult) public pure returns (uint256) {
        return (uint256(taps) * uint256(atk) * uint256(mult)) / 100;
    }

    /// @notice Skill damage: base 10% of ATK, up to 50% as the attacker's own HP drops.
    /// @dev Callers pass the attacker's HP; "Last stand" scales with the attacker's missing HP (N11).
    function skillDamage(uint16 atk, uint8 mult, uint16 hp, uint16 maxHp) public pure returns (uint256) {
        uint256 maxH = uint256(maxHp);
        uint256 missing = maxH > hp ? maxH - uint256(hp) : 0;
        return (uint256(atk) * uint256(mult) * (10 * maxH + 40 * missing)) / (100 * maxH);
    }

    // ----------------------------------------------------------------- private

    function _closeByHp(Duel storage d, uint256 id) private {
        Status finalStatus;
        if (d.hp1 > d.hp2) finalStatus = Status.P1Won;
        else if (d.hp2 > d.hp1) finalStatus = Status.P2Won;
        else finalStatus = Status.Draw;

        d.status = finalStatus;
        emit DuelEnded(id, finalStatus);
    }
}
