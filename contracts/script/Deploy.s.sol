// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {PotEscrow} from "../src/PotEscrow.sol";
import {TestToken} from "../src/TestToken.sol";

/// Env: REFEREE (address, required), TREASURY (default: deployer), CHALLENGE_WINDOW (secs, default 1800),
/// MATCH_DURATION (default 3600), ABORT_GRACE (default 600), DISPUTE_BOND (default 5e6), RAKE_BPS (default 300).
contract Deploy is Script {
    function run() external {
        address referee = vm.envAddress("REFEREE");
        address treasury = vm.envOr("TREASURY", msg.sender);
        vm.startBroadcast();
        TestToken token = new TestToken();
        PotEscrow escrow = new PotEscrow(
            address(token),
            referee,
            treasury,
            uint16(vm.envOr("RAKE_BPS", uint256(300))),
            uint64(vm.envOr("CHALLENGE_WINDOW", uint256(1800))),
            uint64(vm.envOr("MATCH_DURATION", uint256(3600))),
            uint64(vm.envOr("ABORT_GRACE", uint256(600))),
            vm.envOr("DISPUTE_BOND", uint256(5e6))
        );
        vm.stopBroadcast();
        console.log("TOKEN", address(token));
        console.log("ESCROW", address(escrow));
    }
}
