// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";

import {CardBattle} from "./CardBattle.sol";

/// @title BattleStakeVault
/// @notice Lets the two players of a CardBattle match stake MON on it. The winner takes the
///         pot minus a 5% rake; a stake nobody matched is refunded in full.
/// @dev Reads match results from CardBattle and never writes to it. `claim` is idempotent
///      (a silent no-op once paid or while unsettled) because a revert on Monad still burns
///      the whole gas limit. Staking closes with the first move of the match.
contract BattleStakeVault is Ownable, ReentrancyGuard {
    /// @dev One storage slot.
    struct Stake {
        uint128 amount;
        uint32 openedBlock;
        bool p1Staked;
        bool p2Staked;
        bool claimed;
    }

    uint256 public constant RAKE_BPS = 500;
    uint256 public constant BPS = 10_000;
    uint256 public constant MIN_STAKE = 0.001 ether;
    uint256 public constant MAX_STAKE = 1 ether;
    /// @notice Blocks after the first stake on a still-Open match before p1 can reclaim it.
    uint256 public constant OPEN_REFUND_BLOCKS = 1200;

    error NotParticipant();
    error StakingClosed();
    error AlreadyStaked();
    error BadAmount();
    error AmountMismatch();
    error ZeroAddress();

    event Staked(uint256 indexed matchId, address indexed player, uint256 amount);
    event Claimed(uint256 indexed matchId, address indexed to, uint256 amount, uint256 rake);
    event RakeWithdrawn(address indexed to, uint256 amount);

    CardBattle public immutable battle;

    /// @notice Accrued, unwithdrawn rake.
    uint256 public rakeBalance;

    mapping(uint256 => Stake) public stakes;

    constructor(address battle_) Ownable(msg.sender) {
        battle = CardBattle(battle_);
    }

    // ------------------------------------------------------------------- stake

    /// @notice Stake on a match as one of its players, before anybody has moved.
    /// @dev The first staker fixes the amount; the second must match it exactly. Reverts with
    ///      `CardBattle.MatchNotFound` for an unknown id.
    function stake(uint256 matchId) external payable nonReentrant {
        CardBattle.MatchView memory m = battle.getMatch(matchId);
        if (msg.sender != m.p1 && msg.sender != m.p2) revert NotParticipant();

        Stake storage s = stakes[matchId];
        if (s.claimed || !_stakingOpen(m)) revert StakingClosed();

        bool isP1 = msg.sender == m.p1;
        if (isP1 ? s.p1Staked : s.p2Staked) revert AlreadyStaked();
        if (msg.value < MIN_STAKE || msg.value > MAX_STAKE) revert BadAmount();

        if (s.p1Staked || s.p2Staked) {
            if (msg.value != s.amount) revert AmountMismatch();
        } else {
            // msg.value <= MAX_STAKE (1 ether) fits uint128; block numbers fit uint32 for this game.
            // forge-lint: disable-next-line(unsafe-typecast)
            s.amount = uint128(msg.value);
            // forge-lint: disable-next-line(unsafe-typecast)
            s.openedBlock = uint32(block.number);
        }
        if (isP1) s.p1Staked = true;
        else s.p2Staked = true;

        emit Staked(matchId, msg.sender, msg.value);
    }

    // ------------------------------------------------------------------- claim

    /// @notice Pay out a match. Anyone may call; money only ever goes to the match's players.
    /// @dev Silent no-op when already claimed, nobody staked, or the match is not over yet.
    ///      A still-Open match whose first stake is older than OPEN_REFUND_BLOCKS refunds p1.
    function claim(uint256 matchId) external nonReentrant {
        CardBattle.MatchView memory m = battle.getMatch(matchId);
        Stake storage s = stakes[matchId];
        if (s.claimed || (!s.p1Staked && !s.p2Staked)) return;

        uint256 amount = s.amount;
        bool decisive = m.status == CardBattle.Status.P1Won || m.status == CardBattle.Status.P2Won;

        if (decisive) {
            s.claimed = true;
            if (s.p1Staked && s.p2Staked) {
                uint256 pot = 2 * amount;
                uint256 rake = (pot * RAKE_BPS) / BPS;
                rakeBalance += rake;
                address winner = m.status == CardBattle.Status.P1Won ? m.p1 : m.p2;
                _pay(matchId, winner, pot - rake, rake);
            } else {
                // Only one side staked: that stake comes back whole, no rake.
                _pay(matchId, s.p1Staked ? m.p1 : m.p2, amount, 0);
            }
        } else if (m.status == CardBattle.Status.Open && block.number >= uint256(s.openedBlock) + OPEN_REFUND_BLOCKS) {
            // Nobody joined: only p1 can have staked. Close the match for staking and refund.
            s.claimed = true;
            _pay(matchId, m.p1, amount, 0);
        }
    }

    // --------------------------------------------------------------- withdraw

    /// @notice Send the accrued rake to `to`. Never touches staked funds.
    function withdrawRake(address payable to) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        uint256 amount = rakeBalance;
        rakeBalance = 0;
        Address.sendValue(to, amount);
        emit RakeWithdrawn(to, amount);
    }

    // ----------------------------------------------------------------- private

    /// @dev Open, or Active with no move made yet. Every move that does not end the match hands the
    ///      opponent one more card, so both sides still at their single starting draw means nobody
    ///      has acted.
    function _stakingOpen(CardBattle.MatchView memory m) private pure returns (bool) {
        if (m.status == CardBattle.Status.Open) return true;
        return m.status == CardBattle.Status.Active && m.drawn1 <= 1 && m.drawn2 <= 1;
    }

    function _pay(uint256 matchId, address to, uint256 amount, uint256 rake) private {
        emit Claimed(matchId, to, amount, rake);
        Address.sendValue(payable(to), amount);
    }
}
