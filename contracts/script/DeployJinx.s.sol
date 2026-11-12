// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {JinxEscrow} from "../src/JinxEscrow.sol";

/// Deploys JinxEscrow against an existing token.
/// Env: TOKEN, REFEREE and TREASURY (addresses, all required; treasury is immutable, so choose an address you control),
/// RAKE_BPS (default 300), CHALLENGE_WINDOW (secs, default 1800), MATCH_DURATION (default 7200), ABORT_GRACE (default 600),
/// DISPUTE_BOND (default 5e6).
contract DeployJinx is Script {
    function run() external {
        vm.startBroadcast();
        JinxEscrow escrow = new JinxEscrow(
            vm.envAddress("TOKEN"),
            vm.envAddress("REFEREE"),
            vm.envAddress("TREASURY"),
            uint16(vm.envOr("RAKE_BPS", uint256(300))),
            uint64(vm.envOr("CHALLENGE_WINDOW", uint256(1800))),
            uint64(vm.envOr("MATCH_DURATION", uint256(7200))),
            uint64(vm.envOr("ABORT_GRACE", uint256(600))),
            vm.envOr("DISPUTE_BOND", uint256(5e6))
        );
        vm.stopBroadcast();
        console.log("JINX_ESCROW", address(escrow));
    }
}
