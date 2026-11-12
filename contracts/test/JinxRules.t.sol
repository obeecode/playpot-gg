// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {JinxRules} from "../src/JinxRules.sol";

contract JinxRulesTest is Test {
    // Field names are alphabetical because Foundry decodes JSON objects by sorted key.
    struct Fixture {
        uint256 death;
        uint256[] expectFlags;
        uint256[] expectOutcome;
        uint256[] picks;
        uint256[] states;
    }

    /// Replays seeded games generated from the TypeScript rules (scripts/gen-jinx-fixtures.ts) and compares the
    /// outcome, flags and the whole board after every turn.
    function test_solidityRulesMatchTypeScriptRules() public view {
        Fixture[] memory fx = abi.decode(vm.parseJson(vm.readFile("test/fixtures/jinx_rules.json")), (Fixture[]));
        assertEq(fx.length, 600);
        uint32[48] memory l = JinxRules.lines();
        uint256 turns;
        for (uint256 i = 0; i < fx.length; i++) {
            JinxRules.Game memory g;
            g.death = fx[i].death == 1;
            uint256 n = fx[i].expectOutcome.length;
            for (uint256 t = 0; t < n; t++) {
                (uint8 outcome, uint8 flags) = JinxRules.applyTurn(g, uint8(fx[i].picks[2 * t]), uint8(fx[i].picks[2 * t + 1]), l);
                assertEq(outcome, fx[i].expectOutcome[t], "outcome");
                assertEq(flags, fx[i].expectFlags[t], "flags");
                assertEq(g.p1, fx[i].states[5 * t], "p1");
                assertEq(g.p2, fx[i].states[5 * t + 1], "p2");
                assertEq(g.dead, fx[i].states[5 * t + 2], "dead");
                assertEq(g.ageHi, fx[i].states[5 * t + 3], "ageHi");
                assertEq(g.ageLo, fx[i].states[5 * t + 4], "ageLo");
                turns++;
            }
        }
        assertGt(turns, 4000);
    }

    function test_illegalPicksRevert() public {
        uint32[48] memory l = JinxRules.lines();
        JinxRules.Game memory g;
        vm.expectRevert(JinxRules.IllegalPick.selector);
        this.applyExternal(g, 25, 0, l);
        JinxRules.applyTurn(g, 3, 4, l);
        vm.expectRevert(JinxRules.IllegalPick.selector);
        this.applyExternal(g, 3, 9, l);
    }

    function applyExternal(JinxRules.Game memory g, uint8 a, uint8 b, uint32[48] memory l) external pure {
        JinxRules.applyTurn(g, a, b, l);
    }
}
