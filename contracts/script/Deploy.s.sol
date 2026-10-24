// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {NadCards} from "../src/NadCards.sol";
import {BlitzArena} from "../src/BlitzArena.sol";
import {StakeVault} from "../src/StakeVault.sol";
import {INadCards} from "../src/interfaces/INadCards.sol";

/// @notice Deploys NadCards + BlitzArena, locks the arena into NadCards, and
///         points the token metadata at the public card endpoint when PUBLIC_URL is set.
contract Deploy is Script {
    function run() external returns (NadCards cards, BlitzArena arena) {
        vm.startBroadcast();
        cards = new NadCards();
        arena = new BlitzArena(INadCards(address(cards)));
        cards.setArena(address(arena));

        string memory publicUrl = vm.envOr("PUBLIC_URL", string(""));
        if (bytes(publicUrl).length != 0) {
            cards.setBaseURI(_cardBase(publicUrl));
        }
        vm.stopBroadcast();

        console2.log("NadCards", address(cards));
        console2.log("BlitzArena", address(arena));
        console2.log("deployBlock", block.number);
    }

    /// @notice Mainnet path: deploys NadCards + BlitzArena + StakeVault from
    ///         MAINNET_DEPLOYER_KEY. No setBaseURI (PUBLIC_URL is empty on mainnet).
    function runMainnet() external returns (NadCards cards, BlitzArena arena, StakeVault vault) {
        uint256 deployerKey = vm.envUint("MAINNET_DEPLOYER_KEY");
        vm.startBroadcast(deployerKey);
        cards = new NadCards();
        arena = new BlitzArena(INadCards(address(cards)));
        cards.setArena(address(arena));
        vault = new StakeVault(address(arena));
        vm.stopBroadcast();

        console2.log("NadCards", address(cards));
        console2.log("BlitzArena", address(arena));
        console2.log("StakeVault", address(vault));
        console2.log("deployBlock", block.number);
    }

    /// @dev `https://host/` -> `https://host/card/`; never produces a double slash.
    function _cardBase(string memory publicUrl) internal pure returns (string memory) {
        bytes memory raw = bytes(publicUrl);
        uint256 end = raw.length;
        while (end > 0 && raw[end - 1] == "/") {
            end--;
        }
        bytes memory trimmed = new bytes(end);
        for (uint256 i; i < end; ++i) {
            trimmed[i] = raw[i];
        }
        return string.concat(string(trimmed), "/card/");
    }
}
