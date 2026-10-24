// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Interface consumed by BlitzArena.
interface INadCards {
    /// @dev Same layout as `NadCards.Card` (one storage slot).
    struct Card {
        uint16 atk;
        uint16 hp;
        uint8 element;
        uint8 rarity;
        uint16 wins;
        uint16 losses;
        uint64 mintedAt;
    }

    function ownerOf(uint256 tokenId) external view returns (address);

    function cards(uint256 id) external view returns (Card memory);

    function cardOf(address a) external view returns (uint256);

    function recordResult(uint256 winId, uint256 loseId) external;
}
