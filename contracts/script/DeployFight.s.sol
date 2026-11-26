// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {FightEscrow} from "../src/FightEscrow.sol";

/// Deploys FightEscrow against an existing token. Amounts are in token units (6 decimals: 10e6 = 10 tokens).
/// Env, required: TOKEN, REFEREE, ARBITER, TREASURY (immutable, so choose an address you control).
/// Env, optional (testnet defaults): RAKE_BPS 300 (max 1000), CHALLENGE_WINDOW 1800, MATCH_DURATION 1800 (a best of 5
/// runs about 10 minutes), ABORT_GRACE 600, ARBITER_WINDOW 86400, DISPUTE_BOND 5e6, MIN_STAKE 10e6, MAX_STAKE 100e6.
/// The arbiter is a trusted address that rules on disputes: use a wallet separate from the referee's.
contract DeployFight is Script {
    function run() external {
        FightEscrow.Config memory c = FightEscrow.Config({
            token: vm.envAddress("TOKEN"),
            referee: vm.envAddress("REFEREE"),
            arbiter: vm.envAddress("ARBITER"),
            treasury: vm.envAddress("TREASURY"),
            challengeWindow: uint64(vm.envOr("CHALLENGE_WINDOW", uint256(1800))),
            matchDuration: uint64(vm.envOr("MATCH_DURATION", uint256(1800))),
            abortGrace: uint64(vm.envOr("ABORT_GRACE", uint256(600))),
            arbiterWindow: uint64(vm.envOr("ARBITER_WINDOW", uint256(86400))),
            disputeBond: vm.envOr("DISPUTE_BOND", uint256(5e6)),
            minStake: vm.envOr("MIN_STAKE", uint256(5e6)),
            maxStake: vm.envOr("MAX_STAKE", uint256(100e6))
        });
        // The launch rake, by pot (both stakes together): 7% from $10, 5% from $100, 3% from $1,000. Override with RAKE_*.
        uint256[] memory floors = new uint256[](3);
        uint16[] memory bps = new uint16[](3);
        floors[1] = vm.envOr("RAKE_FLOOR_MID", uint256(100e6));
        floors[2] = vm.envOr("RAKE_FLOOR_HIGH", uint256(1000e6));
        bps[0] = uint16(vm.envOr("RAKE_BPS_LOW", uint256(700)));
        bps[1] = uint16(vm.envOr("RAKE_BPS_MID", uint256(500)));
        bps[2] = uint16(vm.envOr("RAKE_BPS_HIGH", uint256(300)));
        vm.startBroadcast();
        FightEscrow escrow = new FightEscrow(c, floors, bps);
        vm.stopBroadcast();
        console.log("FightEscrow:", address(escrow));
        console.log("FIGHT_ESCROW =", address(escrow));
    }
}
