// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {CardBattle} from "../src/CardBattle.sol";
import {BattleStakeVault} from "../src/BattleStakeVault.sol";

/// @dev A contract player: creates or joins a match, stakes, claims the timeout win, and tries
///      to re-enter `claim` when paid.
contract BattleReentrantPlayer {
    BattleStakeVault public immutable vault;
    CardBattle public immutable battle;
    uint256 public targetId;
    bool public reentered;
    bool public blocked;

    constructor(BattleStakeVault vault_) {
        vault = vault_;
        battle = vault_.battle();
    }

    function create() external returns (uint256) {
        return battle.createMatch();
    }

    function join(uint256 id) external {
        battle.joinMatch(id);
    }

    function stake(uint256 id) external payable {
        targetId = id;
        vault.stake{value: msg.value}(id);
    }

    function timeout(uint256 id) external {
        battle.claimTimeout(id);
    }

    receive() external payable {
        try vault.claim(targetId) {
            reentered = true;
        } catch {
            blocked = true;
        }
    }
}

contract BattleStakeVaultTest is Test {
    uint256 private constant STAKE = 0.1 ether;

    CardBattle private battle;
    BattleStakeVault private vault;

    address private alice;
    address private bob;
    address private carol;

    event Staked(uint256 indexed matchId, address indexed player, uint256 amount);
    event Claimed(uint256 indexed matchId, address indexed to, uint256 amount, uint256 rake);

    function setUp() public {
        battle = new CardBattle();
        vault = new BattleStakeVault(address(battle));
        alice = makeAddr("alice");
        bob = makeAddr("bob");
        carol = makeAddr("carol");
        vm.deal(alice, 10 ether);
        vm.deal(bob, 10 ether);
        vm.deal(carol, 10 ether);
        vm.prevrandao(bytes32(uint256(0x1234)));
    }

    // ---------------------------------------------------------------- helpers

    /// @dev alice (p1) creates, bob (p2) joins. Nobody has moved.
    function _open() private returns (uint256 id) {
        vm.prank(alice);
        id = battle.createMatch();
        vm.prank(bob);
        battle.joinMatch(id);
    }

    function _stakeAs(address who, uint256 id, uint256 amount) private {
        vm.prank(who);
        vault.stake{value: amount}(id);
    }

    /// @dev Both stake, then the player NOT to move wins by timeout. Returns (id, winner, loser).
    function _stakedMatchEnded(uint256 amount) private returns (uint256 id, address winner, address loser) {
        id = _open();
        _stakeAs(alice, id, amount);
        _stakeAs(bob, id, amount);
        (winner, loser) = _timeoutWin(id);
    }

    function _timeoutWin(uint256 id) private returns (address winner, address loser) {
        CardBattle.MatchView memory v = battle.getMatch(id);
        winner = v.turn == 1 ? v.p2 : v.p1;
        loser = v.turn == 1 ? v.p1 : v.p2;
        vm.roll(block.number + battle.TURN_TIMEOUT_BLOCKS());
        vm.prank(winner);
        battle.claimTimeout(id);
    }

    function _firstAct(uint256 id) private {
        CardBattle.MatchView memory v = battle.getMatch(id);
        vm.prank(v.turn == 1 ? v.p1 : v.p2);
        battle.act(id, 255, false);
    }

    // ------------------------------------------------------------------ stake

    function test_constructorWiresBattleAndOwner() public view {
        assertEq(address(vault.battle()), address(battle));
        assertEq(vault.owner(), address(this));
    }

    function test_stakeRecordsAmountAndPlayers() public {
        uint256 id = _open();
        vm.expectEmit(true, true, false, true, address(vault));
        emit Staked(id, alice, STAKE);
        _stakeAs(alice, id, STAKE);
        (uint128 amount,, bool p1, bool p2, bool claimed) = vault.stakes(id);
        assertEq(amount, STAKE);
        assertTrue(p1);
        assertFalse(p2);
        assertFalse(claimed);

        _stakeAs(bob, id, STAKE);
        (,, p1, p2,) = vault.stakes(id);
        assertTrue(p1 && p2);
        assertEq(address(vault).balance, 2 * STAKE);
    }

    function test_p1CanStakeWhileMatchIsStillOpen() public {
        vm.prank(alice);
        uint256 id = battle.createMatch();
        _stakeAs(alice, id, STAKE);
        (,, bool p1,,) = vault.stakes(id);
        assertTrue(p1);
    }

    function test_p2CanStakeFirst() public {
        uint256 id = _open();
        _stakeAs(bob, id, STAKE);
        _stakeAs(alice, id, STAKE);
        (uint128 amount,, bool p1, bool p2,) = vault.stakes(id);
        assertEq(amount, STAKE);
        assertTrue(p1 && p2);
    }

    function test_stakeRejectsNonParticipants() public {
        uint256 id = _open();
        vm.prank(carol);
        vm.expectRevert(BattleStakeVault.NotParticipant.selector);
        vault.stake{value: STAKE}(id);
    }

    function test_stakeOnUnknownMatchReverts() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(CardBattle.MatchNotFound.selector, 99));
        vault.stake{value: STAKE}(99);
    }

    function test_secondStakeMustMatchTheFirst() public {
        uint256 id = _open();
        _stakeAs(alice, id, STAKE);
        vm.prank(bob);
        vm.expectRevert(BattleStakeVault.AmountMismatch.selector);
        vault.stake{value: STAKE + 1}(id);
        vm.prank(bob);
        vm.expectRevert(BattleStakeVault.AmountMismatch.selector);
        vault.stake{value: STAKE - 1}(id);
    }

    function test_eachPlayerStakesOnce() public {
        uint256 id = _open();
        _stakeAs(alice, id, STAKE);
        vm.prank(alice);
        vm.expectRevert(BattleStakeVault.AlreadyStaked.selector);
        vault.stake{value: STAKE}(id);
    }

    function test_stakeBoundsAreEnforced() public {
        uint256 minStake = vault.MIN_STAKE();
        uint256 maxStake = vault.MAX_STAKE();
        uint256 id = _open();
        vm.prank(alice);
        vm.expectRevert(BattleStakeVault.BadAmount.selector);
        vault.stake{value: 0}(id);
        vm.prank(alice);
        vm.expectRevert(BattleStakeVault.BadAmount.selector);
        vault.stake{value: minStake - 1}(id);
        vm.prank(alice);
        vm.expectRevert(BattleStakeVault.BadAmount.selector);
        vault.stake{value: maxStake + 1}(id);

        _stakeAs(alice, id, minStake);
        _stakeAs(bob, id, minStake);
        uint256 id2 = _open();
        _stakeAs(alice, id2, maxStake);
        _stakeAs(bob, id2, maxStake);
    }

    function test_stakingClosesAfterTheFirstMove() public {
        uint256 id = _open();
        _stakeAs(alice, id, STAKE);
        _firstAct(id);
        vm.prank(bob);
        vm.expectRevert(BattleStakeVault.StakingClosed.selector);
        vault.stake{value: STAKE}(id);
    }

    function test_stakingClosesOnceTheMatchIsOver() public {
        uint256 id = _open();
        _timeoutWin(id);
        vm.prank(alice);
        vm.expectRevert(BattleStakeVault.StakingClosed.selector);
        vault.stake{value: STAKE}(id);
        vm.prank(bob);
        vm.expectRevert(BattleStakeVault.StakingClosed.selector);
        vault.stake{value: STAKE}(id);
    }

    // ------------------------------------------------------------------ claim

    function test_winnerTakesPotMinusRake() public {
        (uint256 id, address winner, address loser) = _stakedMatchEnded(STAKE);
        uint256 winnerBefore = winner.balance;
        uint256 loserBefore = loser.balance;
        uint256 rake = (2 * STAKE * 500) / 10_000;

        vm.expectEmit(true, true, false, true, address(vault));
        emit Claimed(id, winner, 2 * STAKE - rake, rake);
        vm.prank(carol); // anyone can trigger the payout
        vault.claim(id);

        assertEq(winner.balance, winnerBefore + 2 * STAKE - rake);
        assertEq(loser.balance, loserBefore);
        assertEq(vault.rakeBalance(), rake);
        assertEq(address(vault).balance, rake);
    }

    function test_bothSidesCanBeTheWinner() public {
        // Different prevrandao values flip the coin, so both p1 and p2 get to win across the loop.
        bool sawP1;
        bool sawP2;
        for (uint256 i = 1; i <= 24 && !(sawP1 && sawP2); ++i) {
            vm.prevrandao(bytes32(i));
            (uint256 id, address winner,) = _stakedMatchEnded(STAKE);
            vault.claim(id);
            if (winner == alice) sawP1 = true;
            else sawP2 = true;
        }
        assertTrue(sawP1 && sawP2, "both sides won at least once");
        assertEq(address(vault).balance, vault.rakeBalance(), "only rake is left in the vault");
    }

    function test_claimIsIdempotent() public {
        (uint256 id, address winner,) = _stakedMatchEnded(STAKE);
        vault.claim(id);
        uint256 balance = winner.balance;
        uint256 vaultBalance = address(vault).balance;
        vault.claim(id);
        vault.claim(id);
        assertEq(winner.balance, balance);
        assertEq(address(vault).balance, vaultBalance);
        (,,,, bool claimed) = vault.stakes(id);
        assertTrue(claimed);
    }

    function test_onlyOneStakerGetsRefundedWithoutRake() public {
        uint256 id = _open();
        _stakeAs(alice, id, STAKE);
        _timeoutWin(id);
        uint256 before = alice.balance;
        vault.claim(id);
        assertEq(alice.balance, before + STAKE);
        assertEq(vault.rakeBalance(), 0);
        assertEq(address(vault).balance, 0);
    }

    function test_onlyP2StakedIsRefundedToP2() public {
        uint256 id = _open();
        _stakeAs(bob, id, STAKE);
        _timeoutWin(id);
        uint256 before = bob.balance;
        vault.claim(id);
        assertEq(bob.balance, before + STAKE);
        assertEq(address(vault).balance, 0);
    }

    function test_claimBeforeTheMatchEndsDoesNothing() public {
        uint256 id = _open();
        _stakeAs(alice, id, STAKE);
        _stakeAs(bob, id, STAKE);
        vault.claim(id);
        _firstAct(id);
        vault.claim(id);
        assertEq(address(vault).balance, 2 * STAKE);
        (,,,, bool claimed) = vault.stakes(id);
        assertFalse(claimed);
    }

    function test_claimWithoutStakesIsANoOp() public {
        uint256 id = _open();
        _timeoutWin(id);
        vault.claim(id);
        assertEq(address(vault).balance, 0);
    }

    function test_claimOnUnknownMatchReverts() public {
        vm.expectRevert(abi.encodeWithSelector(CardBattle.MatchNotFound.selector, 7));
        vault.claim(7);
    }

    function test_abandonedOpenMatchRefundsP1AfterTheWindow() public {
        vm.prank(alice);
        uint256 id = battle.createMatch();
        _stakeAs(alice, id, STAKE);

        vault.claim(id);
        assertEq(address(vault).balance, STAKE, "too early");

        vm.roll(block.number + vault.OPEN_REFUND_BLOCKS());
        uint256 before = alice.balance;
        vault.claim(id);
        assertEq(alice.balance, before + STAKE);
        assertEq(address(vault).balance, 0);

        vm.prank(bob);
        battle.joinMatch(id);
        vm.prank(bob);
        vm.expectRevert(BattleStakeVault.StakingClosed.selector);
        vault.stake{value: STAKE}(id);
    }

    function test_reentrantWinnerCannotDrainTheVault() public {
        BattleReentrantPlayer attacker = new BattleReentrantPlayer(vault);
        vm.deal(address(attacker), 1 ether);

        // Find a match where the attacker (p1) is NOT to move, so it wins the timeout.
        uint256 id;
        for (uint256 i = 1; i <= 24; ++i) {
            vm.prevrandao(bytes32(i));
            id = attacker.create();
            vm.prank(bob);
            battle.joinMatch(id);
            if (battle.getMatch(id).turn == 2) break;
        }
        require(battle.getMatch(id).turn == 2, "no suitable coin flip");

        attacker.stake{value: STAKE}(id);
        _stakeAs(bob, id, STAKE);
        // An unrelated pot sits in the vault too, which re-entrancy must not touch.
        uint256 other = _open();
        _stakeAs(alice, other, STAKE);

        vm.roll(block.number + battle.TURN_TIMEOUT_BLOCKS());
        attacker.timeout(id);

        uint256 rake = (2 * STAKE * 500) / 10_000;
        vault.claim(id);
        assertTrue(attacker.blocked(), "re-entry was rejected");
        assertFalse(attacker.reentered());
        assertEq(address(attacker).balance, 1 ether + 2 * STAKE - rake);
        assertEq(address(vault).balance, rake + STAKE);
    }

    // ------------------------------------------------------------------- rake

    function test_ownerWithdrawsOnlyRake() public {
        (uint256 id,,) = _stakedMatchEnded(STAKE);
        vault.claim(id);
        uint256 other = _open();
        _stakeAs(alice, other, STAKE); // a live stake the owner must not reach

        uint256 rake = vault.rakeBalance();
        address payable treasury = payable(makeAddr("treasury"));
        vault.withdrawRake(treasury);
        assertEq(treasury.balance, rake);
        assertEq(vault.rakeBalance(), 0);
        assertEq(address(vault).balance, STAKE);
    }

    function test_withdrawRakeIsOwnerOnlyAndRejectsZeroAddress() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        vault.withdrawRake(payable(alice));
        vm.expectRevert(BattleStakeVault.ZeroAddress.selector);
        vault.withdrawRake(payable(address(0)));
    }

    // ------------------------------------------------------------------- fuzz

    function testFuzz_potIsConserved(uint256 raw) public {
        uint256 amount = bound(raw, vault.MIN_STAKE(), vault.MAX_STAKE());
        uint256 aliceBefore = alice.balance;
        uint256 bobBefore = bob.balance;
        (uint256 id, address winner,) = _stakedMatchEnded(amount);
        vault.claim(id);

        uint256 rake = (2 * amount * 500) / 10_000;
        assertEq(vault.rakeBalance(), rake);
        assertEq(address(vault).balance, rake);
        assertEq(alice.balance + bob.balance + rake, aliceBefore + bobBefore);
        assertEq(winner.balance, (winner == alice ? aliceBefore : bobBefore) + amount - rake);
    }

    function testFuzz_mismatchedAmountsAlwaysRevert(uint256 a, uint256 b) public {
        a = bound(a, vault.MIN_STAKE(), vault.MAX_STAKE());
        b = bound(b, vault.MIN_STAKE(), vault.MAX_STAKE());
        vm.assume(a != b);
        uint256 id = _open();
        _stakeAs(alice, id, a);
        vm.prank(bob);
        vm.expectRevert(BattleStakeVault.AmountMismatch.selector);
        vault.stake{value: b}(id);
    }
}
