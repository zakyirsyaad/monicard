// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {INadCards} from "./interfaces/INadCards.sol";

/// @title CardBattle
/// @notice Turn-based best-of-3 card duel on top of NadCards. Each round draws
///         one random card per deck, cards trade one action per turn, and the
///         first side to win two rounds wins the match. No value is accepted.
contract CardBattle {
    enum Status {
        Open,
        Active,
        P1Won,
        P2Won
    }

    struct MatchView {
        address p1;
        address p2;
        Status status;
        uint8 round;
        uint8 score1;
        uint8 score2;
        uint8 turn;
        uint32 lastMoveBlock;
        uint32[3] deck1;
        uint32[3] deck2;
        uint32 card1;
        uint32 card2;
        uint16 hp1;
        uint16 maxHp1;
        uint16 atk1;
        uint8 el1;
        uint16 hp2;
        uint16 maxHp2;
        uint16 atk2;
        uint8 el2;
        bool special1;
        bool special2;
    }

    /// @dev Deck stats are snapshotted at create/join so `act` never calls out.
    struct CardState {
        uint32 tokenId;
        uint16 hp;
        uint16 maxHp;
        uint16 atk;
        uint8 element;
    }

    struct Match {
        address p1;
        address p2;
        Status status;
        uint8 round;
        uint8 score1;
        uint8 score2;
        uint8 turn;
        uint32 lastMoveBlock;
        uint8 deckCount1;
        uint8 deckCount2;
        bool special1;
        bool special2;
        CardState c1;
        CardState c2;
        CardState[3] pool1;
        CardState[3] pool2;
    }

    error EmptyDeck();
    error NotCardOwner(uint32 tokenId);
    error DuplicateCard(uint32 tokenId);
    error MatchNotFound(uint256 id);
    error MatchNotOpen();
    error MatchNotActive();
    error CannotJoinOwnMatch();
    error NotPlayer();
    error NotYourTurn();
    error SpecialAlreadyUsed();
    error TimeoutNotReached();
    error RoundLimitReached();
    error DrawFailed();

    event MatchCreated(uint256 indexed id, address indexed p1);
    event MatchJoined(uint256 indexed id, address indexed p2);
    event Acted(uint256 indexed id, address indexed player, bool special, uint256 damage, uint16 hpLeft, uint8 round);
    event RoundEnded(uint256 indexed id, uint8 round, uint8 winnerSide, uint8 score1, uint8 score2);
    event MatchEnded(uint256 indexed id, address indexed winner);

    uint256 public constant DAMAGE_SCALE = 30;
    uint256 public constant MAX_ROUNDS = 3;
    uint256 public constant TURN_TIMEOUT_BLOCKS = 100;

    uint8 private constant SALT_DRAW = 1;
    uint8 private constant SALT_FIRST_TURN = 2;
    uint8 private constant SIDE_MATCH = 0;

    INadCards public immutable cards;
    Match[] private _matches;

    constructor(address cards_) {
        cards = INadCards(cards_);
    }

    /// @notice Open a match with a 1-3 card deck; empty slots are 0.
    function createMatch(uint32[3] calldata deck) external returns (uint256 id) {
        (CardState[3] memory pool, uint8 count) = _loadDeck(deck, msg.sender);

        id = _matches.length + 1;
        Match storage m = _matches.push();
        m.p1 = msg.sender;
        m.status = Status.Open;
        for (uint256 i; i < 3; ++i) {
            m.pool1[i] = pool[i];
        }
        m.deckCount1 = count;

        emit MatchCreated(id, msg.sender);
    }

    /// @notice Join an open match; draws round 1 and picks who moves first.
    function joinMatch(uint256 id, uint32[3] calldata deck) external {
        Match storage m = _requireMatch(id);
        if (m.status != Status.Open) revert MatchNotOpen();
        if (msg.sender == m.p1) revert CannotJoinOwnMatch();

        (CardState[3] memory pool, uint8 count) = _loadDeck(deck, msg.sender);
        m.p2 = msg.sender;
        for (uint256 i; i < 3; ++i) {
            m.pool2[i] = pool[i];
        }
        m.deckCount2 = count;
        m.status = Status.Active;
        m.round = 1;

        uint256 r = _rand(id, 1, SIDE_MATCH, SALT_FIRST_TURN);
        uint8 first = r % 2 == 0 ? 1 : 2;
        _startRound(id, m, first);

        emit MatchJoined(id, msg.sender);
    }

    /// @notice Take the current player's one action for this turn.
    function act(uint256 id, bool special) external {
        Match storage m = _requireMatch(id);
        if (m.status != Status.Active) revert MatchNotActive();

        uint8 side = _sideOf(m, msg.sender);
        if (m.turn != side) revert NotYourTurn();

        CardState storage attacker = side == 1 ? m.c1 : m.c2;
        CardState storage defender = side == 1 ? m.c2 : m.c1;

        if (special && (side == 1 ? m.special1 : m.special2)) revert SpecialAlreadyUsed();

        uint256 dmg = damageOf(attacker.atk, attacker.element, defender.element, special);
        uint16 hpLeft = dmg >= defender.hp ? 0 : uint16(uint256(defender.hp) - dmg);
        defender.hp = hpLeft;

        if (special) {
            if (side == 1) {
                m.special1 = true;
            } else {
                m.special2 = true;
            }
        }
        m.lastMoveBlock = uint32(block.number);

        emit Acted(id, msg.sender, special, dmg, hpLeft, m.round);

        if (hpLeft == 0) {
            _finishRound(id, m, side);
        } else {
            m.turn = side == 1 ? 2 : 1;
        }
    }

    /// @notice Claim a match whose current player ran out the turn clock.
    function claimTimeout(uint256 id) external {
        Match storage m = _requireMatch(id);
        if (m.status != Status.Active) revert MatchNotActive();

        uint8 stalledSide = m.turn;
        address stalled = stalledSide == 1 ? m.p1 : m.p2;
        if (msg.sender == stalled) revert NotYourTurn();
        _sideOf(m, msg.sender);
        if (block.number < uint256(m.lastMoveBlock) + TURN_TIMEOUT_BLOCKS) revert TimeoutNotReached();

        if (msg.sender == m.p1) {
            m.status = Status.P1Won;
        } else {
            m.status = Status.P2Won;
        }
        emit MatchEnded(id, msg.sender);
    }

    function getMatch(uint256 id) external view returns (MatchView memory) {
        return _view(_requireMatch(id));
    }

    /// @param from 1-based match id; 0 is treated as 1. Ids past the end yield an empty array.
    function getMatches(uint256 from, uint256 count) external view returns (MatchView[] memory out) {
        uint256 total = _matches.length;
        uint256 start = from == 0 ? 1 : from;
        if (start > total || count == 0) return new MatchView[](0);

        uint256 available = total - start + 1;
        uint256 n = count < available ? count : available;
        out = new MatchView[](n);
        for (uint256 i; i < n; ++i) {
            out[i] = _view(_matches[start - 1 + i]);
        }
    }

    function matchCount() external view returns (uint256) {
        return _matches.length;
    }

    /// @notice 150 when `a` beats `d`, 100 on a mirror, 75 when `a` is weak.
    function elementMult(uint8 a, uint8 d) public pure returns (uint256) {
        if ((uint256(d) + 1) % 3 == a) return 150;
        if (a == d) return 100;
        return 75;
    }

    function damageOf(uint16 atk, uint8 a, uint8 d, bool special) public pure returns (uint256) {
        uint256 dmg = (uint256(atk) * DAMAGE_SCALE * elementMult(a, d)) / 100;
        return special ? dmg * 2 : dmg;
    }

    // ---------------------------------------------------------------- internal

    function _requireMatch(uint256 id) private view returns (Match storage m) {
        if (id == 0 || id > _matches.length) revert MatchNotFound(id);
        return _matches[id - 1];
    }

    function _sideOf(Match storage m, address player) private view returns (uint8) {
        if (player == m.p1) return 1;
        if (player == m.p2) return 2;
        revert NotPlayer();
    }

    function _loadDeck(uint32[3] calldata deck, address player)
        private
        view
        returns (CardState[3] memory pool, uint8 count)
    {
        for (uint256 i; i < 3; ++i) {
            uint32 tokenId = deck[i];
            if (tokenId == 0) continue;
            ++count;
            if (cards.ownerOf(tokenId) != player) revert NotCardOwner(tokenId);
            for (uint256 j = i + 1; j < 3; ++j) {
                if (deck[j] == tokenId) revert DuplicateCard(tokenId);
            }
            INadCards.Card memory card = cards.cards(tokenId);
            pool[i] = CardState({
                tokenId: tokenId, hp: card.hp, maxHp: card.hp, atk: card.atk, element: card.element
            });
        }
        if (count == 0) revert EmptyDeck();
    }

    function _startRound(uint256 id, Match storage m, uint8 first) private {
        m.c1 = _draw(id, m.round, 1, m.deckCount1, m.pool1);
        m.c2 = _draw(id, m.round, 2, m.deckCount2, m.pool2);
        m.special1 = false;
        m.special2 = false;
        m.turn = first;
        m.lastMoveBlock = uint32(block.number);
    }

    function _draw(uint256 id, uint8 round, uint8 side, uint8 count, CardState[3] storage pool)
        private
        view
        returns (CardState memory picked)
    {
        uint256 pick = _rand(id, round, side, SALT_DRAW) % count;
        uint256 seen;
        for (uint256 i; i < 3; ++i) {
            if (pool[i].tokenId == 0) continue;
            if (seen == pick) {
                picked = pool[i];
                picked.hp = pool[i].maxHp;
                return picked;
            }
            ++seen;
        }
        revert DrawFailed();
    }

    function _finishRound(uint256 id, Match storage m, uint8 winnerSide) private {
        uint8 round = m.round;
        if (winnerSide == 1) {
            m.score1 += 1;
        } else {
            m.score2 += 1;
        }
        emit RoundEnded(id, round, winnerSide, m.score1, m.score2);

        address winner = winnerSide == 1 ? m.p1 : m.p2;
        if (m.score1 == 2 || m.score2 == 2) {
            m.status = winnerSide == 1 ? Status.P1Won : Status.P2Won;
            emit MatchEnded(id, winner);
            return;
        }
        if (round >= MAX_ROUNDS) revert RoundLimitReached();

        m.round = round + 1;
        // The side that lost the previous round moves first.
        _startRound(id, m, winnerSide == 1 ? 2 : 1);
    }

    function _rand(uint256 id, uint8 round, uint8 side, uint8 salt) private view returns (uint256) {
        return uint256(keccak256(abi.encode(block.prevrandao, id, uint256(round), uint256(side), uint256(salt))));
    }

    function _view(Match storage m) private view returns (MatchView memory v) {
        v.p1 = m.p1;
        v.p2 = m.p2;
        v.status = m.status;
        v.round = m.round;
        v.score1 = m.score1;
        v.score2 = m.score2;
        v.turn = m.turn;
        v.lastMoveBlock = m.lastMoveBlock;
        v.deck1 = [m.pool1[0].tokenId, m.pool1[1].tokenId, m.pool1[2].tokenId];
        v.deck2 = [m.pool2[0].tokenId, m.pool2[1].tokenId, m.pool2[2].tokenId];
        v.card1 = m.c1.tokenId;
        v.card2 = m.c2.tokenId;
        v.hp1 = m.c1.hp;
        v.maxHp1 = m.c1.maxHp;
        v.atk1 = m.c1.atk;
        v.el1 = m.c1.element;
        v.hp2 = m.c2.hp;
        v.maxHp2 = m.c2.maxHp;
        v.atk2 = m.c2.atk;
        v.el2 = m.c2.element;
        v.special1 = m.special1;
        v.special2 = m.special2;
    }
}