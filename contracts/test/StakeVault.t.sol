// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {NadCards} from "../src/NadCards.sol";
import {INadCards} from "../src/interfaces/INadCards.sol";
import {BlitzArena} from "../src/BlitzArena.sol";
import {StakeVault} from "../src/StakeVault.sol";

/// @dev Test-only harness that overwrites card stats so duel winners are deterministic.
contract StakeCardsHarness is NadCards {
    function setCard(uint256 id, Card memory c) external {
        _cards[id] = c;
    }
}

/// @dev A contract player: owns a card, plays a duel, and tries to re-enter `claim` when paid.
contract ReentrantPlayer {
    StakeVault public immutable vault;
    BlitzArena public immutable arena;
    uint256 public targetId;
    bool public reentered;
    bool public blocked;

    constructor(StakeVault vault_) {
        vault = vault_;
        arena = vault_.arena();
    }

    function create(uint256 cardId) external returns (uint256) {
        return arena.createDuel(cardId);
    }

    function stake(uint256 id) external payable {
        targetId = id;
        vault.stake{value: msg.value}(id);
    }

    function attack(uint256 id, uint16 taps) external {
        arena.attack(id, taps, false);
    }

    receive() external payable {
        try vault.claim(targetId) {
            reentered = true;
        } catch {
            blocked = true;
        }
    }
}

