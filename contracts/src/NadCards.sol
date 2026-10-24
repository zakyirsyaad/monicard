// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC2981} from "@openzeppelin/contracts/token/common/ERC2981.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

/// @title NadCards
/// @notice ERC-721 Nadmon cards with a free pull per address, a paid pull,
///         onchain stats, and a treasury funded by paid pulls.
contract NadCards is ERC721, ERC2981, Ownable {
    /// @dev 18 bytes, fits in one storage slot.
    struct Card {
        uint16 atk;
        uint16 hp;
        uint8 element;
        uint8 rarity;
        uint16 wins;
        uint16 losses;
        uint64 mintedAt;
    }

    error AlreadyPulled();
    error OnlyEOA();
    error OnlyArena();
    error ArenaAlreadySet();
    error WrongPrice();

    uint256 public constant PULL_PRICE = 0.05 ether;

    /// @notice Card owned by an address (0 = never pulled). Token ids start at 1.
    mapping(address => uint256) public cardOf;

    /// @notice Address allowed to record duel results.
    address public arena;

    mapping(uint256 => Card) private _cards;
    uint256 private _nextId;
    string private _baseUri;

    event CardMinted(
        uint256 indexed tokenId, address indexed owner, uint8 rarity, uint8 element, uint16 atk, uint16 hp
    );

    constructor() ERC721("NadCards", "NAD") Ownable(msg.sender) {
        _setDefaultRoyalty(msg.sender, 500);
    }

    /// @notice Mint the one free card for `msg.sender`.
    function freePull() external returns (uint256 tokenId) {
        _checkEOA();
        if (cardOf[msg.sender] != 0) revert AlreadyPulled();
        tokenId = _pull(msg.sender);
        cardOf[msg.sender] = tokenId;
    }

    /// @notice Mint a card for `PULL_PRICE`; the new card becomes the active card.
    function paidPull() external payable returns (uint256 tokenId) {
        _checkEOA();
        if (msg.value != PULL_PRICE) revert WrongPrice();
        tokenId = _pull(msg.sender);
        cardOf[msg.sender] = tokenId;
    }

    /// @notice Send the whole treasury balance to `to`.
    function withdraw(address payable to) external onlyOwner {
        Address.sendValue(to, address(this).balance);
    }

    function cards(uint256 id) external view returns (Card memory) {
        return _cards[id];
    }

    function hasPulled(address a) external view returns (bool) {
        return cardOf[a] != 0;
    }

    /// @notice Record a duel result; only callable by the arena.
    function recordResult(uint256 winId, uint256 loseId) external {
        if (msg.sender != arena) revert OnlyArena();
        _cards[winId].wins += 1;
        _cards[loseId].losses += 1;
    }

    /// @notice Set the arena once; afterwards the slot is locked.
    function setArena(address a) external onlyOwner {
        if (arena != address(0)) revert ArenaAlreadySet();
        arena = a;
    }

    function setBaseURI(string calldata uri) external onlyOwner {
        _baseUri = uri;
    }

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        return string.concat(_baseUri, Strings.toString(tokenId));
    }

    function supportsInterface(bytes4 interfaceId) public view override(ERC721, ERC2981) returns (bool) {
        return super.supportsInterface(interfaceId);
    }

    function _pull(address to) internal returns (uint256 tokenId) {
        tokenId = ++_nextId;

        uint256 r = uint256(keccak256(abi.encodePacked(block.prevrandao, msg.sender, tokenId)));
        uint8 roll = uint8(r % 100);
        uint8 rarity = roll < 60 ? 0 : roll < 88 ? 1 : roll < 98 ? 2 : 3;
        uint16 atk = uint16(10 + ((r >> 8) % 5) + rarity);
        uint16 hp = uint16(1500 + ((r >> 16) % 301) + 100 * uint256(rarity));
        uint8 element = uint8((r >> 32) % 3);

        _cards[tokenId] = Card({
            atk: atk, hp: hp, element: element, rarity: rarity, wins: 0, losses: 0, mintedAt: uint64(block.number)
        });

        _mint(to, tokenId);
        emit CardMinted(tokenId, to, rarity, element, atk, hp);
    }

    function _checkEOA() private view {
        if (msg.sender != tx.origin || msg.sender.code.length != 0) revert OnlyEOA();
    }
}
