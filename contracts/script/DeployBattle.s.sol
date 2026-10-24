// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {CardBattle} from "../src/CardBattle.sol";

/// @notice Deploys CardBattle v3. No constructor arguments: the contract has no
///         NFT dependency and generates its own cards.
contract DeployBattle is Script {
    function run() external returns (CardBattle battle) {
        uint256 deployerKey = vm.envUint("MASTER_KEY");

        vm.startBroadcast(deployerKey);
        battle = new CardBattle();
        vm.stopBroadcast();

        console2.log("CardBattle", address(battle));
        console2.log("deployBlock", block.number);
    }
}