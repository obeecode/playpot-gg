// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {FightEscrow} from "../src/FightEscrow.sol";
import {TestToken} from "../src/TestToken.sol";

abstract contract FightFixture is Test {
    uint256 internal constant PK_P1 = 0xA11CE;
    uint256 internal constant PK_P2 = 0xB0B;
    uint256 internal constant PK_K1 = 0xC1;
    uint256 internal constant PK_K2 = 0xC2;
    uint256 internal constant PK_REF = 0xDEF;
    uint256 internal constant PK_BAD = 0xBAD;

    address internal p1 = vm.addr(PK_P1);
    address internal p2 = vm.addr(PK_P2);
    address internal k1 = vm.addr(PK_K1);
    address internal k2 = vm.addr(PK_K2);
    address internal ref = vm.addr(PK_REF);
    address internal arbiter = address(0xA2B1);
    address internal treasury = address(0x7EA5);
    address internal stranger = address(0xC0FFEE);

    uint256 internal constant STAKE = 100e6;
    uint64 internal constant WINDOW = 30 minutes;
    uint64 internal constant DURATION = 1 hours;
    uint64 internal constant GRACE = 10 minutes;
    uint64 internal constant ARB_WINDOW = 1 days;
    uint256 internal constant BOND = 5e6;
    uint16 internal constant RAKE = 300;
    bytes32 internal constant REC = keccak256("record");

    TestToken internal token;
    FightEscrow internal escrow;

    function setUp() public virtual {
        token = new TestToken();
        escrow = new FightEscrow(
            FightEscrow.Config({
                token: address(token),
                referee: ref,
                arbiter: arbiter,
                treasury: treasury,
                rakeBps: RAKE,
                challengeWindow: WINDOW,
                matchDuration: DURATION,
                abortGrace: GRACE,
                arbiterWindow: ARB_WINDOW,
                disputeBond: BOND,
                minStake: 10e6,
                maxStake: 1_000e6
            })
        );
        address[3] memory who = [p1, p2, stranger];
        for (uint256 i = 0; i < who.length; i++) {
            token.mint(who[i], 10_000e6);
            vm.prank(who[i]);
            token.approve(address(escrow), type(uint256).max);
        }
    }

    function _sig(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _verdict(uint8 outcome, uint8 s1, uint8 s2) internal pure returns (FightEscrow.Verdict memory) {
        return FightEscrow.Verdict({outcome: outcome, record: REC, p1Score: s1, p2Score: s2});
    }

    function _digest(uint256 id, FightEscrow.Verdict memory v) internal view returns (bytes32) {
        return escrow.resultDigest(id, v.outcome, v.record, v.p1Score, v.p2Score);
    }

    function _newMatch() internal returns (uint256 id) {
        vm.prank(p1);
        id = escrow.createOffer(STAKE, uint64(block.timestamp + 1 days), k1);
        vm.prank(p2);
        escrow.challenge(id, k2);
    }

    /// The referee signs; nobody else needs to (this is how the server settles).
    function _propose(uint256 id, uint8 outcome) internal {
        FightEscrow.Verdict memory v = _verdict(outcome, 2, 0);
        vm.prank(stranger);
        escrow.settle(id, v, "", "", _sig(PK_REF, _digest(id, v)));
    }

    function _claim(address who) internal returns (uint256 got) {
        uint256 before = token.balanceOf(who);
        vm.prank(who);
        escrow.claim();
        got = token.balanceOf(who) - before;
    }

    function _winnerPayout() internal pure returns (uint256) {
        return STAKE * 2 - (STAKE * 2 * RAKE) / 10_000;
    }

    function _status(uint256 id) internal view returns (FightEscrow.Status) {
        return escrow.getMatch(id).status;
    }
}

contract FightEscrowTest is FightFixture {
    // ---------------------------------------------------------------- offers

    function test_offerLocksStakeAndChallengeStartsMatch() public {
        uint256 before = token.balanceOf(p1);
        uint256 id = _newMatch();
        assertEq(before - token.balanceOf(p1), STAKE);
        FightEscrow.Match memory m = escrow.getMatch(id);
        assertEq(m.p1, p1);
        assertEq(m.p2, p2);
        assertEq(m.key1, k1);
        assertEq(m.key2, k2);
        assertEq(m.referee, ref);
        assertEq(m.arbiter, arbiter);
        assertEq(uint8(m.status), uint8(FightEscrow.Status.Active));
        assertEq(token.balanceOf(address(escrow)), STAKE * 2);
    }

    function test_offerRejectsBadParameters() public {
        uint64 exp = uint64(block.timestamp + 1 days);
        vm.startPrank(p1);
        vm.expectRevert(FightEscrow.BadParam.selector);
        escrow.createOffer(1, exp, k1); // below the minimum stake
        vm.expectRevert(FightEscrow.BadParam.selector);
        escrow.createOffer(10_000e6, exp, k1); // above the maximum stake
        vm.expectRevert(FightEscrow.BadParam.selector);
        escrow.createOffer(STAKE, uint64(block.timestamp), k1); // already expired
        vm.expectRevert(FightEscrow.BadParam.selector);
        escrow.createOffer(STAKE, exp, address(0));
        vm.stopPrank();
    }

    function test_challengeRules() public {
        vm.prank(p1);
        uint256 id = escrow.createOffer(STAKE, uint64(block.timestamp + 1 hours), k1);
        vm.prank(p1);
        vm.expectRevert(FightEscrow.BadParam.selector);
        escrow.challenge(id, k2); // against yourself
        vm.prank(p2);
        vm.expectRevert(FightEscrow.BadParam.selector);
        escrow.challenge(id, k1); // the same session key as the creator
        vm.warp(block.timestamp + 2 hours);
        vm.prank(p2);
        vm.expectRevert(FightEscrow.TooLate.selector);
        escrow.challenge(id, k2); // expired
    }

    function test_cancelOfferRefundsAndOnlyTheCreatorCan() public {
        vm.prank(p1);
        uint256 id = escrow.createOffer(STAKE, uint64(block.timestamp + 1 days), k1);
        vm.prank(p2);
        vm.expectRevert(FightEscrow.NotPlayer.selector);
        escrow.cancelOffer(id);
        vm.prank(p1);
        escrow.cancelOffer(id);
        assertEq(_claim(p1), STAKE);
        vm.prank(p2);
        vm.expectRevert(FightEscrow.WrongStatus.selector);
        escrow.challenge(id, k2);
    }

    function test_pauseStopsNewOffersAndChallengesOnly() public {
        uint256 id = _newMatch();
        escrow.setPaused(true);
        vm.prank(p1);
        vm.expectRevert(FightEscrow.PausedErr.selector);
        escrow.createOffer(STAKE, uint64(block.timestamp + 1 days), k1);
        _propose(id, 1); // settling still works
        vm.warp(block.timestamp + WINDOW);
        escrow.finalize(id);
    }

    // ------------------------------------------------------------ settlement

    function test_refereeOnlyIsAProposalThenFinalizePaysAfterTheWindow() public {
        uint256 id = _newMatch();
        FightEscrow.Verdict memory v = _verdict(1, 2, 1);
        vm.prank(stranger);
        escrow.settle(id, v, "", "", _sig(PK_REF, _digest(id, v)));
        assertEq(uint8(_status(id)), uint8(FightEscrow.Status.Proposed));
        FightEscrow.Match memory m = escrow.getMatch(id);
        assertEq(m.record, REC);
        assertEq(m.p1Score, 2);
        assertEq(m.p2Score, 1);
        vm.expectRevert(FightEscrow.TooEarly.selector);
        escrow.finalize(id);
        vm.warp(block.timestamp + WINDOW);
        escrow.finalize(id);
        assertEq(_claim(p1), _winnerPayout());
        assertEq(_claim(treasury), (STAKE * 2 * RAKE) / 10_000);
        vm.expectRevert(FightEscrow.WrongStatus.selector);
        escrow.finalize(id);
    }

    function test_instantPayoutWhenEveryoneSigns() public {
        uint256 id = _newMatch();
        FightEscrow.Verdict memory v = _verdict(2, 0, 2);
        bytes32 d = _digest(id, v);
        escrow.settle(id, v, _sig(PK_K1, d), _sig(PK_K2, d), _sig(PK_REF, d));
        assertEq(uint8(_status(id)), uint8(FightEscrow.Status.Settled));
        assertEq(_claim(p2), _winnerPayout());
    }

    function test_agreementReplacesAProposalStillInItsWindow() public {
        uint256 id = _newMatch();
        _propose(id, 1);
        FightEscrow.Verdict memory v = _verdict(3, 0, 0);
        bytes32 d = _digest(id, v);
        escrow.settle(id, v, _sig(PK_K1, d), _sig(PK_K2, d), _sig(PK_REF, d));
        assertEq(uint8(_status(id)), uint8(FightEscrow.Status.Settled));
        assertEq(_claim(p1), STAKE);
        assertEq(_claim(p2), STAKE);
    }

    function test_secondRefereeOnlyProposalIsRefused() public {
        uint256 id = _newMatch();
        _propose(id, 1);
        FightEscrow.Verdict memory v = _verdict(2, 0, 2);
        bytes memory sr = _sig(PK_REF, _digest(id, v));
        vm.expectRevert(FightEscrow.WrongStatus.selector);
        escrow.settle(id, v, "", "", sr);
    }

    function test_signatureChecks() public {
        uint256 id = _newMatch();
        uint256 other = _newMatch();
        FightEscrow.Verdict memory v = _verdict(1, 2, 0);
        bytes32 d = _digest(id, v);
        vm.expectRevert(FightEscrow.BadSignature.selector);
        escrow.settle(id, v, "", "", _sig(PK_BAD, d)); // not the referee
        vm.expectRevert(FightEscrow.BadSignature.selector);
        escrow.settle(id, v, _sig(PK_BAD, d), "", _sig(PK_REF, d)); // not player 1's key
        vm.expectRevert(FightEscrow.NotReferee.selector);
        escrow.settle(id, v, "", "", ""); // the referee is required
        bytes memory forOther = _sig(PK_REF, _digest(other, v)); // computed first: an external call between expectRevert and the call under test would use it up
        vm.expectRevert(FightEscrow.BadSignature.selector);
        escrow.settle(id, v, "", "", forOther); // a signature for another match
        FightEscrow.Verdict memory edited = _verdict(1, 9, 0);
        vm.expectRevert(FightEscrow.BadSignature.selector);
        escrow.settle(id, edited, "", "", _sig(PK_REF, d)); // an edited score
        vm.expectRevert(FightEscrow.BadSignature.selector);
        escrow.settle(id, v, "", "", new bytes(65)); // an empty signature
        FightEscrow.Verdict memory zero = _verdict(0, 0, 0);
        bytes memory sigZero = _sig(PK_REF, _digest(id, zero));
        vm.expectRevert(FightEscrow.BadParam.selector);
        escrow.settle(id, zero, "", "", sigZero);
        FightEscrow.Verdict memory four = _verdict(4, 0, 0);
        bytes memory sigFour = _sig(PK_REF, _digest(id, four));
        vm.expectRevert(FightEscrow.BadParam.selector);
        escrow.settle(id, four, "", "", sigFour);
    }

    function test_voidRefundsBothWithoutRake() public {
        uint256 id = _newMatch();
        _propose(id, 3);
        vm.warp(block.timestamp + WINDOW);
        escrow.finalize(id);
        assertEq(_claim(p1), STAKE);
        assertEq(_claim(p2), STAKE);
        assertEq(escrow.claimable(treasury), 0);
    }

    // --------------------------------------------------------------- disputes

    function test_disputeFreezesTheMatchAndPullsTheBond() public {
        uint256 id = _newMatch();
        _propose(id, 1);
        vm.prank(stranger);
        vm.expectRevert(FightEscrow.NotPlayer.selector);
        escrow.dispute(id);
        uint256 before = token.balanceOf(p2);
        vm.prank(p2);
        escrow.dispute(id);
        assertEq(before - token.balanceOf(p2), BOND);
        assertEq(uint8(_status(id)), uint8(FightEscrow.Status.Disputed));
        vm.expectRevert(FightEscrow.WrongStatus.selector);
        escrow.finalize(id);
    }

    function test_disputeAfterTheWindowIsTooLate() public {
        uint256 id = _newMatch();
        _propose(id, 1);
        vm.warp(block.timestamp + WINDOW);
        vm.prank(p2);
        vm.expectRevert(FightEscrow.TooLate.selector);
        escrow.dispute(id);
    }

    function test_arbiterUpholdingTheProposalCostsTheDisputerTheBond() public {
        uint256 id = _newMatch();
        _propose(id, 1);
        vm.prank(p2);
        escrow.dispute(id);
        vm.prank(stranger);
        vm.expectRevert(FightEscrow.NotArbiter.selector);
        escrow.resolve(id, 1);
        vm.prank(arbiter);
        vm.expectRevert(FightEscrow.BadParam.selector);
        escrow.resolve(id, 0);
        vm.prank(arbiter);
        escrow.resolve(id, 1);
        assertEq(_claim(p1), _winnerPayout() + BOND);
        assertEq(escrow.claimable(p2), 0);
    }

    function test_arbiterOverturningReturnsTheBond() public {
        uint256 id = _newMatch();
        _propose(id, 1);
        vm.prank(p2);
        escrow.dispute(id);
        vm.prank(arbiter);
        escrow.resolve(id, 2);
        assertEq(_claim(p2), _winnerPayout() + BOND);
        assertEq(escrow.claimable(p1), 0);
        vm.prank(arbiter);
        vm.expectRevert(FightEscrow.WrongStatus.selector);
        escrow.resolve(id, 2);
    }

    function test_silentArbiterRefundsEverything() public {
        uint256 id = _newMatch();
        _propose(id, 2);
        vm.prank(p1);
        escrow.dispute(id);
        vm.expectRevert(FightEscrow.TooEarly.selector);
        escrow.timeoutDispute(id);
        vm.warp(block.timestamp + ARB_WINDOW);
        vm.prank(arbiter);
        vm.expectRevert(FightEscrow.TooLate.selector);
        escrow.resolve(id, 2);
        escrow.timeoutDispute(id);
        assertEq(_claim(p1), STAKE + BOND);
        assertEq(_claim(p2), STAKE);
        assertEq(uint8(_status(id)), uint8(FightEscrow.Status.Settled));
    }

    // ---------------------------------------------------- concede and abort

    function test_concedeGivesTheOtherPlayerTheWinWithRake() public {
        uint256 id = _newMatch();
        vm.prank(stranger);
        vm.expectRevert(FightEscrow.NotPlayer.selector);
        escrow.concede(id);
        vm.prank(p1);
        escrow.concede(id);
        assertEq(_claim(p2), _winnerPayout());
        assertEq(_claim(treasury), (STAKE * 2 * RAKE) / 10_000);
        vm.prank(p2);
        vm.expectRevert(FightEscrow.WrongStatus.selector);
        escrow.concede(id);
    }

    function test_cannotConcedeOnceAResultIsProposed() public {
        uint256 id = _newMatch();
        _propose(id, 1);
        vm.prank(p1);
        vm.expectRevert(FightEscrow.WrongStatus.selector);
        escrow.concede(id);
    }

    function test_abortRefundsAfterTheDeadlineOnly() public {
        uint256 id = _newMatch();
        vm.expectRevert(FightEscrow.TooEarly.selector);
        escrow.abort(id);
        vm.warp(block.timestamp + DURATION + GRACE + 1);
        escrow.abort(id);
        assertEq(_claim(p1), STAKE);
        assertEq(_claim(p2), STAKE);
    }

    function test_abortIsRefusedOnceAResultIsProposed() public {
        uint256 id = _newMatch();
        _propose(id, 1);
        vm.warp(block.timestamp + DURATION + GRACE + 1);
        vm.expectRevert(FightEscrow.WrongStatus.selector);
        escrow.abort(id);
    }

    // ----------------------------------------------------------------- admin

    function test_refereeAndArbiterChangesApplyToLaterMatchesOnly() public {
        uint256 id = _newMatch();
        address newRef = vm.addr(0xFEED);
        vm.prank(p1);
        vm.expectRevert(FightEscrow.NotOwner.selector);
        escrow.setReferee(newRef);
        vm.expectRevert(FightEscrow.BadParam.selector);
        escrow.setReferee(address(0));
        escrow.setReferee(newRef);
        escrow.setArbiter(stranger);
        assertEq(escrow.getMatch(id).referee, ref);
        assertEq(escrow.getMatch(id).arbiter, arbiter);
        _propose(id, 1); // the old referee still settles the old match
        uint256 id2 = _newMatch();
        assertEq(escrow.getMatch(id2).referee, newRef);
        assertEq(escrow.getMatch(id2).arbiter, stranger);
    }

    function test_constructorRejectsBadConfig() public {
        FightEscrow.Config memory c = FightEscrow.Config({
            token: address(token),
            referee: ref,
            arbiter: arbiter,
            treasury: treasury,
            rakeBps: 1001,
            challengeWindow: WINDOW,
            matchDuration: DURATION,
            abortGrace: GRACE,
            arbiterWindow: ARB_WINDOW,
            disputeBond: BOND,
            minStake: 10e6,
            maxStake: 1_000e6
        });
        vm.expectRevert(FightEscrow.BadParam.selector);
        new FightEscrow(c);
        c.rakeBps = RAKE;
        c.maxStake = 1e6; // below the minimum
        vm.expectRevert(FightEscrow.BadParam.selector);
        new FightEscrow(c);
        c.maxStake = 1_000e6;
        c.arbiter = address(0);
        vm.expectRevert(FightEscrow.BadParam.selector);
        new FightEscrow(c);
    }
}

/// Whatever happens, the contract holds exactly what is claimable plus what is still locked in unsettled matches and offers.
contract FightEscrowSolvencyTest is FightFixture {
    function testFuzz_everythingSettledLeavesNothingBehind(uint8 pick, uint8 route) public {
        pick = uint8(bound(pick, 1, 3));
        route = uint8(bound(route, 0, 4));
        uint256 id = _newMatch();
        if (route == 0) {
            _propose(id, pick);
            vm.warp(block.timestamp + WINDOW);
            escrow.finalize(id);
        } else if (route == 1) {
            _propose(id, pick);
            vm.prank(p2);
            escrow.dispute(id);
            vm.prank(arbiter);
            escrow.resolve(id, pick == 3 ? 1 : 3 - pick);
        } else if (route == 2) {
            _propose(id, pick);
            vm.prank(p1);
            escrow.dispute(id);
            vm.warp(block.timestamp + ARB_WINDOW);
            escrow.timeoutDispute(id);
        } else if (route == 3) {
            vm.prank(p2);
            escrow.concede(id);
        } else {
            vm.warp(block.timestamp + DURATION + GRACE + 1);
            escrow.abort(id);
        }
        assertEq(token.balanceOf(address(escrow)), escrow.totalCredited());
        address[3] memory who = [p1, p2, treasury];
        for (uint256 i = 0; i < who.length; i++) {
            if (escrow.claimable(who[i]) > 0) _claim(who[i]);
        }
        assertEq(token.balanceOf(address(escrow)), 0);
        assertEq(escrow.totalCredited(), 0);
    }
}
