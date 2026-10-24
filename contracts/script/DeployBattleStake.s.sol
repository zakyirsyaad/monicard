// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {BattleStakeVault} from "../src/BattleStakeVault.sol";

/// @notice Deploys BattleStakeVault against the already-deployed CardBattle.
///         Usage: `forge script script/DeployBattleStake.s.sol --sig "run(address)" <battle> --broadcast ...`
contract DeployBattleStake is Script {
    function run(address battle) external returns (BattleStakeVault vault) {
        require(battle.code.length != 0, "battle has no code");
        uint256 deployerKey = vm.envUint("MASTER_KEY");

        vm.startBroadcast(deployerKey);
        vault = new BattleStakeVault(battle);
        vm.stopBroadcast();

        console2.log("BattleStakeVault", address(vault));
        console2.log("battle", battle);
        console2.log("deployBlock", block.number);
    }
}
