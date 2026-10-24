// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test, Vm} from "forge-std/Test.sol";

import {NadCards} from "../src/NadCards.sol";
import {INadCards} from "../src/interfaces/INadCards.sol";
import {BlitzArena} from "../src/BlitzArena.sol";

/// @dev Test-only harness that can overwrite card stats after a pull, so duel
///      maths can be asserted against fixed numbers.
contract NadCardsHarness is NadCards {
    function setCard(uint256 id, Card memory c) external {
        _cards[id] = c;
    }
}

contract BlitzArenaTest is Test {
    bytes32 private constant ATTACKED_SIG = keccak256("Attacked(uint256,address,uint16,uint256,uint16)");
    bytes32 private constant DUEL_ENDED_SIG = keccak256("DuelEnded(uint256,uint8)");

    NadCardsHarness private cards;
    BlitzArena private arena;

    address private alice;
    address private bob;
    address private carol;

    uint256 private cardA;
    uint256 private cardB;

    struct DuelLogs {
        uint16 lastTaps;
        uint256 attackedCount;
        uint256 endedCount;
        uint256 lastEndedId;
        BlitzArena.Status lastEndedStatus;
    }

    function setUp() public {
        cards = new NadCardsHarness();
        arena = new BlitzArena(INadCards(address(cards)));
        cards.setArena(address(arena));

        alice = makeAddr("alice");
        bob = makeAddr("bob");
        carol = makeAddr("carol");

        vm.prank(alice, alice);
        cardA = cards.freePull();
        vm.prank(bob, bob);
        cardB = cards.freePull();
    }

    // ---------------------------------------------------------------- helpers

    function _setCard(uint256 id, uint16 atk, uint16 hp, uint8 element) private {
        cards.setCard(
            id, NadCards.Card({atk: atk, hp: hp, element: element, rarity: 0, wins: 0, losses: 0, mintedAt: 0})
        );
    }

    function _start() private returns (uint256 id, uint32 startBlock_) {
        vm.prank(alice);
        id = arena.createDuel(cardA);
        vm.prank(bob);
        arena.joinDuel(id, cardB);
        BlitzArena.Duel memory d = _duel(id);
        startBlock_ = d.startBlock;
    }

    function _duel(uint256 id) private view returns (BlitzArena.Duel memory) {
        BlitzArena.Duel[] memory page = arena.getDuels(id, 1);
        return page[0];
    }

    /// @dev Drains the recorder and summarises every Attacked / DuelEnded log.
    function _logs() private view returns (DuelLogs memory s) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            Vm.Log memory log = logs[i];
            if (log.topics.length == 0) continue;
            if (log.topics[0] == ATTACKED_SIG) {
                s.attackedCount += 1;
                (s.lastTaps,,) = abi.decode(log.data, (uint16, uint256, uint16));
            } else if (log.topics[0] == DUEL_ENDED_SIG) {
                s.endedCount += 1;
                s.lastEndedId = uint256(log.topics[1]);
                s.lastEndedStatus = BlitzArena.Status(uint8(abi.decode(log.data, (uint8))));
            }
        }
    }

    function _lastAttackTaps() private view returns (uint16) {
        return _logs().lastTaps;
    }

    /// @dev Alice taps 30× per block until the duel leaves Active.
    function _ko(uint256 id, uint32 startBlock_) private returns (BlitzArena.Duel memory d) {
        uint32 b = startBlock_;
        for (uint256 i; i < 60; ++i) {
            b += 1;
            vm.roll(b);
            vm.prank(alice);
            arena.attack(id, 30, false);
            d = _duel(id);
            if (d.status != BlitzArena.Status.Active) return d;
        }
        revert("duel did not end");
    }

    // ------------------------------------------------------------ tap clamping

    function test_attack_clampsTapsToBlocksElapsed() public {
        (uint256 id, uint32 s) = _start();
        vm.roll(s + 3);
        vm.recordLogs();
        vm.prank(alice);
        arena.attack(id, 20, false);
        assertEq(_lastAttackTaps(), 9); // min(20, 3 × 3, 30)
    }

    function test_attack_clampsTapsPerTx() public {
        (uint256 id, uint32 s) = _start();
        vm.roll(s + 20);
        vm.recordLogs();
        vm.prank(alice);
        arena.attack(id, 40, false);
        assertEq(_lastAttackTaps(), 30); // min(40, 60, 30)
    }

    function test_attack_sameBlockTwice_onlyFirstCounts() public {
        (uint256 id, uint32 s) = _start();
        vm.roll(s + 2);
        vm.recordLogs();
        vm.prank(alice);
        arena.attack(id, 30, false); // elapsed 2 → 6 taps
        assertEq(_lastAttackTaps(), 6);

        vm.recordLogs();
        vm.prank(alice);
        arena.attack(id, 30, false); // elapsed 0 → 0 taps
        assertEq(_lastAttackTaps(), 0);
    }

    function test_attack_beforeStart_noEffect() public {
        (uint256 id, uint32 s) = _start();
        BlitzArena.Duel memory before = _duel(id);

        vm.roll(s - 1);
        vm.recordLogs();
        vm.prank(alice);
        arena.attack(id, 30, true);

        DuelLogs memory l = _logs();
        BlitzArena.Duel memory d = _duel(id);
        assertEq(l.attackedCount, 0);
        assertEq(l.endedCount, 0);
        assertEq(d.hp1, before.hp1);
        assertEq(d.hp2, before.hp2);
        assertEq(d.lastBlock1, before.lastBlock1);
        assertFalse(d.skill1);
        assertTrue(d.status == BlitzArena.Status.Active);
    }

    function test_attack_onOpenDuel_noEffect() public {
        vm.prank(alice);
        uint256 id = arena.createDuel(cardA);

        vm.recordLogs();
        vm.prank(alice);
        arena.attack(id, 30, true);

        DuelLogs memory l = _logs();
        BlitzArena.Duel memory d = _duel(id);
        assertEq(l.attackedCount, 0);
        assertEq(l.endedCount, 0);
        assertEq(d.hp1, 0);
        assertFalse(d.skill1);
        assertTrue(d.status == BlitzArena.Status.Open);
    }

    // ------------------------------------------------------------------- maths

    function test_elementMultiplier() public view {
        assertEq(arena.elementMult(1, 0), 150); // Water > Fire
        assertEq(arena.elementMult(0, 1), 75); // Fire < Water
        assertEq(arena.elementMult(0, 2), 150); // Fire > Lightning
        assertEq(arena.elementMult(2, 2), 100); // same element
        assertEq(arena.elementMult(2, 0), 75); // Lightning < Fire
    }

    function test_tapDamage() public {
        assertEq(arena.tapDamage(9, 12, 150), 162);
        assertEq(arena.tapDamage(0, 17, 150), 0);
        assertEq(arena.tapDamage(1, 10, 75), 7); // floor(750 / 100)

        // End to end: Water attacker (12 atk) vs Fire defender, 9 allowed taps.
        _setCard(cardA, 12, 1500, 1);
        _setCard(cardB, 10, 1500, 0);
        (uint256 id, uint32 s) = _start();

        BlitzArena.Duel memory started = _duel(id);
        assertEq(started.mult1, 150);
        assertEq(started.mult2, 75);

        vm.roll(s + 3);
        vm.recordLogs();
        vm.prank(alice);
        arena.attack(id, 20, false);

        assertEq(_lastAttackTaps(), 9);
        BlitzArena.Duel memory d = _duel(id);
        assertEq(d.hp2, 1500 - 162);
        assertEq(d.hp1, 1500);
    }

    function test_skill_fullHp_and_lowHp() public view {
        assertEq(arena.skillDamage(12, 100, 1500, 1500), 120);
        assertEq(arena.skillDamage(12, 100, 150, 1500), 552);
    }

    function test_skill_onlyOnce() public {
        // Same elements → mult 100, so skill damage is exactly atk × 10 % at full HP.
        _setCard(cardA, 12, 1500, 1);
        _setCard(cardB, 10, 1500, 1);
        (uint256 id, uint32 s) = _start();

        vm.roll(s + 1);
        vm.prank(alice);
        arena.attack(id, 0, true); // skill only, no taps
        BlitzArena.Duel memory d = _duel(id);
        assertEq(d.hp2, 1500 - 120);
        assertTrue(d.skill1);

        vm.roll(s + 2);
        vm.prank(alice);
        arena.attack(id, 0, true); // skill already spent
        d = _duel(id);
        assertEq(d.hp2, 1500 - 120);
        assertTrue(d.skill1);
        assertFalse(d.skill2);
    }

    // ---------------------------------------------------------------- KO paths

    function test_attack_koEndsDuel() public {
        (uint256 id, uint32 s) = _start();
        vm.recordLogs();

        uint32 b = s;
        for (uint256 i; i < 60; ++i) {
            b += 1;
            vm.roll(b);
            vm.prank(alice);
            arena.attack(id, 30, false);
            if (_duel(id).status != BlitzArena.Status.Active) break;
        }

        DuelLogs memory l = _logs();
        BlitzArena.Duel memory d = _duel(id);
        assertTrue(d.status == BlitzArena.Status.P1Won);
        assertEq(d.hp2, 0);
        assertEq(l.endedCount, 1);
        assertEq(l.lastEndedId, id);
        assertTrue(l.lastEndedStatus == BlitzArena.Status.P1Won);
    }

    function test_attack_afterEnd_ignoresTapsAndCloses() public {
        (uint256 id, uint32 s) = _start();
        BlitzArena.Duel memory before = _duel(id);

        vm.roll(s + 67); // first block past DUEL_BLOCKS: taps are ignored
        vm.recordLogs();
        vm.prank(alice);
        arena.attack(id, 30, false);

        DuelLogs memory l = _logs();
        BlitzArena.Duel memory d = _duel(id);
        assertEq(l.attackedCount, 0);
        assertEq(l.endedCount, 1);
        assertEq(l.lastEndedId, id);
        assertEq(d.hp2, before.hp2);
        assertEq(d.hp2, d.maxHp2);
        assertTrue(d.status != BlitzArena.Status.Active);
    }

    function test_attack_afterKo_noRevert() public {
        (uint256 id, uint32 s) = _start();
        BlitzArena.Duel memory ko = _ko(id, s);
        assertEq(ko.hp2, 0);

        vm.recordLogs();
        vm.prank(bob);
        arena.attack(id, 30, true);

        DuelLogs memory l = _logs();
        BlitzArena.Duel memory d = _duel(id);
        assertEq(l.attackedCount, 0);
        assertEq(l.endedCount, 0);
        assertEq(d.hp1, ko.hp1);
        assertEq(d.hp2, 0);
        assertFalse(d.skill2);
        assertTrue(d.status == BlitzArena.Status.P1Won);
    }

    function test_attack_nonParticipantReverts() public {
        (uint256 id,) = _start();
        vm.prank(carol);
        vm.expectRevert(BlitzArena.NotParticipant.selector);
        arena.attack(id, 30, false);
    }

    // ----------------------------------------------------------------- settle

    function test_settle_timeoutDecidesByHp() public {
        _setCard(cardA, 12, 1600, 0);
        _setCard(cardB, 12, 1500, 0);
        (uint256 id, uint32 s) = _start();

        vm.roll(s + 67);
        arena.settle(id);

        BlitzArena.Duel memory d = _duel(id);
        assertTrue(d.status == BlitzArena.Status.P1Won);
        assertTrue(d.settled);

        NadCards.Card memory winner = cards.cards(cardA);
        NadCards.Card memory loser = cards.cards(cardB);
        assertEq(winner.wins, 1);
        assertEq(winner.losses, 0);
        assertEq(loser.wins, 0);
        assertEq(loser.losses, 1);
    }

    function test_settle_timeoutP2Wins() public {
        _setCard(cardA, 12, 1500, 0);
        _setCard(cardB, 12, 1700, 0);
        (uint256 id, uint32 s) = _start();

        vm.roll(s + 67);
        arena.settle(id);

        BlitzArena.Duel memory d = _duel(id);
        assertTrue(d.status == BlitzArena.Status.P2Won);

        NadCards.Card memory winner = cards.cards(cardB);
        NadCards.Card memory loser = cards.cards(cardA);
        assertEq(winner.wins, 1);
        assertEq(loser.losses, 1);
    }

    function test_settle_revertsWhenStillActive() public {
        (uint256 id,) = _start();
        vm.expectRevert(BlitzArena.NotFinished.selector);
        arena.settle(id);
    }

    function test_settle_afterTimeoutClose_noDuplicateEnded() public {
        _setCard(cardA, 12, 1600, 0);
        _setCard(cardB, 12, 1500, 0);
        (uint256 id, uint32 s) = _start();

        vm.roll(s + 67);
        vm.recordLogs();
        vm.prank(alice);
        arena.attack(id, 30, false); // closes the duel by HP
        DuelLogs memory closeLogs = _logs();
        assertEq(closeLogs.endedCount, 1);
        assertEq(closeLogs.attackedCount, 0);

        vm.recordLogs();
        arena.settle(id);
        DuelLogs memory settleLogs = _logs();
        assertEq(settleLogs.endedCount, 0); // status was already final

        assertEq(cards.cards(cardA).wins, 1);
        assertTrue(_duel(id).settled);
    }

    function test_settle_recordsOnce() public {
        (uint256 id, uint32 s) = _start();
        BlitzArena.Duel memory ko = _ko(id, s);
        assertTrue(ko.status == BlitzArena.Status.P1Won);

        arena.settle(id);
        assertEq(cards.cards(cardA).wins, 1);
        assertEq(cards.cards(cardB).losses, 1);

        vm.expectRevert(BlitzArena.AlreadySettled.selector);
        arena.settle(id);
    }

    function test_draw_recordsNothing() public {
        _setCard(cardA, 12, 1500, 0);
        _setCard(cardB, 12, 1500, 0);
        (uint256 id, uint32 s) = _start();

        vm.roll(s + 67);
        vm.recordLogs();
        arena.settle(id);

        DuelLogs memory l = _logs();
        BlitzArena.Duel memory d = _duel(id);
        assertTrue(d.status == BlitzArena.Status.Draw);
        assertTrue(d.settled);
        assertEq(l.endedCount, 1);
        assertTrue(l.lastEndedStatus == BlitzArena.Status.Draw);

        NadCards.Card memory a = cards.cards(cardA);
        NadCards.Card memory b = cards.cards(cardB);
        assertEq(a.wins, 0);
        assertEq(a.losses, 0);
        assertEq(b.wins, 0);
        assertEq(b.losses, 0);
    }

    // ------------------------------------------------------------------ joins

    function test_join_rejectsSelfJoin() public {
        vm.prank(alice);
        uint256 id = arena.createDuel(cardA);

        vm.prank(alice);
        vm.expectRevert(BlitzArena.SelfJoin.selector);
        arena.joinDuel(id, cardA);
    }

    function test_join_rejectsSecondJoiner() public {
        (uint256 id,) = _start();

        vm.prank(carol, carol);
        uint256 c = cards.freePull();
        vm.prank(carol);
        vm.expectRevert(BlitzArena.NotOpen.selector);
        arena.joinDuel(id, c);
    }

    function test_join_rejectsNonOwner() public {
        vm.prank(alice);
        uint256 id = arena.createDuel(cardA);

        vm.prank(bob);
        vm.expectRevert(BlitzArena.NotCardOwner.selector);
        arena.joinDuel(id, cardA); // bob does not own alice's card
    }

    function test_createDuel_rejectsNonOwner() public {
        vm.prank(bob);
        vm.expectRevert(BlitzArena.NotCardOwner.selector);
        arena.createDuel(cardA);
    }

    /// @dev cardOf is stale after an ERC-721 transfer; ownership must use ownerOf.
    function test_createDuel_gatesOnOwnerOfNotCardOf() public {
        vm.prank(bob);
        cards.transferFrom(bob, carol, cardB);
        assertEq(cards.cardOf(bob), cardB); // stale pointer

        vm.prank(bob);
        vm.expectRevert(BlitzArena.NotCardOwner.selector);
        arena.createDuel(cardB);
    }

    // --------------------------------------------------------------- storage

    function test_getDuels_paginates() public {
        (uint256 id,) = _start();
        assertEq(arena.duelCount(), 1);

        BlitzArena.Duel[] memory all = arena.getDuels(0, 10);
        assertEq(all.length, 1);
        assertEq(all[0].p1, alice);
        assertEq(all[0].p2, bob);
        assertEq(uint256(all[0].card1), cardA);
        assertEq(uint256(all[0].card2), cardB);
        assertTrue(all[0].status == BlitzArena.Status.Active);

        BlitzArena.Duel[] memory only = arena.getDuels(id, 1);
        assertEq(only.length, 1);
        assertEq(only[0].p1, alice);

        BlitzArena.Duel[] memory past = arena.getDuels(1, 10);
        assertEq(past.length, 0);

        BlitzArena.Duel[] memory zero = arena.getDuels(0, 0);
        assertEq(zero.length, 0);
    }

    /// @dev A Duel must occupy exactly 3 storage slots (spec §4.2).
    ///      `duels` is the only state variable, so its length lives in slot 0 and
    ///      its elements start at keccak256(abi.encode(uint256(0))). If a storage
    ///      variable is ever declared before `duels`, update the base slot here.
    function test_duel_occupiesThreeStorageSlots() public {
        _start();
        bytes32 base = keccak256(abi.encode(uint256(0)));
        assertGt(uint256(vm.load(address(arena), base)), 0); // slot 1: P1 side
        assertGt(uint256(vm.load(address(arena), bytes32(uint256(base) + 1))), 0); // slot 2: P2 side
        assertGt(uint256(vm.load(address(arena), bytes32(uint256(base) + 2))), 0); // slot 3: meta
        assertEq(uint256(vm.load(address(arena), bytes32(uint256(base) + 3))), 0); // nothing beyond
    }

    // ------------------------------------------------------------------- fuzz

    function testFuzz_attack_neverOverflows(uint16 taps, uint8 blocks, bool skill) public {
        (uint256 id, uint32 s) = _start();
        vm.roll(s + uint32(blocks % 67));
        vm.prank(alice);
        arena.attack(id, taps, skill);

        BlitzArena.Duel memory d = _duel(id);
        assertLe(d.hp1, d.maxHp1);
        assertLe(d.hp2, d.maxHp2);
    }
}
