// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";

import {CardBattle} from "../src/CardBattle.sol";

/// @dev Test-only harness: fixed stats let the maths be asserted against known
///      numbers, and setProgress recreates otherwise unreachable end states.
contract CardBattleHarness is CardBattle {
    bool private fixedStats;
    uint8 private fixedEl1;
    uint8 private fixedEl2;
    uint8 private fixedRar;
    uint16 private fixedAtk1;
    uint16 private fixedAtk2;
    uint16 private fixedHp1;
    uint16 private fixedHp2;

    function setFixed(uint8 el1, uint8 el2, uint8 rar, uint16 atk, uint16 hp) external {
        _setFixed(el1, el2, rar, atk, atk, hp, hp);
    }

    function setFixedPerSide(uint8 el1, uint8 el2, uint8 rar, uint16 atk1, uint16 atk2, uint16 hp1, uint16 hp2)
        external
    {
        _setFixed(el1, el2, rar, atk1, atk2, hp1, hp2);
    }

    function _setFixed(uint8 el1, uint8 el2, uint8 rar, uint16 atk1, uint16 atk2, uint16 hp1, uint16 hp2) private {
        fixedStats = true;
        fixedEl1 = el1;
        fixedEl2 = el2;
        fixedRar = rar;
        fixedAtk1 = atk1;
        fixedAtk2 = atk2;
        fixedHp1 = hp1;
        fixedHp2 = hp2;
    }

    function clearFixed() external {
        fixedStats = false;
    }

    function drawStats(uint256 id, uint8 side, uint8 drawNo)
        external
        view
        returns (uint8 el, uint8 rar, uint16 atk, uint16 hp)
    {
        return _drawStats(id, side, drawNo);
    }

    function setProgress(uint256 id, uint8 side, uint8 drawn, uint16 placed, uint8 placedCount) external {
        Match storage m = _matches[id - 1];
        Side storage s = side == 1 ? m.s1 : m.s2;
        s.drawn = drawn;
        s.placed = placed;
        s.placedCount = placedCount;
    }

    function _drawStats(uint256 id, uint8 side, uint8 drawNo)
        internal
        view
        override
        returns (uint8 el, uint8 rar, uint16 atk, uint16 hp)
    {
        if (fixedStats) {
            return side == 1 ? (fixedEl1, fixedRar, fixedAtk1, fixedHp1) : (fixedEl2, fixedRar, fixedAtk2, fixedHp2);
        }
        return super._drawStats(id, side, drawNo);
    }
}

