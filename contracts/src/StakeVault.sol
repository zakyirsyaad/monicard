// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";

import {BlitzArena} from "./BlitzArena.sol";

/// @title StakeVault
/// @notice Lets the two players of a BlitzArena duel stake MON on it. The winner takes the
///         pot minus a 5% rake; draws and unmatched stakes are refunded in full.
/// @dev Reads duel results from BlitzArena and never writes to it. `claim` is idempotent
///      (a silent no-op once paid) because a revert on Monad still burns the whole gas limit.
contract StakeVault is Ownable, ReentrancyGuard {
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
    /// @notice Blocks after the first stake on a still-Open duel before p1 can reclaim it.
    uint256 public constant OPEN_REFUND_BLOCKS = 1200;

    error UnknownDuel();
    error NotParticipant();
    error StakingClosed();
    error AlreadyStaked();
    error BadAmount();
    error AmountMismatch();
    error NotSettled();
    error ZeroAddress();

    event Staked(uint256 indexed duelId, address indexed player, uint256 amount);
    event Claimed(uint256 indexed duelId, address indexed to, uint256 amount, uint256 rake);
    event RakeWithdrawn(address indexed to, uint256 amount);

    BlitzArena public immutable arena;

    /// @notice Accrued, unwithdrawn rake.
    uint256 public rakeBalance;

    mapping(uint256 => Stake) public stakes;

    constructor(address arena_) Ownable(msg.sender) {
        arena = BlitzArena(arena_);
    }

    // ------------------------------------------------------------------- stake

    /// @notice Stake on a duel as one of its players, before the countdown ends.
    /// @dev The first staker fixes the amount; the second must match it exactly.
    function stake(uint256 duelId) external payable nonReentrant {
        BlitzArena.Duel memory d = _duel(duelId);
        if (msg.sender != d.p1 && msg.sender != d.p2) revert NotParticipant();

        Stake storage s = stakes[duelId];
        bool open = d.status == BlitzArena.Status.Open;
        bool counting = d.status == BlitzArena.Status.Active && block.number < d.startBlock;
        if (s.claimed || !(open || counting)) revert StakingClosed();

        bool isP1 = msg.sender == d.p1;
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

        emit Staked(duelId, msg.sender, msg.value);
    }

    // ------------------------------------------------------------------- claim

    /// @notice Pay out a duel. Anyone may call; money only ever goes to the duel's players.
    /// @dev Silent no-op when already claimed or nobody staked. Reverts `NotSettled` while the
    ///      outcome is not final (and, for an Open duel, before the refund window elapses).
    function claim(uint256 duelId) external nonReentrant {
        BlitzArena.Duel memory d = _duel(duelId);
        Stake storage s = stakes[duelId];
        if (s.claimed || (!s.p1Staked && !s.p2Staked)) return;

        uint256 amount = s.amount;

        if (d.settled) {
            s.claimed = true;
            bool decisive = d.status == BlitzArena.Status.P1Won || d.status == BlitzArena.Status.P2Won;
            if (s.p1Staked && s.p2Staked && decisive) {
                uint256 pot = 2 * amount;
                uint256 rake = (pot * RAKE_BPS) / BPS;
                rakeBalance += rake;
                address winner = d.status == BlitzArena.Status.P1Won ? d.p1 : d.p2;
                _pay(duelId, winner, pot - rake, rake);
            } else {
                // Draw, or only one side staked: everyone staked gets their stake back.
                if (s.p1Staked) _pay(duelId, d.p1, amount, 0);
                if (s.p2Staked) _pay(duelId, d.p2, amount, 0);
            }
        } else if (d.status == BlitzArena.Status.Open && block.number >= uint256(s.openedBlock) + OPEN_REFUND_BLOCKS) {
            // Nobody joined: only p1 can have staked. Close the duel for staking and refund.
            s.claimed = true;
            _pay(duelId, d.p1, amount, 0);
        } else {
            revert NotSettled();
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

    function _duel(uint256 duelId) private view returns (BlitzArena.Duel memory) {
        BlitzArena.Duel[] memory page = arena.getDuels(duelId, 1);
        if (page.length == 0) revert UnknownDuel();
        return page[0];
    }

    function _pay(uint256 duelId, address to, uint256 amount, uint256 rake) private {
        emit Claimed(duelId, to, amount, rake);
        Address.sendValue(payable(to), amount);
    }
}
