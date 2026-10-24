// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title CardBattle
/// @notice Turn-based card duel. Every player draws a fresh random card on each
///         turn, up to ten per match. Cards are generated onchain from
///         `block.prevrandao` and are not tied to any NFT: no ownership check,
///         no deck selection, no calls to other contracts.
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
        uint8 turn; // 1 = p1 to move, 2 = p2 to move, 0 = nobody
        uint8 score1;
        uint8 score2;
        uint32 lastMoveBlock;
        bool special1; // special already spent
        bool special2;
        uint8 drawn1;
        uint8 drawn2;
        uint16 placed1; // bitmask of draw numbers placed on the board
        uint16 placed2;
        uint8[10] el1;
        uint8[10] el2;
        uint8[10] rar1;
        uint8[10] rar2;
        uint16[10] atk1;
        uint16[10] atk2;
        uint16[10] maxHp1;
        uint16[10] maxHp2;
        uint16[10] hp1;
        uint16[10] hp2;
        uint8[3] board1; // draw number per slot, 255 = empty
        uint8[3] board2;
    }

    /// @dev Packed into one storage slot per card.
    struct Card {
        uint8 el;
        uint8 rar;
        uint16 atk;
        uint16 maxHp;
        uint16 hp;
    }

    struct Side {
        uint8 drawn;
        uint8 placedCount;
        uint16 placed;
        bool specialUsed;
        Card[10] cards;
        uint8[3] board;
    }

    struct Match {
        address p1;
        address p2;
        Status status;
        uint8 turn;
        uint8 score1;
        uint8 score2;
        uint32 lastMoveBlock;
        Side s1;
        Side s2;
    }

    uint8 public constant MAX_DRAWS = 10;
    uint8 public constant BOARD_SLOTS = 3;
    uint8 public constant WIN_SCORE = 2;
    uint256 public constant DAMAGE_SCALE = 35;
    uint256 public constant TURN_TIMEOUT_BLOCKS = 100;

    uint8 private constant SIDE_P1 = 1;
    uint8 private constant SIDE_P2 = 2;
    uint8 private constant NO_CARD = 255;
    bytes32 private constant FIRST_TURN_DOMAIN = keccak256("CardBattle.firstTurn");

    error MatchNotFound(uint256 id);
    error MatchNotOpen();
    error MatchNotActive();
    error CannotJoinOwnMatch();
    error NotPlayer();
    error NotYourTurn();
    error InvalidHandIndex(uint8 handIdx);
    error CardNotInHand(uint8 handIdx);
    error NoEmptySlot();
    error SpecialAlreadyUsed();
    error TimeoutNotReached();

    event MatchCreated(uint256 indexed id, address indexed p1);
    event MatchJoined(uint256 indexed id, address indexed p2);
    event Acted(
        uint256 indexed id, address indexed player, uint8 drawnNo, uint8 placedNo, bool special, uint256 damage, bool ko
    );
    event MatchEnded(uint256 indexed id, address indexed winner);

    Match[] internal _matches;

    constructor() {}

    /// @notice Open a match and draw the creator's first card.
    function createMatch() external returns (uint256 id) {
        id = _matches.length + 1;
        Match storage m = _matches.push();
        m.p1 = msg.sender;
        m.status = Status.Open;
        m.lastMoveBlock = uint32(block.number);
        _initSide(m.s1);
        _initSide(m.s2);
        _drawCard(id, SIDE_P1, m.s1, 0);

        emit MatchCreated(id, msg.sender);
    }

    /// @notice Join an open match, draw the second player's first card and flip
    ///         the turn coin.
    function joinMatch(uint256 id) external {
        Match storage m = _requireMatch(id);
        if (m.status != Status.Open) revert MatchNotOpen();
        if (msg.sender == m.p1) revert CannotJoinOwnMatch();

        m.p2 = msg.sender;
        m.status = Status.Active;
        m.turn = _firstTurn(id);
        m.lastMoveBlock = uint32(block.number);
        _drawCard(id, SIDE_P2, m.s2, 0);

        emit MatchJoined(id, msg.sender);
    }

    /// @notice Take one turn: draw a card, optionally place one card from the
    ///         hand, then attack with every card on the board.
    /// @param handIdx Draw number (0-9) of the card to place, or 255 to skip.
    /// @param special Spend this player's once-per-match double damage.
    function act(uint256 id, uint8 handIdx, bool special) external {
        Match storage m = _requireMatch(id);
        if (m.status != Status.Active) revert MatchNotActive();

        uint8 side = _sideOf(m, msg.sender);
        if (m.turn != side) revert NotYourTurn();

        Side storage me = side == SIDE_P1 ? m.s1 : m.s2;
        Side storage foe = side == SIDE_P1 ? m.s2 : m.s1;

        if (handIdx != NO_CARD && handIdx >= MAX_DRAWS) revert InvalidHandIndex(handIdx);
        if (special && me.specialUsed) revert SpecialAlreadyUsed();

        uint8 drawnNo = NO_CARD;
        if (me.drawn < MAX_DRAWS) {
            drawnNo = me.drawn;
            _drawCard(id, side, me, drawnNo);
        }

        if (handIdx != NO_CARD) {
            if (handIdx >= me.drawn || (me.placed & (uint16(1) << handIdx)) != 0) {
                revert CardNotInHand(handIdx);
            }
            uint8 slot = _firstEmpty(me.board);
            if (slot == NO_CARD) revert NoEmptySlot();
            me.board[slot] = handIdx;
            me.placed |= uint16(1) << handIdx;
            me.placedCount += 1;
        }

        uint256 damage;
        bool ko;
        bool specialApplied;
        uint8 target = _front(foe.board);

        if (_front(me.board) != NO_CARD && target != NO_CARD) {
            damage = _sumDamage(me, foe.cards[target].el);
            if (special) {
                damage *= 2;
                specialApplied = true;
                me.specialUsed = true;
            }

            uint16 hpLeft = foe.cards[target].hp;
            if (damage >= hpLeft) {
                foe.cards[target].hp = 0;
                _removeCard(foe.board, target);
                ko = true;
                if (side == SIDE_P1) {
                    m.score1 += 1;
                } else {
                    m.score2 += 1;
                }
            } else {
                foe.cards[target].hp = uint16(uint256(hpLeft) - damage);
            }
        }

        m.lastMoveBlock = uint32(block.number);
        emit Acted(id, msg.sender, drawnNo, handIdx, specialApplied, damage, ko);

        if (ko) {
            uint8 score = side == SIDE_P1 ? m.score1 : m.score2;
            if (score >= WIN_SCORE || _isExhausted(foe)) {
                _finish(id, m, side);
                return;
            }
        }

        m.turn = side == SIDE_P1 ? SIDE_P2 : SIDE_P1;
    }

    /// @notice Claim a win when the side to move ran out the turn clock.
    function claimTimeout(uint256 id) external {
        Match storage m = _requireMatch(id);
        if (m.status != Status.Active) revert MatchNotActive();

        uint8 side = _sideOf(m, msg.sender);
        if (side == m.turn) revert NotYourTurn();
        if (block.number < uint256(m.lastMoveBlock) + TURN_TIMEOUT_BLOCKS) revert TimeoutNotReached();

        _finish(id, m, side);
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

    // ---------------------------------------------------------------- internal

    function _requireMatch(uint256 id) private view returns (Match storage m) {
        if (id == 0 || id > _matches.length) revert MatchNotFound(id);
        return _matches[id - 1];
    }

    function _sideOf(Match storage m, address player) private view returns (uint8) {
        if (player == m.p1) return SIDE_P1;
        if (player == m.p2) return SIDE_P2;
        revert NotPlayer();
    }

    function _initSide(Side storage s) private {
        for (uint8 i; i < BOARD_SLOTS; ++i) {
            s.board[i] = NO_CARD;
        }
    }

    function _firstTurn(uint256 id) private view returns (uint8) {
        uint256 r = uint256(keccak256(abi.encode(block.prevrandao, id, FIRST_TURN_DOMAIN)));
        return r % 2 == 0 ? SIDE_P1 : SIDE_P2;
    }

    function _drawCard(uint256 id, uint8 side, Side storage s, uint8 drawNo) private {
        (uint8 el, uint8 rar, uint16 atk, uint16 hp) = _drawStats(id, side, drawNo);
        s.cards[drawNo] = Card({el: el, rar: rar, atk: atk, maxHp: hp, hp: hp});
        s.drawn = drawNo + 1;
    }

    /// @dev Distribution matches NadCards: rarity 0-99 roll, ATK 10-14 plus
    ///      rarity, HP 1500-1800 plus 100 per rarity, element 0-2.
    function _drawStats(uint256 id, uint8 side, uint8 drawNo)
        internal
        view
        virtual
        returns (uint8 el, uint8 rar, uint16 atk, uint16 maxHp)
    {
        uint256 r = uint256(keccak256(abi.encode(block.prevrandao, id, side, drawNo)));
        uint256 roll = r % 100;
        rar = roll < 60 ? 0 : roll < 88 ? 1 : roll < 98 ? 2 : 3;
        atk = uint16(10 + ((r >> 8) % 5) + rar);
        maxHp = uint16(1500 + ((r >> 16) % 301) + 100 * uint256(rar));
        el = uint8((r >> 32) % 3);
    }

    function _sumDamage(Side storage attacker, uint8 targetEl) private view returns (uint256 damage) {
        for (uint8 i; i < BOARD_SLOTS; ++i) {
            uint8 cardNo = attacker.board[i];
            if (cardNo == NO_CARD) continue;
            Card storage card = attacker.cards[cardNo];
            damage += (uint256(card.atk) * DAMAGE_SCALE * elementMult(card.el, targetEl)) / 100;
        }
    }

    function _front(uint8[3] storage board) private view returns (uint8) {
        for (uint8 i; i < BOARD_SLOTS; ++i) {
            if (board[i] != NO_CARD) return board[i];
        }
        return NO_CARD;
    }

    function _firstEmpty(uint8[3] storage board) private view returns (uint8) {
        for (uint8 i; i < BOARD_SLOTS; ++i) {
            if (board[i] == NO_CARD) return i;
        }
        return NO_CARD;
    }

    function _removeCard(uint8[3] storage board, uint8 cardNo) private {
        for (uint8 i; i < BOARD_SLOTS; ++i) {
            if (board[i] == cardNo) {
                board[i] = NO_CARD;
                return;
            }
        }
    }

    /// @dev True when a side has nothing left anywhere: no board card, no hand
    ///      card (all ten draws placed) and an empty draw pile.
    function _isExhausted(Side storage s) private view returns (bool) {
        return s.drawn == MAX_DRAWS && s.placedCount == MAX_DRAWS && _front(s.board) == NO_CARD;
    }

    function _finish(uint256 id, Match storage m, uint8 winnerSide) private {
        m.status = winnerSide == SIDE_P1 ? Status.P1Won : Status.P2Won;
        m.turn = 0;
        emit MatchEnded(id, winnerSide == SIDE_P1 ? m.p1 : m.p2);
    }

    function _view(Match storage m) private view returns (MatchView memory v) {
        v.p1 = m.p1;
        v.p2 = m.p2;
        v.status = m.status;
        v.turn = m.turn;
        v.score1 = m.score1;
        v.score2 = m.score2;
        v.lastMoveBlock = m.lastMoveBlock;
        v.special1 = m.s1.specialUsed;
        v.special2 = m.s2.specialUsed;
        v.drawn1 = m.s1.drawn;
        v.drawn2 = m.s2.drawn;
        v.placed1 = m.s1.placed;
        v.placed2 = m.s2.placed;

        for (uint8 i; i < MAX_DRAWS; ++i) {
            Card storage c1 = m.s1.cards[i];
            Card storage c2 = m.s2.cards[i];
            v.el1[i] = c1.el;
            v.el2[i] = c2.el;
            v.rar1[i] = c1.rar;
            v.rar2[i] = c2.rar;
            v.atk1[i] = c1.atk;
            v.atk2[i] = c2.atk;
            v.maxHp1[i] = c1.maxHp;
            v.maxHp2[i] = c2.maxHp;
            v.hp1[i] = c1.hp;
            v.hp2[i] = c2.hp;
        }

        for (uint8 i; i < BOARD_SLOTS; ++i) {
            v.board1[i] = m.s1.board[i];
            v.board2[i] = m.s2.board[i];
        }
    }
}
