// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {StakeVault} from "../src/StakeVault.sol";

/// @notice Deploys StakeVault against the already-deployed BlitzArena.
///         Usage: `forge script script/DeployStake.s.sol --sig "run(address)" <arena> --broadcast ...`
contract DeployStake is Script {
    function run(address arena) external returns (StakeVault vault) {
        require(arena.code.length != 0, "arena has no code");
        vm.startBroadcast();
        vault = new StakeVault(arena);
        vm.stopBroadcast();

        console2.log("StakeVault", address(vault));
        console2.log("arena", arena);
        console2.log("deployBlock", block.number);
    }
}