contract StakeVaultTest is Test {
    uint256 private constant STAKE = 0.1 ether;

    StakeCardsHarness private cards;
    BlitzArena private arena;
    StakeVault private vault;

    address private alice;
    address private bob;
    address private carol;

    uint256 private cardA;
    uint256 private cardB;

    function setUp() public {
        cards = new StakeCardsHarness();
        arena = new BlitzArena(INadCards(address(cards)));
        cards.setArena(address(arena));
        vault = new StakeVault(address(arena));

        alice = makeAddr("alice");
        bob = makeAddr("bob");
        carol = makeAddr("carol");
        vm.deal(alice, 10 ether);
        vm.deal(bob, 10 ether);
        vm.deal(carol, 10 ether);

        vm.prank(alice, alice);
        cardA = cards.freePull();
        vm.prank(bob, bob);
        cardB = cards.freePull();
        // Alice's card is strong, Bob's is weak: Alice wins any fight she attacks in.
        _setCard(cardA, 100, 1000, 0);
        _setCard(cardB, 100, 100, 0);
    }

    // ---------------------------------------------------------------- helpers

    function _setCard(uint256 id, uint16 atk, uint16 hp, uint8 element) private {
        cards.setCard(
            id, NadCards.Card({atk: atk, hp: hp, element: element, rarity: 0, wins: 0, losses: 0, mintedAt: 0})
        );
    }

    function _duel(uint256 id) private view returns (BlitzArena.Duel memory) {
        return arena.getDuels(id, 1)[0];
    }

    function _open() private returns (uint256 id) {
        vm.prank(alice);
        id = arena.createDuel(cardA);
    }

    function _join(uint256 id) private returns (uint32 startBlock_) {
        vm.prank(bob);
        arena.joinDuel(id, cardB);
        startBlock_ = _duel(id).startBlock;
    }

    function _start() private returns (uint256 id, uint32 startBlock_) {
        id = _open();
        startBlock_ = _join(id);
    }

    function _stake(address who, uint256 id, uint256 amount) private {
        vm.prank(who);
        vault.stake{value: amount}(id);
    }

    /// @dev Both players stake `amount` during the countdown.
    function _bothStake(uint256 id, uint256 amount) private {
        _stake(alice, id, amount);
        _stake(bob, id, amount);
    }

    /// @dev Alice taps 30x per block until the duel leaves Active.
    function _ko(uint256 id, uint32 startBlock_) private {
        uint32 b = startBlock_;
        for (uint256 i; i < 60; ++i) {
            b += 1;
            vm.roll(b);
            vm.prank(alice);
            arena.attack(id, 30, false);
            if (_duel(id).status != BlitzArena.Status.Active) return;
        }
        revert("duel did not end");
    }

    function _koAndSettle(uint256 id, uint32 startBlock_) private {
        _ko(id, startBlock_);
        arena.settle(id);
    }

    function _rake(uint256 amount) private pure returns (uint256) {
        return (2 * amount * 500) / 10_000;
    }

    // ------------------------------------------------------------ 1. winner payout

    function test_claim_winnerGetsPotMinusRake() public {
        (uint256 id, uint32 s) = _start();
        _bothStake(id, STAKE);
        _koAndSettle(id, s);

        uint256 rake = _rake(STAKE);
        uint256 aliceBefore = alice.balance;
        uint256 bobBefore = bob.balance;

        vm.expectEmit(true, true, false, true, address(vault));
        emit StakeVault.Claimed(id, alice, 2 * STAKE - rake, rake);
        vm.prank(carol);
        vault.claim(id);

        assertEq(alice.balance - aliceBefore, 2 * STAKE - rake);
        assertEq(bob.balance, bobBefore);
        assertEq(vault.rakeBalance(), rake);
        assertEq(address(vault).balance, rake);
        assertEq(rake, 0.01 ether);
    }

    function test_claim_p2WinnerGetsPotMinusRake() public {
        // Flip the matchup: Bob's card dominates and Bob taps.
        _setCard(cardA, 100, 100, 0);
        _setCard(cardB, 100, 1000, 0);
        (uint256 id, uint32 s) = _start();
        _bothStake(id, STAKE);

        for (uint32 b = s + 1; b < s + 60; ++b) {
            vm.roll(b);
            vm.prank(bob);
            arena.attack(id, 30, false);
            if (_duel(id).status != BlitzArena.Status.Active) break;
        }
        arena.settle(id);
        assertEq(uint8(_duel(id).status), uint8(BlitzArena.Status.P2Won));

        uint256 bobBefore = bob.balance;
        vault.claim(id);
        assertEq(bob.balance - bobBefore, 2 * STAKE - _rake(STAKE));
        assertEq(vault.rakeBalance(), _rake(STAKE));
    }

    function test_stake_emitsStaked() public {
        (uint256 id,) = _start();
        vm.expectEmit(true, true, false, true, address(vault));
        emit StakeVault.Staked(id, alice, STAKE);
        _stake(alice, id, STAKE);

        (uint128 amount, uint32 openedBlock, bool p1Staked, bool p2Staked, bool claimed) = vault.stakes(id);
        assertEq(amount, STAKE);
        assertEq(openedBlock, uint32(block.number));
        assertTrue(p1Staked);
        assertFalse(p2Staked);
        assertFalse(claimed);
    }

    // ------------------------------------------------------------ 2. draw

    function test_claim_drawRefundsBothNoRake() public {
        _setCard(cardA, 100, 500, 0);
        _setCard(cardB, 100, 500, 0);
        (uint256 id, uint32 s) = _start();
        _bothStake(id, STAKE);

        vm.roll(uint256(s) + arena.DUEL_BLOCKS());
        arena.settle(id);
        assertEq(uint8(_duel(id).status), uint8(BlitzArena.Status.Draw));

        uint256 aliceBefore = alice.balance;
        uint256 bobBefore = bob.balance;

        vm.expectEmit(true, true, false, true, address(vault));
        emit StakeVault.Claimed(id, alice, STAKE, 0);
        vm.expectEmit(true, true, false, true, address(vault));
        emit StakeVault.Claimed(id, bob, STAKE, 0);
        vault.claim(id);

        assertEq(alice.balance - aliceBefore, STAKE);
        assertEq(bob.balance - bobBefore, STAKE);
        assertEq(vault.rakeBalance(), 0);
        assertEq(address(vault).balance, 0);
    }

    // ------------------------------------------------------------ 3. one side only

    function test_claim_onlyP1Staked_refundsNoRake() public {
        (uint256 id, uint32 s) = _start();
        _stake(alice, id, STAKE);
        _koAndSettle(id, s); // alice wins, but nobody matched her stake

        uint256 aliceBefore = alice.balance;
        uint256 bobBefore = bob.balance;
        vault.claim(id);
        assertEq(alice.balance - aliceBefore, STAKE);
        assertEq(bob.balance, bobBefore);
        assertEq(vault.rakeBalance(), 0);
        assertEq(address(vault).balance, 0);
    }

    function test_claim_onlyP2Staked_refundsEvenWhenP2Loses() public {
        (uint256 id, uint32 s) = _start();
        _stake(bob, id, STAKE);
        _koAndSettle(id, s); // bob loses, but alice never staked

        uint256 aliceBefore = alice.balance;
        uint256 bobBefore = bob.balance;
        vault.claim(id);
        assertEq(bob.balance - bobBefore, STAKE);
        assertEq(alice.balance, aliceBefore);
        assertEq(vault.rakeBalance(), 0);
        assertEq(address(vault).balance, 0);
    }

    // ------------------------------------------------------------ 4. staking window

    function test_stake_atStartBlock_reverts() public {
        (uint256 id, uint32 s) = _start();
        _stake(alice, id, STAKE);
        vm.roll(s);
        vm.prank(bob);
        vm.expectRevert(StakeVault.StakingClosed.selector);
        vault.stake{value: STAKE}(id);
    }

    function test_stake_lastCountdownBlock_works() public {
        (uint256 id, uint32 s) = _start();
        _stake(alice, id, STAKE);
        vm.roll(s - 1);
        _stake(bob, id, STAKE);
        (,, bool p1Staked, bool p2Staked,) = vault.stakes(id);
        assertTrue(p1Staked && p2Staked);
    }

    function test_stake_finishedDuel_reverts() public {
        (uint256 id, uint32 s) = _start();
        _ko(id, s);
        vm.prank(alice);
        vm.expectRevert(StakeVault.StakingClosed.selector);
        vault.stake{value: STAKE}(id);

        arena.settle(id);
        vm.prank(bob);
        vm.expectRevert(StakeVault.StakingClosed.selector);
        vault.stake{value: STAKE}(id);
    }

    // ------------------------------------------------------------ 5. amounts

    function test_stake_secondAmountMismatch_reverts() public {
        (uint256 id,) = _start();
        _stake(alice, id, STAKE);
        vm.prank(bob);
        vm.expectRevert(StakeVault.AmountMismatch.selector);
        vault.stake{value: STAKE + 1}(id);
    }

    function test_stake_outOfRange_reverts() public {
        (uint256 id,) = _start();
        uint256 minStake = vault.MIN_STAKE();
        uint256 maxStake = vault.MAX_STAKE();

        vm.prank(alice);
        vm.expectRevert(StakeVault.BadAmount.selector);
        vault.stake{value: minStake - 1}(id);

        vm.prank(alice);
        vm.expectRevert(StakeVault.BadAmount.selector);
        vault.stake{value: 0}(id);

        vm.prank(alice);
        vm.expectRevert(StakeVault.BadAmount.selector);
        vault.stake{value: maxStake + 1}(id);

        // The bounds themselves are valid.
        _stake(alice, id, minStake);
        _stake(bob, id, minStake);
    }

    function test_stake_maxBoundWorks() public {
        (uint256 id,) = _start();
        _stake(alice, id, 1 ether);
        _stake(bob, id, 1 ether);
        assertEq(address(vault).balance, 2 ether);
    }

    function test_stake_twice_reverts() public {
        (uint256 id,) = _start();
        _stake(alice, id, STAKE);
        vm.prank(alice);
        vm.expectRevert(StakeVault.AlreadyStaked.selector);
        vault.stake{value: STAKE}(id);

        _stake(bob, id, STAKE);
        vm.prank(bob);
        vm.expectRevert(StakeVault.AlreadyStaked.selector);
        vault.stake{value: STAKE}(id);
    }

    // ------------------------------------------------------------ 6. participants / unknown

    function test_stake_nonParticipant_reverts() public {
        (uint256 id,) = _start();
        vm.prank(carol);
        vm.expectRevert(StakeVault.NotParticipant.selector);
        vault.stake{value: STAKE}(id);
    }

    function test_stake_openDuel_onlyP1() public {
        uint256 id = _open();
        vm.prank(bob);
        vm.expectRevert(StakeVault.NotParticipant.selector);
        vault.stake{value: STAKE}(id);
        vm.prank(carol);
        vm.expectRevert(StakeVault.NotParticipant.selector);
        vault.stake{value: STAKE}(id);

        _stake(alice, id, STAKE); // Open duel: p1 may stake
        assertEq(address(vault).balance, STAKE);
    }

    function test_stake_unknownDuel_reverts() public {
        vm.prank(alice);
        vm.expectRevert(StakeVault.UnknownDuel.selector);
        vault.stake{value: STAKE}(0);

        _open();
        vm.prank(alice);
        vm.expectRevert(StakeVault.UnknownDuel.selector);
        vault.stake{value: STAKE}(1);
    }

    function test_claim_unknownDuel_reverts() public {
        vm.expectRevert(StakeVault.UnknownDuel.selector);
        vault.claim(0);
    }

    // ------------------------------------------------------------ 7. idempotent / third party

    function test_claim_twice_secondIsSilentNoop() public {
        (uint256 id, uint32 s) = _start();
        _bothStake(id, STAKE);
        _koAndSettle(id, s);
        vault.claim(id);

        uint256 aliceBefore = alice.balance;
        uint256 vaultBefore = address(vault).balance;
        uint256 rakeBefore = vault.rakeBalance();

        vm.recordLogs();
        vault.claim(id);
        assertEq(vm.getRecordedLogs().length, 0);

        assertEq(alice.balance, aliceBefore);
        assertEq(address(vault).balance, vaultBefore);
        assertEq(vault.rakeBalance(), rakeBefore);
    }

    function test_claim_neverStaked_isSilentNoop() public {
        (uint256 id, uint32 s) = _start();
        _koAndSettle(id, s);
        vm.recordLogs();
        vault.claim(id);
        assertEq(vm.getRecordedLogs().length, 0);
        // An unsettled, unstaked duel is also a no-op, not a revert.
        uint256 id2 = _open();
        vault.claim(id2);
    }

    function test_claim_byThirdParty_paysWinnerNotCaller() public {
        (uint256 id, uint32 s) = _start();
        _bothStake(id, STAKE);
        _koAndSettle(id, s);

        uint256 carolBefore = carol.balance;
        uint256 aliceBefore = alice.balance;
        vm.prank(carol);
        vault.claim(id);
        assertEq(carol.balance, carolBefore);
        assertEq(alice.balance - aliceBefore, 2 * STAKE - _rake(STAKE));
    }

    // ------------------------------------------------------------ 8. not settled

    function test_claim_activeDuel_reverts() public {
        (uint256 id,) = _start();
        _bothStake(id, STAKE);
        vm.expectRevert(StakeVault.NotSettled.selector);
        vault.claim(id);
    }

    function test_claim_koButNotSettled_reverts() public {
        (uint256 id, uint32 s) = _start();
        _bothStake(id, STAKE);
        _ko(id, s);
        vm.expectRevert(StakeVault.NotSettled.selector);
        vault.claim(id);

        arena.settle(id);
        vault.claim(id); // now fine
    }

    // ------------------------------------------------------------ 9. reentrancy

    function test_claim_reentrancy_paidExactlyOnce() public {
        ReentrantPlayer evil = new ReentrantPlayer(vault);
        // Contracts cannot freePull, but they can own a card: move Alice's strong card over.
        vm.prank(alice);
        cards.transferFrom(alice, address(evil), cardA);

        uint256 id = evil.create(cardA);
        uint32 s = _join(id);
        vm.deal(address(evil), 1 ether);
        evil.stake{value: STAKE}(id);
        _stake(bob, id, STAKE);

        for (uint32 b = s + 1; b < s + 60; ++b) {
            vm.roll(b);
            evil.attack(id, 30);
            if (_duel(id).status != BlitzArena.Status.Active) break;
        }
        arena.settle(id);
        assertEq(uint8(_duel(id).status), uint8(BlitzArena.Status.P1Won));

        uint256 evilBefore = address(evil).balance;
        vault.claim(id);

        assertTrue(evil.blocked());
        assertFalse(evil.reentered());
        assertEq(address(evil).balance - evilBefore, 2 * STAKE - _rake(STAKE));
        assertEq(address(vault).balance, vault.rakeBalance());
        assertEq(vault.rakeBalance(), _rake(STAKE));
    }

    // ------------------------------------------------------------ 10. fuzz

    function testFuzz_winnerPayoutAndRake(uint256 amount) public {
        amount = bound(amount, vault.MIN_STAKE(), vault.MAX_STAKE());
        (uint256 id, uint32 s) = _start();
        _bothStake(id, amount);
        _koAndSettle(id, s);

        uint256 aliceBefore = alice.balance;
        vault.claim(id);

        uint256 payout = alice.balance - aliceBefore;
        uint256 rake = vault.rakeBalance();
        assertEq(payout, 2 * amount - (2 * amount * 500) / 10_000);
        assertEq(payout + rake, 2 * amount);
        assertEq(address(vault).balance, rake);
    }

    // ------------------------------------------------------------ 11. R1 open refund

    function test_claim_openDuel_refundsP1AfterWindow() public {
        uint256 id = _open();
        _stake(alice, id, STAKE);
        uint256 opened = block.number;

        vm.expectRevert(StakeVault.NotSettled.selector);
        vault.claim(id);

        vm.roll(opened + vault.OPEN_REFUND_BLOCKS() - 1);
        vm.expectRevert(StakeVault.NotSettled.selector);
        vault.claim(id);

        vm.roll(opened + vault.OPEN_REFUND_BLOCKS());
        uint256 aliceBefore = alice.balance;
        vm.expectEmit(true, true, false, true, address(vault));
        emit StakeVault.Claimed(id, alice, STAKE, 0);
        vm.prank(carol);
        vault.claim(id);
        assertEq(alice.balance - aliceBefore, STAKE);
        assertEq(address(vault).balance, 0);

        // The duel is closed for staking even once Bob joins; it runs unstaked.
        _join(id);
        vm.prank(bob);
        vm.expectRevert(StakeVault.StakingClosed.selector);
        vault.stake{value: STAKE}(id);
        vm.prank(alice);
        vm.expectRevert(StakeVault.StakingClosed.selector);
        vault.stake{value: STAKE}(id);

        // And a second claim stays a silent no-op.
        vault.claim(id);
        assertEq(alice.balance - aliceBefore, STAKE);
    }

    function test_claim_openDuelRefunded_thenJoinedAndSettled_noDoublePay() public {
        uint256 id = _open();
        _stake(alice, id, STAKE);
        vm.roll(block.number + vault.OPEN_REFUND_BLOCKS());
        vault.claim(id);
        uint32 s = _join(id);
        _koAndSettle(id, s);
        uint256 vaultBefore = address(vault).balance;
        vault.claim(id);
        assertEq(address(vault).balance, vaultBefore);
    }

    // ------------------------------------------------------------ 12. withdrawRake

    function test_withdrawRake_onlyOwner() public {
        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, carol));
        vault.withdrawRake(payable(carol));
    }

    function test_withdrawRake_zeroAddress_reverts() public {
        vm.expectRevert(StakeVault.ZeroAddress.selector);
        vault.withdrawRake(payable(address(0)));
    }

    function test_withdrawRake_sendsExactRakeAndLeavesStakes() public {
        (uint256 id, uint32 s) = _start();
        _bothStake(id, STAKE);
        _koAndSettle(id, s);
        vault.claim(id);
        uint256 rake = _rake(STAKE);
        assertEq(vault.rakeBalance(), rake);

        // An unrelated pending duel keeps its stake in the vault.
        vm.prank(carol, carol);
        uint256 cardC = cards.freePull();
        vm.prank(carol);
        uint256 id2 = arena.createDuel(cardC);
        _stake(carol, id2, 0.5 ether);
        assertEq(address(vault).balance, rake + 0.5 ether);

        address treasury = makeAddr("treasury");
        vm.expectEmit(true, false, false, true, address(vault));
        emit StakeVault.RakeWithdrawn(treasury, rake);
        vault.withdrawRake(payable(treasury));

        assertEq(treasury.balance, rake);
        assertEq(vault.rakeBalance(), 0);
        assertEq(address(vault).balance, 0.5 ether);

        // Second withdraw sends nothing.
        vault.withdrawRake(payable(treasury));
        assertEq(treasury.balance, rake);
        assertEq(address(vault).balance, 0.5 ether);
    }

    function test_constants() public view {
        assertEq(vault.RAKE_BPS(), 500);
        assertEq(vault.BPS(), 10_000);
        assertEq(vault.MIN_STAKE(), 0.001 ether);
        assertEq(vault.MAX_STAKE(), 1 ether);
        assertEq(vault.OPEN_REFUND_BLOCKS(), 1200);
        assertEq(vault.owner(), address(this));
        assertEq(address(vault.arena()), address(arena));
    }
}
