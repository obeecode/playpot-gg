// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {JinxEscrowV2} from "../src/JinxEscrowV2.sol";

/// Deploys JinxEscrowV2 against an existing token. Amounts are in token units (6 decimals: 10e6 = 10 tokens).
/// Env, required: TOKEN, REFEREE, TREASURY (immutable, so choose an address you control).
/// Env, optional (defaults agreed for the testnet beta):
///   MIN_STAKE 10e6 (per player, so a $20 pot), MAX_STAKE 100e6 (the starting cap), HARD_MAX_STAKE 1000e6 (the cap can
///   never be raised above this), REFEREE_BOND_FLOOR 500e6, CHALLENGE_WINDOW 1800, MATCH_DURATION 7200,
///   ABORT_GRACE 600, DISPUTE_BOND 5e6.
/// Rake tiers by pot (cliffs): 8.5% from the minimum pot, 7% from 500, 5% from 1,000, 3% from 10,000. Override with
/// RAKE_FLOORS and RAKE_BPS as comma-separated lists, for example RAKE_FLOORS=0,500000000 RAKE_BPS=850,700.
/// After deploying, the referee must approve the escrow for the token and call depositRefereeBond(amount): until it
/// does, no match can start.
contract DeployJinxV2 is Script {
    function run() external {
        uint256[] memory defFloors = new uint256[](4);
        uint256[] memory defBps = new uint256[](4);
        defFloors[1] = 500e6;
        defFloors[2] = 1_000e6;
        defFloors[3] = 10_000e6;
        defBps[0] = 850;
        defBps[1] = 700;
        defBps[2] = 500;
        defBps[3] = 300;
        uint256[] memory floors = vm.envOr("RAKE_FLOORS", ",", defFloors);
        uint256[] memory raw = vm.envOr("RAKE_BPS", ",", defBps);
        uint16[] memory bps = new uint16[](raw.length);
        for (uint256 i = 0; i < raw.length; i++) bps[i] = uint16(raw[i]);

        JinxEscrowV2.Config memory c = JinxEscrowV2.Config({
            token: vm.envAddress("TOKEN"),
            referee: vm.envAddress("REFEREE"),
            treasury: vm.envAddress("TREASURY"),
            challengeWindow: uint64(vm.envOr("CHALLENGE_WINDOW", uint256(1800))),
            matchDuration: uint64(vm.envOr("MATCH_DURATION", uint256(7200))),
            abortGrace: uint64(vm.envOr("ABORT_GRACE", uint256(600))),
            disputeBond: vm.envOr("DISPUTE_BOND", uint256(5e6)),
            minStake: vm.envOr("MIN_STAKE", uint256(10e6)),
            maxStake: vm.envOr("MAX_STAKE", uint256(100e6)),
            hardMaxStake: vm.envOr("HARD_MAX_STAKE", uint256(1_000e6)),
            refereeBondFloor: vm.envOr("REFEREE_BOND_FLOOR", uint256(500e6))
        });
        vm.startBroadcast();
        JinxEscrowV2 escrow = new JinxEscrowV2(c, floors, bps);
        vm.stopBroadcast();
        console.log("JINX_ESCROW_V2", address(escrow));
    }
}