contract CardBattleTest is Test {
    event MatchCreated(uint256 indexed id, address indexed p1);
    event MatchJoined(uint256 indexed id, address indexed p2);
    event Acted(
        uint256 indexed id, address indexed player, uint8 drawnNo, uint8 placedNo, bool special, uint256 damage, bool ko
    );
    event MatchEnded(uint256 indexed id, address indexed winner);

    CardBattleHarness private battle;

    address private alice;
    address private bob;
    address private carol;

    function setUp() public {
        battle = new CardBattleHarness();
        alice = makeAddr("alice");
        bob = makeAddr("bob");
        carol = makeAddr("carol");
        vm.prevrandao(bytes32(uint256(0x1234)));
    }

    // ---------------------------------------------------------------- helpers

    function _create() private returns (uint256 id) {
        vm.prank(alice);
        id = battle.createMatch();
    }

    function _open() private returns (uint256 id) {
        id = _create();
        vm.prank(bob);
        battle.joinMatch(id);
    }

    function _mover(CardBattle.MatchView memory v) private pure returns (address) {
        return v.turn == 1 ? v.p1 : v.p2;
    }

    function _actMover(uint256 id, uint8 handIdx, bool special) private returns (CardBattle.MatchView memory) {
        CardBattle.MatchView memory v = battle.getMatch(id);
        vm.prank(_mover(v));
        battle.act(id, handIdx, special);
        return battle.getMatch(id);
    }

    /// @dev Make no-op moves until `side` is to move. A no-op turn still hands
    ///      the opponent their next draw.
    function _waitFor(uint256 id, uint8 side) private returns (CardBattle.MatchView memory v) {
        for (uint256 i; i < 12; ++i) {
            v = battle.getMatch(id);
            if (v.turn == side) return v;
            vm.prank(_mover(v));
            battle.act(id, 255, false);
        }
        revert("turn never reached");
    }

    function _place(uint256 id, uint8 side, uint8 handIdx) private {
        CardBattle.MatchView memory v = _waitFor(id, side);
        vm.prank(side == 1 ? v.p1 : v.p2);
        battle.act(id, handIdx, false);
    }

    /// @dev p1 places draws 0, 1 and 2; p2 places draw 0. Ends on p1's turn.
    function _p1BoardOfThreeAndP2BoardOfOne(uint256 id) private {
        _place(id, 1, 0);
        _place(id, 2, 0);
        _place(id, 1, 1);
        _place(id, 2, 255);
        _place(id, 1, 2);
        _place(id, 2, 255);
    }

    function _statsHash(uint8 el, uint8 rar, uint16 atk, uint16 hp) private pure returns (bytes32) {
        return keccak256(abi.encode(el, rar, atk, hp));
    }

    function _drawHash(uint256 id, uint8 side, uint8 drawNo) private view returns (bytes32) {
        (uint8 el, uint8 rar, uint16 atk, uint16 hp) = battle.drawStats(id, side, drawNo);
        return _statsHash(el, rar, atk, hp);
    }

    // ----------------------------------------------------------- create / join

    function test_createMatchDrawsOneCardAndIsOpen() public {
        uint256 id = _create();
        CardBattle.MatchView memory v = battle.getMatch(id);

        assertEq(battle.matchCount(), 1);
        assertEq(id, 1);
        assertEq(v.p1, alice);
        assertEq(v.p2, address(0));
        assertEq(uint8(v.status), uint8(CardBattle.Status.Open));
        assertEq(v.turn, 0);
        assertEq(v.drawn1, 1);
        assertEq(v.drawn2, 0);
        assertEq(v.placed1, 0);
        assertEq(v.placed2, 0);
        assertEq(v.special1, false);
        assertEq(v.special2, false);
        assertEq(v.lastMoveBlock, uint32(block.number));

        for (uint8 i; i < 3; ++i) {
            assertEq(v.board1[i], 255);
            assertEq(v.board2[i], 255);
        }

        (uint8 el, uint8 rar, uint16 atk, uint16 hp) = battle.drawStats(id, 1, 0);
        assertEq(v.el1[0], el);
        assertEq(v.rar1[0], rar);
        assertEq(v.atk1[0], atk);
        assertEq(v.maxHp1[0], hp);
        assertEq(v.hp1[0], hp);
        assertEq(v.atk2[0], 0);
        assertEq(v.hp2[0], 0);
    }

    function test_joinDrawsForP2AndStartsMatch() public {
        uint256 id = _create();

        vm.prank(alice);
        vm.expectRevert(CardBattle.CannotJoinOwnMatch.selector);
        battle.joinMatch(id);

        vm.prevrandao(bytes32(uint256(0xBEEF)));
        vm.prank(bob);
        vm.expectEmit(true, true, false, false, address(battle));
        emit MatchJoined(id, bob);
        battle.joinMatch(id);

        CardBattle.MatchView memory v = battle.getMatch(id);
        assertEq(uint8(v.status), uint8(CardBattle.Status.Active));
        assertEq(v.p2, bob);
        assertEq(v.drawn1, 1);
        assertEq(v.drawn2, 1);
        assertEq(v.lastMoveBlock, uint32(block.number));
        assertTrue(v.turn == 1 || v.turn == 2);

        (uint8 el, uint8 rar, uint16 atk, uint16 hp) = battle.drawStats(id, 2, 0);
        assertEq(v.el2[0], el);
        assertEq(v.rar2[0], rar);
        assertEq(v.atk2[0], atk);
        assertEq(v.maxHp2[0], hp);
        assertEq(v.hp2[0], hp);

        vm.prank(carol);
        vm.expectRevert(CardBattle.MatchNotOpen.selector);
        battle.joinMatch(id);

        vm.prank(bob);
        vm.expectRevert(CardBattle.MatchNotOpen.selector);
        battle.joinMatch(id);

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(CardBattle.MatchNotFound.selector, 99));
        battle.joinMatch(99);
    }

    function test_firstTurnIsCoinflipBothOutcomesAppear() public {
        bool seen1;
        bool seen2;

        for (uint256 i; i < 12; ++i) {
            vm.prevrandao(bytes32(uint256(keccak256(abi.encode("first-turn", i)))));
            uint256 id = _open();
            uint8 turn = battle.getMatch(id).turn;
            assertTrue(turn == 1 || turn == 2);
            if (turn == 1) seen1 = true;
            else seen2 = true;
        }

        assertTrue(seen1, "p1 must sometimes move first");
        assertTrue(seen2, "p2 must sometimes move first");
    }

    // ------------------------------------------------------------- basic errors

    function test_actAndTimeoutNeedAnActiveMatch() public {
        uint256 id = _create();

        vm.prank(alice);
        vm.expectRevert(CardBattle.MatchNotActive.selector);
        battle.act(id, 255, false);

        vm.prank(alice);
        vm.expectRevert(CardBattle.MatchNotActive.selector);
        battle.claimTimeout(id);

        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(CardBattle.MatchNotFound.selector, 0));
        battle.getMatch(0);
    }

    function test_onlyPlayersAndOnlyOnTurnCanAct() public {
        uint256 id = _open();
        CardBattle.MatchView memory v = battle.getMatch(id);
        address idle = v.turn == 1 ? v.p2 : v.p1;

        vm.prank(idle);
        vm.expectRevert(CardBattle.NotYourTurn.selector);
        battle.act(id, 255, false);

        vm.prank(carol);
        vm.expectRevert(CardBattle.NotPlayer.selector);
        battle.act(id, 255, false);
    }

    // ---------------------------------------------------------------- drawing

    function test_drawStatsAreDeterministicPerSeed() public {
        vm.prevrandao(bytes32(uint256(0xABC)));
        bytes32 again = _drawHash(7, 1, 3);
        assertEq(_drawHash(7, 1, 3), again, "same inputs must reproduce the card");
        assertTrue(_drawHash(7, 1, 4) != again, "different draw numbers must differ");
        assertTrue(_drawHash(7, 2, 3) != again, "different sides must differ");
    }

    function test_drawStatsStayInsideTheGachaDistribution() public {
        bool[3] memory elementSeen;
        bool[4] memory raritySeen;

        for (uint256 i; i < 400; ++i) {
            vm.prevrandao(bytes32(uint256(keccak256(abi.encode("draw-distribution", i)))));
            (uint8 el, uint8 rar, uint16 atk, uint16 hp) = battle.drawStats(1, 1, 0);

            assertLt(el, 3);
            assertLe(rar, 3);
            assertGe(atk, 10 + uint256(rar));
            assertLe(atk, 14 + uint256(rar));
            assertGe(hp, 1500 + 100 * uint256(rar));
            assertLe(hp, 1800 + 100 * uint256(rar));

            elementSeen[el] = true;
            raritySeen[rar] = true;
        }

        assertTrue(elementSeen[0] && elementSeen[1] && elementSeen[2], "all elements must appear");
        assertTrue(raritySeen[0] && raritySeen[1] && raritySeen[2], "common/rare/epic must appear");
    }

    function test_tenDrawsAreNotAllIdentical() public {
        vm.prevrandao(bytes32(uint256(0x5151)));
        bytes32[10] memory hashes;
        for (uint8 i; i < 10; ++i) {
            (uint8 el, uint8 rar, uint16 atk, uint16 hp) = battle.drawStats(1, 1, i);
            hashes[i] = _statsHash(el, rar, atk, hp);
        }

        uint256 distinct;
        for (uint8 i; i < 10; ++i) {
            bool duplicate;
            for (uint8 j; j < i; ++j) {
                if (hashes[i] == hashes[j]) duplicate = true;
            }
            if (!duplicate) ++distinct;
        }
        assertGt(distinct, 1, "a ten-card pile must not be a single repeated card");
    }

    function test_actHandsTheNextPlayerACard() public {
        uint256 id = _open();
        CardBattle.MatchView memory v = battle.getMatch(id);
        uint8 side = v.turn;
        uint8 nextSide = side == 1 ? 2 : 1;
        uint8 moverDrawnBefore = side == 1 ? v.drawn1 : v.drawn2;
        uint8 nextDrawnBefore = nextSide == 1 ? v.drawn1 : v.drawn2;
        address player = side == 1 ? v.p1 : v.p2;

        (uint8 el, uint8 rar, uint16 atk, uint16 hp) = battle.drawStats(id, nextSide, nextDrawnBefore);

        vm.expectEmit(true, true, false, true, address(battle));
        emit Acted(id, player, nextDrawnBefore, 255, false, 0, false);
        vm.prank(player);
        battle.act(id, 255, false);

        CardBattle.MatchView memory afterAct = battle.getMatch(id);
        if (nextSide == 1) {
            assertEq(afterAct.drawn1, nextDrawnBefore + 1);
            assertEq(afterAct.el1[nextDrawnBefore], el);
            assertEq(afterAct.rar1[nextDrawnBefore], rar);
            assertEq(afterAct.atk1[nextDrawnBefore], atk);
            assertEq(afterAct.maxHp1[nextDrawnBefore], hp);
            assertEq(afterAct.hp1[nextDrawnBefore], hp);
        } else {
            assertEq(afterAct.drawn2, nextDrawnBefore + 1);
            assertEq(afterAct.el2[nextDrawnBefore], el);
            assertEq(afterAct.rar2[nextDrawnBefore], rar);
            assertEq(afterAct.atk2[nextDrawnBefore], atk);
            assertEq(afterAct.maxHp2[nextDrawnBefore], hp);
            assertEq(afterAct.hp2[nextDrawnBefore], hp);
        }
        if (side == 1) {
            assertEq(afterAct.drawn1, moverDrawnBefore, "acting must not draw for the mover");
        } else {
            assertEq(afterAct.drawn2, moverDrawnBefore, "acting must not draw for the mover");
        }
        assertEq(afterAct.turn, nextSide);
        assertEq(afterAct.lastMoveBlock, uint32(block.number));
    }

    function test_cardDrawnLastTurnIsInHandAndPlaceableBeforeAttacking() public {
        battle.setFixed(0, 0, 0, 10, 10000);
        uint256 id = _open();
        CardBattle.MatchView memory v = battle.getMatch(id);
        uint8 first = v.turn;
        uint8 second = first == 1 ? 2 : 1;

        // The first mover skips; the second player's next card lands in hand.
        vm.prank(first == 1 ? v.p1 : v.p2);
        battle.act(id, 255, false);

        v = battle.getMatch(id);
        uint8 drawnBefore = second == 1 ? v.drawn1 : v.drawn2;
        assertEq(drawnBefore, 2, "the opponent must end the turn with two cards in hand");
        assertEq(v.turn, second);

        // At the start of their turn the freshly drawn card is already in hand,
        // so it can be placed without any draw happening inside this act.
        vm.prank(second == 1 ? v.p1 : v.p2);
        battle.act(id, 1, false);

        v = battle.getMatch(id);
        assertEq(second == 1 ? v.board1[0] : v.board2[0], 1);
        assertEq(second == 1 ? v.drawn1 : v.drawn2, drawnBefore, "the mover must not draw at act start");
    }

    function test_drawStopsAfterTenCards() public {
        battle.setFixed(0, 0, 0, 0, 20000);
        uint256 id = _open();

        for (uint256 i; i < 20; ++i) {
            _actMover(id, 255, false);
        }

        CardBattle.MatchView memory v = battle.getMatch(id);
        assertEq(v.drawn1, 10);
        assertEq(v.drawn2, 10);

        address player = _mover(v);
        vm.expectEmit(true, true, false, true, address(battle));
        emit Acted(id, player, 255, 255, false, 0, false);
        vm.prank(player);
        battle.act(id, 255, false);

        v = battle.getMatch(id);
        assertEq(v.drawn1, 10);
        assertEq(v.drawn2, 10);
    }

    // -------------------------------------------------------------- placement

    function test_placementFillsSmallestEmptySlotAndRejectsBadIndices() public {
        battle.setFixed(0, 0, 0, 10, 10000);
        uint256 id = _open();

        _place(id, 1, 0);
        CardBattle.MatchView memory v = battle.getMatch(id);
        assertEq(v.board1[0], 0);
        assertEq(v.board1[1], 255);
        assertEq(v.placed1, 1);
        assertEq(v.hp1[0], v.maxHp1[0]);

        _place(id, 2, 0);
        _place(id, 1, 1);
        v = battle.getMatch(id);
        assertEq(v.board1[1], 1);
        assertEq(v.placed1, 3);

        _place(id, 2, 255);
        _place(id, 1, 2);
        v = battle.getMatch(id);
        assertEq(v.board1[2], 2);
        assertEq(v.placed1, 7);

        _place(id, 2, 255);
        v = _waitFor(id, 1);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(CardBattle.CardNotInHand.selector, 0));
        battle.act(id, 0, false);

        vm.prank(alice);
        vm.expectRevert(CardBattle.NoEmptySlot.selector);
        battle.act(id, 3, false);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(CardBattle.InvalidHandIndex.selector, 10));
        battle.act(id, 10, false);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(CardBattle.CardNotInHand.selector, 9));
        battle.act(id, 9, false);
    }

    function test_afterKoTheClearedSlotIsReusedFirst() public {
        battle.setFixedPerSide(0, 0, 0, 10, 10, 10000, 600);
        uint256 id = _open();

        _place(id, 1, 0); // p1 places, p2 board empty -> no attack
        _place(id, 2, 0); // p2 places and hits p1
        _waitFor(id, 1);
        vm.prank(alice);
        battle.act(id, 255, false); // p1 hits p2: 600 -> 250

        _waitFor(id, 2);
        vm.prank(bob);
        battle.act(id, 255, false); // p2 hits p1

        _waitFor(id, 1);
        vm.prank(alice);
        battle.act(id, 255, false); // p1 hits p2: KO

        CardBattle.MatchView memory v = battle.getMatch(id);
        assertEq(v.board2[0], 255);
        assertEq(v.score1, 1);

        _place(id, 2, 1);
        v = battle.getMatch(id);
        assertEq(v.board2[0], 1, "the smallest empty slot is slot 0 again");
    }

    // ----------------------------------------------------------------- attack

    function test_attackSumsEveryBoardCard() public {
        battle.setFixed(0, 0, 0, 10, 10000);
        uint256 id = _open();
        _p1BoardOfThreeAndP2BoardOfOne(id);

        CardBattle.MatchView memory v = _waitFor(id, 1);
        assertEq(v.board1[0], 0);
        assertEq(v.board1[1], 1);
        assertEq(v.board1[2], 2);
        assertEq(v.board2[0], 0);

        uint256 expected = 3 * (uint256(10) * battle.DAMAGE_SCALE() * battle.elementMult(0, 0)) / 100;
        uint16 hpBefore = v.hp2[0];
        uint8 drawnNo = v.drawn2;

        vm.expectEmit(true, true, false, true, address(battle));
        emit Acted(id, alice, drawnNo, 255, false, expected, false);
        vm.prank(alice);
        battle.act(id, 255, false);

        CardBattle.MatchView memory afterAct = battle.getMatch(id);
        assertEq(afterAct.hp2[0], uint16(hpBefore - expected));
        assertEq(afterAct.score1, 0);
        assertEq(afterAct.turn, 2);
        assertEq(uint8(afterAct.status), uint8(CardBattle.Status.Active));
    }

    function test_elementMultiplierAppliesBothWays() public {
        battle.setFixed(1, 0, 0, 10, 10000); // p1 Water, p2 Fire
        uint256 id = _open();

        _place(id, 1, 0);
        _place(id, 2, 0);

        _waitFor(id, 1);
        uint256 expectedStrong = (uint256(10) * battle.DAMAGE_SCALE() * 150) / 100;
        vm.prank(alice);
        battle.act(id, 255, false);
        CardBattle.MatchView memory v = battle.getMatch(id);
        assertEq(v.hp2[0], uint16(10000 - expectedStrong));

        _waitFor(id, 2);
        uint16 hpBeforeWeak = battle.getMatch(id).hp1[0];
        uint256 expectedWeak = (uint256(10) * battle.DAMAGE_SCALE() * 75) / 100;
        vm.prank(bob);
        battle.act(id, 255, false);
        v = battle.getMatch(id);
        assertEq(v.hp1[0], uint16(hpBeforeWeak - expectedWeak));
    }

    function test_noAttackWithoutAnAttacker() public {
        battle.setFixed(0, 0, 0, 10, 10000);
        uint256 id = _open();
        CardBattle.MatchView memory v = _waitFor(id, 1);

        vm.expectEmit(true, true, false, true, address(battle));
        emit Acted(id, alice, v.drawn2, 255, false, 0, false);
        vm.prank(alice);
        battle.act(id, 255, false);

        v = battle.getMatch(id);
        assertEq(v.turn, 2);
        assertEq(v.score1, 0);
    }

    function test_noAttackWithoutATarget() public {
        battle.setFixed(0, 0, 0, 10, 10000);
        uint256 id = _open();

        _place(id, 1, 0);
        _place(id, 2, 255);
        CardBattle.MatchView memory v = _waitFor(id, 1);

        vm.prank(alice);
        battle.act(id, 255, false);
        v = battle.getMatch(id);
        assertEq(v.score1, 0);
        assertEq(v.hp2[0], v.maxHp2[0]);
        assertEq(v.turn, 2);
    }

    // ---------------------------------------------------------------- special

    function test_specialDoublesOncePerMatchPerPlayer() public {
        battle.setFixed(0, 0, 0, 10, 10000);
        uint256 id = _open();

        _place(id, 1, 0);
        _place(id, 2, 0);

        _waitFor(id, 1);
        vm.prank(alice);
        battle.act(id, 255, true);
        CardBattle.MatchView memory v = battle.getMatch(id);
        assertTrue(v.special1);
        assertFalse(v.special2);
        assertEq(v.hp2[0], 10000 - 700);

        _waitFor(id, 2);
        uint16 hpBeforeP2Special = battle.getMatch(id).hp1[0];
        vm.prank(bob);
        battle.act(id, 255, true);
        v = battle.getMatch(id);
        assertTrue(v.special2);
        assertEq(v.hp1[0], uint16(hpBeforeP2Special - 700));

        _waitFor(id, 1);
        vm.prank(alice);
        vm.expectRevert(CardBattle.SpecialAlreadyUsed.selector);
        battle.act(id, 255, true);

        vm.prank(alice);
        battle.act(id, 255, false);
        v = battle.getMatch(id);
        assertTrue(v.special1);
        assertEq(v.hp2[0], 9300 - 350);
    }

    function test_specialIsNotSpentWhenThereIsNoAttack() public {
        battle.setFixed(0, 0, 0, 10, 10000);
        uint256 id = _open();
        CardBattle.MatchView memory v = _waitFor(id, 1);

        vm.expectEmit(true, true, false, true, address(battle));
        emit Acted(id, alice, v.drawn2, 255, false, 0, false);
        vm.prank(alice);
        battle.act(id, 255, true);

        v = battle.getMatch(id);
        assertFalse(v.special1);
        assertEq(v.turn, 2);
    }

    // ------------------------------------------------------------ KO / scoring

    function test_koScoresDiscardsAndKeepsTurnOrder() public {
        // p1 Water 10 ATK / 5000 HP vs p2 Fire 10 ATK / 400 HP: p1 hits for
        // 525 and one-shots, p2 hits back for only 262.
        battle.setFixedPerSide(1, 0, 0, 10, 10, 5000, 400);
        uint256 id = _open();

        _place(id, 1, 0); // p1 places, p2 board empty -> no attack
        _place(id, 2, 0); // p2 places and hits p1 for 262

        CardBattle.MatchView memory v = _waitFor(id, 1);
        uint16 p1HpBefore = v.hp1[0];
        uint8 drawnNo = v.drawn2;

        vm.expectEmit(true, true, false, true, address(battle));
        emit Acted(id, alice, drawnNo, 255, false, 525, true);
        vm.prank(alice);
        battle.act(id, 255, false);

        v = battle.getMatch(id);
        assertEq(v.hp2[0], 0, "KO card keeps hp at zero");
        assertEq(v.board2[0], 255, "KO card leaves the board");
        assertEq(v.hp1[0], p1HpBefore, "attacker is untouched by its own attack");
        assertEq(v.score1, 1);
        assertEq(v.score2, 0);
        assertEq(v.turn, 2, "the side that lost the card moves next");
        assertEq(uint8(v.status), uint8(CardBattle.Status.Active));
    }

    function test_twoKosWinTheMatchAndFreezeIt() public {
        battle.setFixedPerSide(1, 0, 0, 10, 10, 5000, 400);
        uint256 id = _open();

        _place(id, 1, 0);
        _place(id, 2, 0); // p2 places and hits p1
        _waitFor(id, 1);
        vm.prank(alice);
        battle.act(id, 255, false); // first KO

        _place(id, 2, 1); // p2 fills slot 0 again and hits p1

        CardBattle.MatchView memory v = _waitFor(id, 1);
        uint8 p2DrawnBefore = v.drawn2;
        vm.expectEmit(true, true, false, true, address(battle));
        emit Acted(id, alice, 255, 255, false, 525, true);
        vm.expectEmit(true, true, false, true, address(battle));
        emit MatchEnded(id, alice);
        vm.prank(alice);
        battle.act(id, 255, false); // second KO

        v = battle.getMatch(id);
        assertEq(v.drawn2, p2DrawnBefore, "a finished match must not draw for the loser");
        assertEq(v.score1, 2);
        assertEq(v.score2, 0);
        assertEq(uint8(v.status), uint8(CardBattle.Status.P1Won));
        assertEq(v.turn, 0);

        vm.prank(alice);
        vm.expectRevert(CardBattle.MatchNotActive.selector);
        battle.act(id, 255, false);

        vm.prank(bob);
        vm.expectRevert(CardBattle.MatchNotActive.selector);
        battle.act(id, 255, false);

        vm.prank(bob);
        vm.expectRevert(CardBattle.MatchNotActive.selector);
        battle.claimTimeout(id);

        vm.prank(carol);
        vm.expectRevert(CardBattle.MatchNotOpen.selector);
        battle.joinMatch(id);
    }

    function test_exhaustedOpponentLosesEvenBeforeTwoKos() public {
        battle.setFixedPerSide(0, 0, 0, 10, 10, 10000, 300);
        uint256 id = _open();

        _place(id, 1, 0);
        _place(id, 2, 0); // p2 places and hits p1

        // Recreate the only state in which the rule can fire: p2 has placed all
        // ten draws, has no hand, and only one card is still on the board.
        battle.setProgress(id, 2, 10, 0x3FF, 10);

        CardBattle.MatchView memory v = _waitFor(id, 1);
        vm.expectEmit(true, true, false, true, address(battle));
        emit Acted(id, alice, 255, 255, false, 350, true);
        vm.expectEmit(true, true, false, true, address(battle));
        emit MatchEnded(id, alice);
        vm.prank(alice);
        battle.act(id, 255, false);

        v = battle.getMatch(id);
        assertEq(v.board2[0], 255);
        assertEq(v.score1, 1, "auto-loss does not award a second KO point");
        assertEq(uint8(v.status), uint8(CardBattle.Status.P1Won));
        assertEq(v.turn, 0);
    }

    // ---------------------------------------------------------------- timeout

    function test_claimTimeoutNeedsTheClockAndTheRightPlayer() public {
        uint256 id = _open();
        CardBattle.MatchView memory v = battle.getMatch(id);
        uint8 stalled = v.turn;
        address claimant = stalled == 1 ? v.p2 : v.p1;
        uint32 moveBlock = v.lastMoveBlock;

        vm.prank(stalled == 1 ? v.p1 : v.p2);
        vm.expectRevert(CardBattle.NotYourTurn.selector);
        battle.claimTimeout(id);

        vm.prank(carol);
        vm.expectRevert(CardBattle.NotPlayer.selector);
        battle.claimTimeout(id);

        vm.roll(block.number + 99);
        vm.prank(claimant);
        vm.expectRevert(CardBattle.TimeoutNotReached.selector);
        battle.claimTimeout(id);

        vm.roll(block.number + 1);
        vm.expectEmit(true, true, false, true, address(battle));
        emit MatchEnded(id, claimant);
        vm.prank(claimant);
        battle.claimTimeout(id);

        v = battle.getMatch(id);
        assertEq(uint8(v.status), claimant == v.p1 ? uint8(CardBattle.Status.P1Won) : uint8(CardBattle.Status.P2Won));
        assertEq(v.turn, 0);
        assertEq(v.lastMoveBlock, moveBlock);

        vm.prank(claimant);
        vm.expectRevert(CardBattle.MatchNotActive.selector);
        battle.claimTimeout(id);
    }

    function test_actionResetsTheTimeoutClock() public {
        uint256 id = _open();

        CardBattle.MatchView memory v = _actMover(id, 255, false);
        address claimant = v.turn == 1 ? v.p2 : v.p1;

        vm.roll(block.number + 99);
        vm.prank(claimant);
        vm.expectRevert(CardBattle.TimeoutNotReached.selector);
        battle.claimTimeout(id);

        vm.roll(block.number + 1);
        vm.prank(claimant);
        battle.claimTimeout(id);

        v = battle.getMatch(id);
        assertEq(uint8(v.status), claimant == v.p1 ? uint8(CardBattle.Status.P1Won) : uint8(CardBattle.Status.P2Won));
    }

    // -------------------------------------------------------------- match views

    function test_getMatchesWindowAndUnknownIds() public {
        vm.prank(alice);
        battle.createMatch();
        vm.prank(bob);
        battle.createMatch();
        vm.prank(alice);
        battle.createMatch();

        assertEq(battle.matchCount(), 3);

        CardBattle.MatchView[] memory all = battle.getMatches(0, 10);
        assertEq(all.length, 3);
        assertEq(all[0].p1, alice);
        assertEq(all[1].p1, bob);
        assertEq(all[2].p1, alice);
        assertEq(uint8(all[0].status), uint8(CardBattle.Status.Open));

        CardBattle.MatchView[] memory page = battle.getMatches(2, 2);
        assertEq(page.length, 2);
        assertEq(page[0].p1, bob);
        assertEq(page[1].p1, alice);

        assertEq(battle.getMatches(3, 64).length, 1);
        assertEq(battle.getMatches(4, 64).length, 0);
        assertEq(battle.getMatches(1, 0).length, 0);

        vm.expectRevert(abi.encodeWithSelector(CardBattle.MatchNotFound.selector, 99));
        battle.getMatch(99);
    }

    // ------------------------------------------------------------------ maths

    function test_elementMultiplierCycle() public view {
        assertEq(battle.elementMult(1, 0), 150); // Water beats Fire
        assertEq(battle.elementMult(0, 1), 75);
        assertEq(battle.elementMult(2, 1), 150); // Lightning beats Water
        assertEq(battle.elementMult(1, 2), 75);
        assertEq(battle.elementMult(0, 2), 150); // Fire beats Lightning
        assertEq(battle.elementMult(2, 0), 75);
        assertEq(battle.elementMult(0, 0), 100);
        assertEq(battle.elementMult(1, 1), 100);
        assertEq(battle.elementMult(2, 2), 100);
    }

    function test_averageActionsPerRoundStaysInRange() public view {
        // Typical card: ATK 12, HP 1700. One board card is the average attacker
        // in the early game; a KO should take 4-6 actions across matchups.
        uint256 totalHits;
        for (uint8 defender; defender < 3; ++defender) {
            uint256 dmg = (uint256(12) * battle.DAMAGE_SCALE() * battle.elementMult(0, defender)) / 100;
            totalHits += (1700 + dmg - 1) / dmg;
        }
        uint256 average = totalHits / 3;
        assertGe(average, 4);
        assertLe(average, 6);
        assertEq(battle.DAMAGE_SCALE(), 35);
    }

    // ------------------------------------------------------------------- fuzz

    function testFuzz_elementMult(uint8 a, uint8 d) public view {
        a = uint8(uint256(a) % 3);
        d = uint8(uint256(d) % 3);
        uint256 expected = (uint256(d) + 1) % 3 == a ? 150 : a == d ? 100 : 75;
        assertEq(battle.elementMult(a, d), expected);
    }

    function testFuzz_attackNeverUnderflowsHp(uint16 rawAtk, uint16 rawHp) public {
        uint16 atk = uint16(1 + (uint256(rawAtk) % 500));
        uint16 hp = uint16(1 + (uint256(rawHp) % 20000));
        // p1 is tanky enough to survive p2's placement attack (max 17500).
        battle.setFixedPerSide(0, 0, 0, atk, atk, 20000, hp);

        uint256 id = _open();
        _place(id, 1, 0);
        _place(id, 2, 0);

        CardBattle.MatchView memory v = _waitFor(id, 1);
        uint16 hpBefore = v.hp2[0];
        uint256 damage = (uint256(atk) * battle.DAMAGE_SCALE() * 100) / 100;

        vm.prank(alice);
        battle.act(id, 255, false);

        v = battle.getMatch(id);
        if (damage >= hpBefore) {
            assertEq(v.hp2[0], 0);
            assertEq(v.board2[0], 255);
            assertEq(v.score1, 1);
        } else {
            assertEq(v.hp2[0], uint16(uint256(hpBefore) - damage));
            assertEq(v.board2[0], 0);
            assertEq(v.score1, 0);
        }
        assertEq(v.turn, 2);
    }

    function testFuzz_actRejectsUnavailableHandIndex(uint8 handIdx) public {
        vm.assume(handIdx != 255);

        battle.setFixed(0, 0, 0, 10, 10000);
        uint256 id = _open();
        CardBattle.MatchView memory v = battle.getMatch(id);
        uint8 side = v.turn;
        uint8 drawn = side == 1 ? v.drawn1 : v.drawn2;
        address player = side == 1 ? v.p1 : v.p2;

        // Act no longer draws first, so only indices at or past the current hand
        // are invalid at the start of the match.
        vm.assume(handIdx >= drawn);

        vm.prank(player);
        if (handIdx >= 10) {
            vm.expectRevert(abi.encodeWithSelector(CardBattle.InvalidHandIndex.selector, handIdx));
        } else {
            vm.expectRevert(abi.encodeWithSelector(CardBattle.CardNotInHand.selector, handIdx));
        }
        battle.act(id, handIdx, false);
    }

    function testFuzz_placedMaskNeverExceedsTenBits(uint8 drawsToPlay) public {
        uint8 turns = uint8(uint256(drawsToPlay) % 4); // three board slots
        battle.setFixed(0, 0, 0, 10, 10000);
        uint256 id = _open();
        // When p2 moves first, `_waitFor` spends one p2 no-op turn that already
        // hands p1 the opening draw.
        uint8 firstMover = battle.getMatch(id).turn;

        for (uint8 i; i < turns; ++i) {
            _place(id, 1, i);
            _place(id, 2, 255);
        }

        CardBattle.MatchView memory v = battle.getMatch(id);
        assertEq(v.placed1, (uint16(1) << turns) - 1);
        assertEq(v.board1[0], turns == 0 ? 255 : 0);
        uint256 expectedDrawn = uint256(turns) + 1;
        if (turns > 0 && firstMover == 2) expectedDrawn += 1;
        assertEq(v.drawn1, expectedDrawn);
    }
}
