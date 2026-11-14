// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {JinxEscrowV2} from "../src/JinxEscrowV2.sol";
import {JinxRules} from "../src/JinxRules.sol";
import {TestToken} from "../src/TestToken.sol";

abstract contract JinxFixtureV2 is Test {
    uint256 internal constant PK_P1 = 0xA11CE;
    uint256 internal constant PK_P2 = 0xB0B;
    uint256 internal constant PK_K1 = 0xC1;
    uint256 internal constant PK_K2 = 0xC2;
    uint256 internal constant PK_REF = 0xDEF;
    uint8 internal constant NONE = 255;

    address internal p1 = vm.addr(PK_P1);
    address internal p2 = vm.addr(PK_P2);
    address internal k1 = vm.addr(PK_K1);
    address internal k2 = vm.addr(PK_K2);
    address internal ref = vm.addr(PK_REF);
    address internal treasury = address(0x7EA5);

    uint256 internal constant STAKE = 100e6;
    uint64 internal constant WINDOW = 30 minutes;
    uint64 internal constant DURATION = 2 hours;
    uint64 internal constant GRACE = 10 minutes;
    uint256 internal constant BOND = 5e6;
    uint16 internal constant RAKE = 850; // the tier for a $200 pot
    uint256 internal constant MIN_STAKE = 10e6;
    uint256 internal constant MAX_STAKE = 1_000e6;
    uint256 internal constant HARD_MAX_STAKE = 10_000e6;
    uint256 internal constant REF_BOND_FLOOR = 500e6;
    uint256 internal constant REF_BOND = 1_000e6;

    TestToken internal token;
    JinxEscrowV2 internal escrow;

    function setUp() public virtual {
        token = new TestToken();
        uint256[] memory floors = new uint256[](4);
        floors[0] = 0;
        floors[1] = 500e6;
        floors[2] = 1_000e6;
        floors[3] = 10_000e6;
        uint16[] memory bps = new uint16[](4);
        bps[0] = 850;
        bps[1] = 700;
        bps[2] = 500;
        bps[3] = 300;
        escrow = new JinxEscrowV2(
            JinxEscrowV2.Config({
                token: address(token),
                referee: ref,
                treasury: treasury,
                challengeWindow: WINDOW,
                matchDuration: DURATION,
                abortGrace: GRACE,
                disputeBond: BOND,
                minStake: MIN_STAKE,
                maxStake: MAX_STAKE,
                hardMaxStake: HARD_MAX_STAKE,
                refereeBondFloor: REF_BOND_FLOOR
            }),
            floors,
            bps
        );
        token.mint(ref, 10_000e6);
        vm.startPrank(ref);
        token.approve(address(escrow), type(uint256).max);
        escrow.depositRefereeBond(REF_BOND);
        vm.stopPrank();
        address[2] memory who = [p1, p2];
        for (uint256 i = 0; i < who.length; i++) {
            token.mint(who[i], 10_000e6);
            vm.prank(who[i]);
            token.approve(address(escrow), type(uint256).max);
        }
    }

    // True play, best of 3: P1 takes the top row twice. P2's squares never form a line.
    function _p1Wins() internal pure returns (uint8[] memory c) {
        c = new uint8[](12);
        uint8[12] memory v = [0, 24, 1, 20, 2, 14, 0, 24, 1, 20, 2, 14];
        for (uint256 i = 0; i < 12; i++) c[i] = v[i];
    }

    function _p2Wins() internal pure returns (uint8[] memory c) {
        c = new uint8[](12);
        uint8[12] memory v = [24, 0, 20, 1, 14, 2, 24, 0, 20, 1, 14, 2];
        for (uint256 i = 0; i < 12; i++) c[i] = v[i];
    }

    function _sig(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _newMatch(uint8 bestOf) internal returns (uint256 id) {
        vm.prank(p1);
        id = escrow.createOffer(STAKE, uint64(block.timestamp + 1 days), k1, bestOf);
        vm.prank(p2);
        escrow.challenge(id, k2);
    }

    function _openedMs(uint256 turn) internal pure returns (uint64) {
        return uint64(turn * 20_000);
    }

    function _salt(uint256 id, uint256 turn, uint8 side) internal pure returns (bytes32) {
        return keccak256(abi.encode("salt", id, turn, side));
    }

    /// Evidence for one side of one turn: a signed, receipted pick, or (cell == NONE) a referee-signed "no commitment" miss.
    function _side(uint256 id, uint256 turn, uint8 side, uint8 cell, bytes32 head)
        internal
        view
        returns (JinxEscrowV2.Side memory s)
    {
        s.openedMs = _openedMs(turn);
        if (cell == NONE) {
            s.missed = true;
            s.atMs = s.openedMs + 10_000;
            s.refSig = _sig(PK_REF, escrow.missDigest(id, uint16(turn), side, 0, bytes32(0), s.openedMs, s.atMs));
            return s;
        }
        s.cell = cell;
        s.salt = _salt(id, turn, side);
        bytes32 commitment = escrow.commitmentOf(id, uint16(turn), cell, s.salt);
        s.recvMs = s.openedMs + 1500 + side * 10;
        s.commitSig = _sig(side == 1 ? PK_K1 : PK_K2, escrow.commitDigest(id, uint16(turn), commitment, head));
        s.refSig = _sig(PK_REF, escrow.receiptDigest(id, uint16(turn), side, commitment, s.openedMs, s.recvMs));
    }

    function _commitOf(uint256 id, uint256 turn, uint8 side, uint8 cell) internal view returns (bytes32) {
        return cell == NONE ? bytes32(0) : escrow.commitmentOf(id, uint16(turn), cell, _salt(id, turn, side));
    }

    /// Builds the signed turns for flattened picks [a0, b0, a1, b1, ...] and the final chain head.
    function _turns(uint256 id, uint8[] memory picks) internal view returns (JinxEscrowV2.Turn[] memory turns, bytes32 head) {
        uint256 n = picks.length / 2;
        turns = new JinxEscrowV2.Turn[](n);
        head = escrow.genesisHash(id);
        for (uint256 i = 0; i < n; i++) {
            turns[i].a = _side(id, i, 1, picks[2 * i], head);
            turns[i].b = _side(id, i, 2, picks[2 * i + 1], head);
            head = escrow.chainHash(
                head, uint16(i), _commitOf(id, i, 1, picks[2 * i]), _commitOf(id, i, 2, picks[2 * i + 1]), picks[2 * i], picks[2 * i + 1]
            );
        }
    }

    /// A referee-asserted "committed, never revealed" miss (kind 1) for the commitment to `cell`.
    function _noReveal(uint256 id, uint256 turn, uint8 cell) internal view returns (JinxEscrowV2.Side memory s) {
        s.missed = true;
        s.missKind = 1;
        s.commitment = _commitOf(id, turn, 1, cell);
        s.openedMs = _openedMs(turn);
        s.atMs = s.openedMs + 4_000;
        s.refSig = _sig(PK_REF, escrow.missDigest(id, uint16(turn), 1, 1, s.commitment, s.openedMs, s.atMs));
    }

    function _stepHead(uint256 id, bytes32 head, uint256 turn, bytes32 commitA, uint8 cellA, uint8 cellB)
        internal
        view
        returns (bytes32)
    {
        return escrow.chainHash(head, uint16(turn), commitA, _commitOf(id, turn, 2, cellB), cellA, cellB);
    }

    /// Like _turns, but at the turns flagged in `noRevealMask` player 1 is recorded as "committed, never revealed"
    /// instead of revealing the pick in picks[2 * turn].
    function _turnsWithNoReveal(uint256 id, uint8[] memory picks, uint256 noRevealMask)
        internal
        view
        returns (JinxEscrowV2.Turn[] memory turns, bytes32 head)
    {
        turns = new JinxEscrowV2.Turn[](picks.length / 2);
        head = escrow.genesisHash(id);
        for (uint256 i = 0; i < turns.length; i++) {
            bool nr = (noRevealMask >> i) & 1 == 1;
            turns[i].a = nr ? _noReveal(id, i, picks[2 * i]) : _side(id, i, 1, picks[2 * i], head);
            turns[i].b = _side(id, i, 2, picks[2 * i + 1], head);
            head = _stepHead(id, head, i, nr ? turns[i].a.commitment : _commitOf(id, i, 1, picks[2 * i]), nr ? NONE : picks[2 * i], picks[2 * i + 1]);
        }
    }

    function _resultSigs(uint256 id, uint8 result, bytes32 fh)
        internal
        view
        returns (bytes memory s1, bytes memory s2, bytes memory sr)
    {
        bytes32 d = escrow.resultDigest(id, result, fh);
        s1 = _sig(PK_K1, d);
        s2 = _sig(PK_K2, d);
        sr = _sig(PK_REF, d);
    }

    function _claim(address who) internal returns (uint256 got) {
        uint256 before = token.balanceOf(who);
        vm.prank(who);
        escrow.claim();
        got = token.balanceOf(who) - before;
    }

    function _proposeAs(uint256 id, uint8 result, bytes32 fh, bool withP1) internal {
        (bytes memory s1, bytes memory s2, bytes memory sr) = _resultSigs(id, result, fh);
        escrow.settle(id, result, fh, withP1 ? s1 : bytes(""), withP1 ? bytes("") : s2, sr);
    }
}

contract JinxEscrowV2Test is JinxFixtureV2 {
    uint256 internal constant POT = STAKE * 2;
    uint256 internal constant RAKE_AMT = POT * RAKE / 10_000;

    // ------------------------------------------------------------ settlement

    function test_instantPayoutWhenEveryoneSigns() public {
        uint256 id = _newMatch(3);
        (, bytes32 head) = _turns(id, _p1Wins());
        (bytes memory s1, bytes memory s2, bytes memory sr) = _resultSigs(id, 1, head);
        escrow.settle(id, 1, head, s1, s2, sr);
        assertEq(_claim(p1), POT - RAKE_AMT);
        assertEq(_claim(treasury), RAKE_AMT);
        assertEq(token.balanceOf(address(escrow)), REF_BOND, "only the referee collateral is left");
    }

    function test_refundResultPaysBothBackWithoutRake() public {
        uint256 id = _newMatch(3);
        (bytes memory s1, bytes memory s2, bytes memory sr) = _resultSigs(id, 3, keccak256("x"));
        escrow.settle(id, 3, keccak256("x"), s1, s2, sr);
        assertEq(_claim(p1), STAKE);
        assertEq(_claim(p2), STAKE);
        assertEq(escrow.claimable(treasury), 0);
    }

    function test_silentLoserThenWindow() public {
        uint256 id = _newMatch(3);
        (, bytes32 head) = _turns(id, _p1Wins());
        _proposeAs(id, 1, head, true);
        vm.expectRevert(JinxEscrowV2.TooEarly.selector);
        escrow.finalize(id);
        vm.warp(block.timestamp + WINDOW);
        escrow.finalize(id);
        assertEq(_claim(p1), POT - RAKE_AMT);
        assertEq(escrow.claimable(p2), 0);
    }

    function test_proposalNeedsRefereeAndAPlayer() public {
        uint256 id = _newMatch(3);
        (bytes memory s1, bytes memory s2, bytes memory sr) = _resultSigs(id, 1, keccak256("h"));
        vm.expectRevert(JinxEscrowV2.NotEnoughSignatures.selector);
        escrow.settle(id, 1, keccak256("h"), "", "", sr);
        vm.expectRevert(JinxEscrowV2.NotEnoughSignatures.selector);
        escrow.settle(id, 1, keccak256("h"), s1, s2, "");
    }

    function test_abortRefundsAfterDeadline() public {
        uint256 id = _newMatch(5);
        vm.expectRevert(JinxEscrowV2.TooEarly.selector);
        escrow.abort(id);
        vm.warp(block.timestamp + DURATION + GRACE + 1);
        escrow.abort(id);
        assertEq(_claim(p1), STAKE);
        assertEq(_claim(p2), STAKE);
    }

    function test_offerValidation() public {
        vm.prank(p1);
        vm.expectRevert(JinxEscrowV2.BadParam.selector);
        escrow.createOffer(STAKE, uint64(block.timestamp + 1 days), k1, 4);
        vm.prank(p1);
        uint256 id = escrow.createOffer(STAKE, uint64(block.timestamp + 1 days), k1, 5);
        assertEq(escrow.getMatch(id).bestOf, 0); // not a match yet
        vm.prank(p2);
        escrow.challenge(id, k2);
        assertEq(escrow.getMatch(id).bestOf, 5);
    }

    function test_pauseBlocksOnlyNewOffersAndChallenges() public {
        uint256 live = _newMatch(3);
        escrow.setPaused(true);
        vm.prank(p1);
        vm.expectRevert(JinxEscrowV2.PausedErr.selector);
        escrow.createOffer(STAKE, uint64(block.timestamp + 1 days), k1, 3);
        (, bytes32 head) = _turns(live, _p1Wins());
        (bytes memory s1, bytes memory s2, bytes memory sr) = _resultSigs(live, 1, head);
        escrow.settle(live, 1, head, s1, s2, sr);
        assertGt(_claim(p1), STAKE);
    }

    // ------------------------------------------------------- dispute: replay

    function test_realMatchReplaysAndMatchesTheClaim() public {
        uint256 id = _newMatch(3);
        (JinxEscrowV2.Turn[] memory turns, bytes32 head) = _turns(id, _p1Wins());
        _proposeAs(id, 1, head, true);
        vm.prank(p2);
        escrow.dispute(id);
        escrow.submitReplay(id, turns);
        vm.warp(block.timestamp + WINDOW);
        escrow.finalizeDispute(id);
        // The claim was right, so the disputer's bond goes to the other player.
        assertEq(escrow.claimable(p1), POT - RAKE_AMT + BOND);
        assertEq(escrow.claimable(p2), 0);
    }

    function test_fabricatedResultOverturnedByReplay() public {
        uint256 id = _newMatch(3);
        _proposeAs(id, 1, keccak256("fake"), true); // referee + P1 claim P1 won
        vm.prank(p2);
        escrow.dispute(id);
        (JinxEscrowV2.Turn[] memory turns,) = _turns(id, _p2Wins()); // P2 really won
        escrow.submitReplay(id, turns);
        vm.warp(block.timestamp + WINDOW);
        escrow.finalizeDispute(id);
        assertEq(escrow.claimable(p2), POT - RAKE_AMT + BOND);
        assertEq(escrow.claimable(p1), 0);
    }

    function test_disputeWithoutReplayRefundsEverything() public {
        uint256 id = _newMatch(3);
        _proposeAs(id, 1, keccak256("x"), true);
        vm.prank(p2);
        escrow.dispute(id);
        vm.warp(block.timestamp + WINDOW);
        escrow.finalizeDispute(id);
        assertEq(escrow.claimable(p1), STAKE);
        assertEq(escrow.claimable(p2), STAKE + BOND);
    }

    function test_doubleForfeitReplayRefunds() public {
        uint256 id = _newMatch(3);
        uint8[] memory picks = new uint8[](4);
        picks[0] = NONE; picks[1] = NONE; picks[2] = NONE; picks[3] = NONE;
        (JinxEscrowV2.Turn[] memory turns, bytes32 head) = _turns(id, picks);
        _proposeAs(id, 3, head, true);
        vm.prank(p2);
        escrow.dispute(id);
        escrow.submitReplay(id, turns);
        vm.warp(block.timestamp + WINDOW);
        escrow.finalizeDispute(id);
        assertEq(escrow.claimable(p1), STAKE + BOND); // claim confirmed: bond to the other side
        assertEq(escrow.claimable(p2), STAKE);
        assertEq(escrow.claimable(treasury), 0);
    }

    function test_forfeitsDecideAMatch() public {
        // P1 misses twice in each game, so P2 takes both games.
        uint256 id = _newMatch(3);
        uint8[] memory picks = new uint8[](8);
        picks[0] = NONE; picks[1] = 24; picks[2] = NONE; picks[3] = 20;
        picks[4] = NONE; picks[5] = 24; picks[6] = NONE; picks[7] = 20;
        (JinxEscrowV2.Turn[] memory turns, bytes32 head) = _turns(id, picks);
        _proposeAs(id, 2, head, false);
        vm.prank(p1);
        escrow.dispute(id);
        escrow.submitReplay(id, turns);
        vm.warp(block.timestamp + WINDOW);
        escrow.finalizeDispute(id);
        assertEq(escrow.claimable(p2), POT - RAKE_AMT + BOND);
    }

    // ---------------------------------------------------- misses and receipts

    /// The referee and P2 claim P1 missed turns 1-2 and 4-5 (so P2 wins), although P1 sent signed, receipted picks.
    function _dishonestPicks() internal pure returns (uint8[] memory c) {
        c = new uint8[](12);
        uint8[12] memory v = [0, 24, NONE, 20, NONE, 14, 0, 24, NONE, 20, NONE, 14];
        for (uint256 i = 0; i < 12; i++) c[i] = v[i];
    }

    function test_voidMissOverturnsAFalseMiss() public {
        uint256 id = _newMatch(3);
        (JinxEscrowV2.Turn[] memory fake, bytes32 fakeHead) = _turns(id, _dishonestPicks());
        _proposeAs(id, 2, fakeHead, false); // referee + P2 propose that P2 won
        vm.prank(p1);
        escrow.dispute(id);

        escrow.submitReplay(id, fake); // the dishonest log is internally valid: it becomes the best log
        (JinxEscrowV2.Turn[] memory honest,) = _turns(id, _p1Wins());
        escrow.submitReplay(id, honest); // same length, so it does not replace the first one

        // P1 holds the referee's own signed receipt for the pick at turn 1 and contradicts the miss.
        JinxEscrowV2.Side memory real = honest[1].a;
        escrow.voidMiss(id, 1, 1, _commitOf(id, 1, 1, 1), real.openedMs, real.recvMs, real.refSig);

        vm.expectRevert(JinxEscrowV2.MissIsVoided.selector);
        escrow.submitReplay(id, fake);

        escrow.submitReplay(id, honest); // the honest log can now stand
        vm.warp(block.timestamp + WINDOW);
        escrow.finalizeDispute(id);
        assertEq(escrow.claimable(p1), POT - RAKE_AMT + BOND + STAKE, "winnings, dispute bond back, and the referee slash");
        assertEq(escrow.claimable(p2), 0);
    }

    function test_withoutVoidTheFalseMissStandsOnATie() public {
        uint256 id = _newMatch(3);
        (JinxEscrowV2.Turn[] memory fake, bytes32 fakeHead) = _turns(id, _dishonestPicks());
        _proposeAs(id, 2, fakeHead, false);
        vm.prank(p1);
        escrow.dispute(id);
        escrow.submitReplay(id, fake);
        (JinxEscrowV2.Turn[] memory honest,) = _turns(id, _p1Wins());
        escrow.submitReplay(id, honest);
        vm.warp(block.timestamp + WINDOW);
        escrow.finalizeDispute(id);
        // The referee's word held (that is the trusted part), so the claim was right and P1's dispute bond goes to P2.
        assertEq(escrow.claimable(p2), POT - RAKE_AMT + BOND);
    }

    function test_cannotVoidWithAnInvalidOrLateReceipt() public {
        uint256 id = _newMatch(3);
        _proposeAs(id, 2, keccak256("f"), false);
        vm.prank(p1);
        escrow.dispute(id);
        (JinxEscrowV2.Turn[] memory honest,) = _turns(id, _p1Wins());
        JinxEscrowV2.Side memory real = honest[1].a;
        bytes32 c = _commitOf(id, 1, 1, 1);

        // Signed by the wrong key.
        bytes memory forged = _sig(0xBAD, escrow.receiptDigest(id, 1, 1, c, real.openedMs, real.recvMs));
        vm.expectRevert(JinxEscrowV2.BadSignature.selector);
        escrow.voidMiss(id, 1, 1, c, real.openedMs, real.recvMs, forged);

        // A genuine receipt that says the commitment arrived after the clock ran out proves nothing.
        uint64 lateRecv = real.openedMs + 12_000;
        bytes memory late = _sig(PK_REF, escrow.receiptDigest(id, 1, 1, c, real.openedMs, lateRecv));
        vm.expectRevert(JinxEscrowV2.BadReplay.selector);
        escrow.voidMiss(id, 1, 1, c, real.openedMs, lateRecv, late);

        // A receipt for the other side does not void this side's miss.
        vm.expectRevert(JinxEscrowV2.BadSignature.selector);
        escrow.voidMiss(id, 1, 2, c, real.openedMs, real.recvMs, real.refSig);
    }

    function test_aNoRevealMissCannotBeVoided() public {
        // Kind 1: the referee says P1 committed but never revealed. A receipt for the commitment must not cancel it,
        // otherwise a player could withhold a reveal until they had seen the opponent's pick.
        uint256 id = _newMatch(3);
        // P1 is recorded as a no-reveal at turns 1, 2, 4 and 5, so P1 forfeits both games and P2 takes the match.
        (JinxEscrowV2.Turn[] memory log, bytes32 head) = _turnsWithNoReveal(id, _p1Wins(), (1 << 1) | (1 << 2) | (1 << 4) | (1 << 5));
        _proposeAs(id, 2, head, false);
        vm.prank(p1);
        escrow.dispute(id);

        // P1 holds a genuine receipt for the commitment at turn 1 and voids that slot. It must not matter.
        JinxEscrowV2.Side memory real = _side(id, 1, 1, 1, bytes32(0));
        escrow.voidMiss(id, 1, 1, _commitOf(id, 1, 1, 1), real.openedMs, real.recvMs, real.refSig);
        escrow.submitReplay(id, log); // still accepted: the referee's no-reveal call is the trusted part
        vm.warp(block.timestamp + WINDOW);
        escrow.finalizeDispute(id);
        assertEq(escrow.claimable(p2), POT - RAKE_AMT + BOND); // the claim held, so P1's bond goes to P2
        assertEq(escrow.claimable(p1), 0);
    }

    // -------------------------------------------------------------- rejections

    function _disputed(uint8[] memory picks) internal returns (uint256 id, JinxEscrowV2.Turn[] memory turns) {
        id = _newMatch(3);
        _proposeAs(id, 1, keccak256("claim"), true);
        vm.prank(p2);
        escrow.dispute(id);
        (turns,) = _turns(id, picks);
    }

    function test_replayRejectsAForgedPlayerSignature() public {
        (uint256 id, JinxEscrowV2.Turn[] memory turns) = _disputed(_p1Wins());
        turns[1].a.commitSig = _sig(PK_K2, keccak256("not it")); // wrong key
        vm.expectRevert(JinxEscrowV2.BadSignature.selector);
        escrow.submitReplay(id, turns);
    }

    function test_replayRejectsAnUnreceiptedPick() public {
        // A player cannot add a second, secretly signed commitment: the referee only receipts the real one.
        (uint256 id, JinxEscrowV2.Turn[] memory turns) = _disputed(_p1Wins());
        JinxEscrowV2.Side memory other = _side(id, 2, 1, 3, escrow.genesisHash(id));
        turns[2].a.cell = 3;
        turns[2].a.salt = other.salt;
        vm.expectRevert(JinxEscrowV2.BadSignature.selector);
        escrow.submitReplay(id, turns);
    }

    function test_replayRejectsAPickThatDoesNotMatchItsCommitment() public {
        (uint256 id, JinxEscrowV2.Turn[] memory turns) = _disputed(_p1Wins());
        turns[0].a.cell = 7; // revealed cell differs from the committed one
        vm.expectRevert(JinxEscrowV2.BadSignature.selector);
        escrow.submitReplay(id, turns);
    }

    function test_replayRejectsALateReceipt() public {
        (uint256 id, JinxEscrowV2.Turn[] memory turns) = _disputed(_p1Wins());
        JinxEscrowV2.Side memory s = turns[0].a;
        s.recvMs = s.openedMs + 13_000; // the referee's own receipt says the pick came after the clock
        bytes32 c = _commitOf(id, 0, 1, 0);
        s.refSig = _sig(PK_REF, escrow.receiptDigest(id, 0, 1, c, s.openedMs, s.recvMs));
        turns[0].a = s;
        vm.expectRevert(JinxEscrowV2.BadReplay.selector);
        escrow.submitReplay(id, turns);
    }

    function test_replayRejectsAnEarlyMissCall() public {
        uint8[] memory picks = _p1Wins();
        picks[0] = NONE;
        (uint256 id, JinxEscrowV2.Turn[] memory turns) = _disputed(picks);
        JinxEscrowV2.Side memory s = turns[0].a;
        s.atMs = s.openedMs + 5_000; // called before the 10 second clock ran out
        s.refSig = _sig(PK_REF, escrow.missDigest(id, 0, 1, 0, bytes32(0), s.openedMs, s.atMs));
        turns[0].a = s;
        vm.expectRevert(JinxEscrowV2.BadReplay.selector);
        escrow.submitReplay(id, turns);
    }

    function test_replayRejectsReorderedTurns() public {
        (uint256 id, JinxEscrowV2.Turn[] memory turns) = _disputed(_p1Wins());
        (turns[0], turns[1]) = (turns[1], turns[0]);
        vm.expectRevert();
        escrow.submitReplay(id, turns);
    }

    function test_replayRejectsATruncatedMatch() public {
        (uint256 id, JinxEscrowV2.Turn[] memory turns) = _disputed(_p1Wins());
        JinxEscrowV2.Turn[] memory shortLog = new JinxEscrowV2.Turn[](4);
        for (uint256 i = 0; i < 4; i++) shortLog[i] = turns[i];
        vm.expectRevert(JinxEscrowV2.BadReplay.selector);
        escrow.submitReplay(id, shortLog);
    }

    function test_replayRejectsTurnsAfterTheMatchIsDecided() public {
        uint8[] memory picks = new uint8[](14);
        uint8[] memory base = _p1Wins();
        for (uint256 i = 0; i < 12; i++) picks[i] = base[i];
        picks[12] = 5;
        picks[13] = 6;
        (uint256 id, JinxEscrowV2.Turn[] memory turns) = _disputed(picks);
        vm.expectRevert(JinxEscrowV2.BadReplay.selector);
        escrow.submitReplay(id, turns);
    }

    function test_replayRejectsSignaturesFromAnotherMatch() public {
        (uint256 id,) = _disputed(_p1Wins());
        uint256 other = _newMatch(3);
        (JinxEscrowV2.Turn[] memory turns,) = _turns(other, _p1Wins());
        vm.expectRevert(JinxEscrowV2.BadSignature.selector);
        escrow.submitReplay(id, turns);
    }

    function test_replayOutsideTheWindowOrStatusIsRejected() public {
        (uint256 id, JinxEscrowV2.Turn[] memory turns) = _disputed(_p1Wins());
        uint256 fresh = _newMatch(3);
        (JinxEscrowV2.Turn[] memory t2,) = _turns(fresh, _p1Wins());
        vm.expectRevert(JinxEscrowV2.WrongStatus.selector);
        escrow.submitReplay(fresh, t2);
        vm.warp(block.timestamp + WINDOW);
        vm.expectRevert(JinxEscrowV2.TooLate.selector);
        escrow.submitReplay(id, turns);
    }

    // --------------------------------------------- worst case: the 120 turn cap

    /// Both players jinx the same square every turn. Two drawn games trigger the death match, which can never end this
    /// way, so the match hits the turn cap and is refunded. This is also the heaviest possible replay.
    function test_turnCapRefundsAndFitsInOneTransaction() public {
        uint256 id = _newMatch(5);
        uint8[] memory picks = new uint8[](240);
        uint32[48] memory l = JinxRules.lines();
        JinxRules.Game memory g;
        uint8 draws;
        for (uint256 t = 0; t < 120; t++) {
            uint32 empty = JinxRules.empties(g);
            uint8 cell;
            while ((empty >> cell) & 1 == 0) cell++;
            picks[2 * t] = cell;
            picks[2 * t + 1] = cell;
            (uint8 outcome,) = JinxRules.applyTurn(g, cell, cell, l);
            if (outcome == JinxRules.DRAW) {
                draws++;
                g = JinxRules.Game(0, 0, 0, 0, 0, 0, 0, draws >= 2);
            }
        }
        (JinxEscrowV2.Turn[] memory turns, bytes32 head) = _turns(id, picks);
        _proposeAs(id, 3, head, true);
        vm.prank(p2);
        escrow.dispute(id);

        uint256 before = gasleft();
        escrow.submitReplay(id, turns);
        uint256 used = before - gasleft();
        emit log_named_uint("gas to replay a 120-turn match", used);
        assertLt(used, 16_000_000, "must fit under Base's 16.7M per-transaction gas cap");

        vm.warp(block.timestamp + WINDOW);
        escrow.finalizeDispute(id);
        assertEq(escrow.claimable(p1), STAKE + BOND); // the refund claim held, so P2's bond goes to P1
        assertEq(escrow.claimable(p2), STAKE);
    }

    function test_replayOverTheCapIsRejected() public {
        (uint256 id,) = _disputed(_p1Wins());
        JinxEscrowV2.Turn[] memory tooMany = new JinxEscrowV2.Turn[](121);
        vm.expectRevert(JinxEscrowV2.BadReplay.selector);
        escrow.submitReplay(id, tooMany);
    }

    // ======================================================== v2: stake limits

    function _offer(address who, uint256 stake) internal returns (uint256 id) {
        vm.prank(who);
        id = escrow.createOffer(stake, uint64(block.timestamp + 1 days), k1, 3);
    }

    function test_stakeMustBeWithinTheLimits() public {
        vm.prank(p1);
        vm.expectRevert(JinxEscrowV2.StakeTooLow.selector);
        escrow.createOffer(MIN_STAKE - 1, uint64(block.timestamp + 1 days), k1, 3);
        vm.prank(p1);
        vm.expectRevert(JinxEscrowV2.StakeTooLow.selector);
        escrow.createOffer(0, uint64(block.timestamp + 1 days), k1, 3);
        vm.prank(p1);
        vm.expectRevert(JinxEscrowV2.StakeTooHigh.selector);
        escrow.createOffer(MAX_STAKE + 1, uint64(block.timestamp + 1 days), k1, 3);
        _offer(p1, MIN_STAKE); // the edges are allowed
        _offer(p1, MAX_STAKE);
    }

    function test_ownerCanMoveTheCapOnlyWithinTheHardCap() public {
        vm.prank(p1);
        vm.expectRevert(JinxEscrowV2.NotOwner.selector);
        escrow.setMaxStake(50e6);
        vm.expectRevert(JinxEscrowV2.BadParam.selector);
        escrow.setMaxStake(HARD_MAX_STAKE + 1);
        vm.expectRevert(JinxEscrowV2.BadParam.selector);
        escrow.setMaxStake(MIN_STAKE - 1);
        escrow.setMaxStake(HARD_MAX_STAKE);
        assertEq(escrow.maxStake(), HARD_MAX_STAKE);
        escrow.setMaxStake(MIN_STAKE);
        assertEq(escrow.maxStake(), MIN_STAKE);
    }

    function test_loweringTheCapAlsoStopsOlderLargerOffers() public {
        uint256 id = _offer(p1, 100e6);
        escrow.setMaxStake(50e6);
        vm.prank(p2);
        vm.expectRevert(JinxEscrowV2.StakeTooHigh.selector);
        escrow.challenge(id, k2);
        vm.prank(p1);
        escrow.cancelOffer(id); // the creator can always take it back
        assertEq(escrow.claimable(p1), 100e6);
    }

    function test_aCapChangeNeverTouchesAMatchAlreadyUnderway() public {
        uint256 id = _newMatch(3);
        escrow.setMaxStake(MIN_STAKE);
        (, bytes32 head) = _turns(id, _p1Wins());
        (bytes memory s1, bytes memory s2, bytes memory sr) = _resultSigs(id, 1, head);
        escrow.settle(id, 1, head, s1, s2, sr);
        assertEq(_claim(p1), POT - RAKE_AMT);
    }

    // ============================================================ v2: rake tiers

    function test_rakeTiersAreCliffsAtTheAgreedPots() public view {
        assertEq(escrow.rakeBpsFor(20e6), 850);
        assertEq(escrow.rakeBpsFor(499_999_999), 850);
        assertEq(escrow.rakeBpsFor(500e6), 700);
        assertEq(escrow.rakeBpsFor(999_999_999), 700);
        assertEq(escrow.rakeBpsFor(1_000e6), 500);
        assertEq(escrow.rakeBpsFor(9_999_999_999), 500);
        assertEq(escrow.rakeBpsFor(10_000e6), 300);
        assertEq(escrow.rakeBpsFor(type(uint256).max), 300);
        assertEq(escrow.rakeBpsFor(0), 850);
        (uint256[] memory floors, uint16[] memory bps) = escrow.rakeTiers();
        assertEq(floors.length, 4);
        assertEq(bps[3], 300);
    }

    function _topUpReferee(uint256 amount) internal {
        token.mint(ref, amount);
        vm.startPrank(ref);
        escrow.depositRefereeBond(amount);
        vm.stopPrank();
    }

    /// A pot of 2 * stake, settled instantly for player 1; returns what player 1 and the treasury were credited.
    function _settledPot(uint256 stake) internal returns (uint256 toWinner, uint256 toTreasury) {
        escrow.setMaxStake(HARD_MAX_STAKE);
        _topUpReferee(stake);
        vm.prank(p1);
        uint256 id = escrow.createOffer(stake, uint64(block.timestamp + 1 days), k1, 3);
        vm.prank(p2);
        escrow.challenge(id, k2);
        (bytes memory s1, bytes memory s2, bytes memory sr) = _resultSigs(id, 1, keccak256("x"));
        uint256 w0 = escrow.claimable(p1);
        uint256 t0 = escrow.claimable(treasury);
        escrow.settle(id, 1, keccak256("x"), s1, s2, sr);
        return (escrow.claimable(p1) - w0, escrow.claimable(treasury) - t0);
    }

    function test_theRakeTakenMatchesTheTierForEachPot() public {
        uint256[5] memory stakes = [uint256(10e6), 249e6, 250e6, 500e6, 5_000e6]; // pots 20, 498, 500, 1000, 10000
        uint256[5] memory expectBps = [uint256(850), 850, 700, 500, 300];
        for (uint256 i = 0; i < stakes.length; i++) {
            (uint256 win, uint256 fee) = _settledPot(stakes[i]);
            uint256 pot = stakes[i] * 2;
            assertEq(fee, pot * expectBps[i] / 10_000, "rake");
            assertEq(win + fee, pot, "the pot is fully accounted for");
        }
    }

    function test_theRateIsFixedWhenTheMatchStarts() public {
        uint256 id = _newMatch(3);
        assertEq(escrow.getMatch(id).rakeBps, 850);
    }

    function _tiers(uint256 n) internal pure returns (uint256[] memory f, uint16[] memory b) {
        f = new uint256[](n);
        b = new uint16[](n);
        for (uint256 i = 0; i < n; i++) {
            f[i] = i * 100e6;
            b[i] = uint16(800 - i * 50);
        }
    }

    function _config() internal view returns (JinxEscrowV2.Config memory) {
        return JinxEscrowV2.Config({
            token: address(token),
            referee: ref,
            treasury: treasury,
            challengeWindow: WINDOW,
            matchDuration: DURATION,
            abortGrace: GRACE,
            disputeBond: BOND,
            minStake: MIN_STAKE,
            maxStake: MAX_STAKE,
            hardMaxStake: HARD_MAX_STAKE,
            refereeBondFloor: REF_BOND_FLOOR
        });
    }

    function test_badTierTablesAreRejectedAtDeployment() public {
        JinxEscrowV2.Config memory c = _config();
        (uint256[] memory f, uint16[] memory b) = _tiers(3);
        new JinxEscrowV2(c, f, b); // the sample table itself is fine

        (uint256[] memory f0, uint16[] memory b0) = _tiers(0);
        vm.expectRevert(JinxEscrowV2.BadParam.selector);
        new JinxEscrowV2(c, f0, b0); // empty

        (f, b) = _tiers(9);
        vm.expectRevert(JinxEscrowV2.BadParam.selector);
        new JinxEscrowV2(c, f, b); // too many tiers

        (f, b) = _tiers(3);
        b[1] = b[0] + 1;
        vm.expectRevert(JinxEscrowV2.BadParam.selector);
        new JinxEscrowV2(c, f, b); // the rate must never rise with the pot

        (f, b) = _tiers(3);
        b[0] = 1001;
        vm.expectRevert(JinxEscrowV2.BadParam.selector);
        new JinxEscrowV2(c, f, b); // over the 10% ceiling

        (f, b) = _tiers(3);
        f[1] = f[2];
        vm.expectRevert(JinxEscrowV2.BadParam.selector);
        new JinxEscrowV2(c, f, b); // floors must strictly rise

        (f, b) = _tiers(3);
        f[0] = 2 * MIN_STAKE + 1;
        f[1] = f[0] + 1;
        f[2] = f[0] + 2;
        vm.expectRevert(JinxEscrowV2.BadParam.selector);
        new JinxEscrowV2(c, f, b); // some legal pots would have no tier

        (f, b) = _tiers(2);
        c.minStake = 0;
        vm.expectRevert(JinxEscrowV2.BadParam.selector);
        new JinxEscrowV2(c, f, b);
        c = _config();
        c.maxStake = MIN_STAKE - 1;
        vm.expectRevert(JinxEscrowV2.BadParam.selector);
        new JinxEscrowV2(c, f, b);
        c = _config();
        c.hardMaxStake = MAX_STAKE - 1;
        vm.expectRevert(JinxEscrowV2.BadParam.selector);
        new JinxEscrowV2(c, f, b);
    }

    // ========================================================= v2: referee bond

    function _unbonded() internal returns (JinxEscrowV2 e) {
        (uint256[] memory f, uint16[] memory b) = _tiers(2);
        e = new JinxEscrowV2(_config(), f, b);
        for (uint256 i = 0; i < 2; i++) {
            address who = i == 0 ? p1 : p2;
            vm.prank(who);
            token.approve(address(e), type(uint256).max);
        }
        vm.prank(ref);
        token.approve(address(e), type(uint256).max);
    }

    function test_noMatchWithoutRefereeCollateral() public {
        JinxEscrowV2 e = _unbonded();
        vm.prank(p1);
        uint256 id = e.createOffer(STAKE, uint64(block.timestamp + 1 days), k1, 3);
        vm.prank(p2);
        vm.expectRevert(JinxEscrowV2.RefereeUnderBonded.selector);
        e.challenge(id, k2);

        vm.prank(ref);
        e.depositRefereeBond(REF_BOND_FLOOR - 1); // one short of the floor
        vm.prank(p2);
        vm.expectRevert(JinxEscrowV2.RefereeUnderBonded.selector);
        e.challenge(id, k2);

        vm.prank(ref);
        e.depositRefereeBond(1);
        vm.prank(p2);
        e.challenge(id, k2); // now it works
        assertEq(e.refereeActive(ref), 1);
    }

    function test_collateralMustCoverTheStakeNotJustTheFloor() public {
        escrow.setMaxStake(2_000e6);
        vm.prank(p1);
        uint256 id = escrow.createOffer(REF_BOND + 1, uint64(block.timestamp + 1 days), k1, 3); // bigger than the posted collateral
        vm.prank(p2);
        vm.expectRevert(JinxEscrowV2.RefereeUnderBonded.selector);
        escrow.challenge(id, k2);
        _topUpReferee(1);
        vm.prank(p2);
        escrow.challenge(id, k2);
    }

    function test_depositingNothingIsRejected() public {
        vm.prank(ref);
        vm.expectRevert(JinxEscrowV2.BadParam.selector);
        escrow.depositRefereeBond(0);
    }

    function test_theCurrentRefereeCannotWithdrawWithoutLeaving() public {
        vm.prank(ref);
        vm.expectRevert(JinxEscrowV2.BondLocked.selector);
        escrow.withdrawBond(1);
    }

    function test_leavingStopsNewMatchesAndPaysOutOnlyAfterOldOnesClose() public {
        uint256 live = _newMatch(3);
        vm.prank(ref);
        escrow.requestBondExit();

        uint256 id2 = _offer(p1, STAKE);
        vm.prank(p2);
        vm.expectRevert(JinxEscrowV2.RefereeUnavailable.selector);
        escrow.challenge(id2, k2);

        vm.prank(ref);
        vm.expectRevert(JinxEscrowV2.BondLocked.selector); // a match is still unsettled
        escrow.withdrawBond(REF_BOND);

        (, bytes32 head) = _turns(live, _p1Wins());
        (bytes memory s1, bytes memory s2, bytes memory sr) = _resultSigs(live, 1, head);
        escrow.settle(live, 1, head, s1, s2, sr);
        assertEq(escrow.refereeActive(ref), 0);

        uint256 before = token.balanceOf(ref);
        vm.prank(ref);
        escrow.withdrawBond(REF_BOND);
        assertEq(token.balanceOf(ref) - before, REF_BOND);
        assertEq(escrow.refereeBond(ref), 0);
        assertEq(escrow.totalRefereeBond(), 0);

        vm.prank(ref);
        vm.expectRevert(JinxEscrowV2.BadParam.selector); // nothing left
        escrow.withdrawBond(1);
    }

    function test_changingYourMindRestoresNewMatches() public {
        vm.startPrank(ref);
        escrow.requestBondExit();
        escrow.cancelBondExit();
        vm.stopPrank();
        _newMatch(3);
    }

    function test_aRetiredRefereeCanTakeItsCollateralOnceItsMatchesClose() public {
        uint256 id = _newMatch(3);
        address newRef = address(0xBEEF);
        escrow.setReferee(newRef); // the owner swaps the referee; the old one's open match still counts
        vm.prank(ref);
        vm.expectRevert(JinxEscrowV2.BondLocked.selector);
        escrow.withdrawBond(1);
        vm.warp(block.timestamp + DURATION + GRACE + 1);
        escrow.abort(id);
        vm.prank(ref);
        escrow.withdrawBond(REF_BOND); // allowed: it is no longer the referee and nothing is open
        // The new referee has posted nothing, so it cannot be assigned matches yet.
        uint256 next = _offer(p1, STAKE);
        vm.prank(p2);
        vm.expectRevert(JinxEscrowV2.RefereeUnderBonded.selector);
        escrow.challenge(next, k2);
    }

    function test_everyWayAMatchCanCloseReleasesTheRefereesLock() public {
        // 1: instant settlement
        uint256 a = _newMatch(3);
        (, bytes32 head) = _turns(a, _p1Wins());
        (bytes memory s1, bytes memory s2, bytes memory sr) = _resultSigs(a, 1, head);
        escrow.settle(a, 1, head, s1, s2, sr);
        // 2: window then finalize
        uint256 b = _newMatch(3);
        (, head) = _turns(b, _p1Wins());
        _proposeAs(b, 1, head, true);
        // 3: abort
        uint256 c = _newMatch(3);
        // 4: dispute with no replay
        uint256 d = _newMatch(3);
        (, bytes32 headD) = _turns(d, _p1Wins());
        _proposeAs(d, 1, headD, true);
        vm.prank(p2);
        escrow.dispute(d);
        // 5: dispute with a replay
        uint256 e = _newMatch(3);
        (JinxEscrowV2.Turn[] memory turnsE, bytes32 headE) = _turns(e, _p1Wins());
        _proposeAs(e, 1, headE, true);
        vm.prank(p2);
        escrow.dispute(e);
        escrow.submitReplay(e, turnsE);
        assertEq(escrow.refereeActive(ref), 4);

        vm.warp(block.timestamp + WINDOW);
        escrow.finalize(b);
        escrow.finalizeDispute(d);
        escrow.finalizeDispute(e);
        vm.warp(block.timestamp + DURATION + GRACE + 1);
        escrow.abort(c);
        assertEq(escrow.refereeActive(ref), 0, "all five matches are closed");
    }

    // ============================================================ v2: slashing

    /// The referee and P2 produce a log in which P1 "missed" turns that P1 actually played; P1's receipts void it.
    function _falseMissDispute(uint256 id, bool voidIt) internal returns (JinxEscrowV2.Turn[] memory honest) {
        (JinxEscrowV2.Turn[] memory fake, bytes32 fakeHead) = _turns(id, _dishonestPicks());
        _proposeAs(id, 2, fakeHead, false);
        vm.prank(p1);
        escrow.dispute(id);
        if (voidIt) escrow.submitReplay(id, fake);
        (honest,) = _turns(id, _p1Wins());
        escrow.submitReplay(id, honest);
        if (voidIt) {
            JinxEscrowV2.Side memory real = honest[1].a;
            escrow.voidMiss(id, 1, 1, _commitOf(id, 1, 1, 1), real.openedMs, real.recvMs, real.refSig);
        }
    }

    function test_aFalseMissThatIsVoidedSlashesTheRefereeToTheWrongedPlayer() public {
        uint256 id = _newMatch(3);
        uint256 bondBefore = escrow.refereeBond(ref);
        uint256 p1Before = escrow.claimable(p1);
        JinxEscrowV2.Turn[] memory honest = _falseMissDispute(id, true);
        assertEq(escrow.refereeBond(ref), bondBefore - STAKE, "one stake taken from the collateral");
        assertEq(escrow.claimable(p1) - p1Before, STAKE, "paid to the player the referee wronged");
        assertEq(escrow.totalRefereeBond(), bondBefore - STAKE);
        assertTrue(escrow.slashed(id));
        escrow.submitReplay(id, honest);
        vm.warp(block.timestamp + WINDOW);
        escrow.finalizeDispute(id);
        assertEq(escrow.claimable(p1), POT - RAKE_AMT + BOND + STAKE);
    }

    function test_aVoidThatContradictsNoSubmittedMissCostsTheRefereeNothing() public {
        // Only the honest log is ever submitted. P1 holding a genuine receipt proves nothing against the referee.
        uint256 id = _newMatch(3);
        (JinxEscrowV2.Turn[] memory fake, bytes32 fakeHead) = _turns(id, _dishonestPicks());
        fake; // the dishonest log exists but is never submitted
        _proposeAs(id, 2, fakeHead, false);
        vm.prank(p1);
        escrow.dispute(id);
        (JinxEscrowV2.Turn[] memory honest,) = _turns(id, _p1Wins());
        escrow.submitReplay(id, honest);
        uint256 bondBefore = escrow.refereeBond(ref);
        JinxEscrowV2.Side memory real = honest[1].a;
        escrow.voidMiss(id, 1, 1, _commitOf(id, 1, 1, 1), real.openedMs, real.recvMs, real.refSig);
        assertEq(escrow.refereeBond(ref), bondBefore, "no slash without a contradicted miss on the table");
        assertFalse(escrow.slashed(id));
    }

    function test_aMatchSlashesAtMostOnce() public {
        uint256 id = _newMatch(3);
        JinxEscrowV2.Turn[] memory honest = _falseMissDispute(id, true);
        uint256 bondAfterFirst = escrow.refereeBond(ref);
        // Voiding another slot of the same match cannot slash again (and cannot re-open the cleared log).
        JinxEscrowV2.Side memory real = honest[2].a;
        escrow.voidMiss(id, 2, 1, _commitOf(id, 2, 1, 2), real.openedMs, real.recvMs, real.refSig);
        assertEq(escrow.refereeBond(ref), bondAfterFirst);
    }

    function test_theSlashIsCappedAtWhatTheRefereeHasLeft() public {
        // Collateral for 1.5 stakes with a floor of one stake. Two matches run at once; both get a false-miss attack.
        JinxEscrowV2.Config memory c = _config();
        c.refereeBondFloor = STAKE;
        (uint256[] memory f, uint16[] memory bps) = _tiers(2);
        escrow = new JinxEscrowV2(c, f, bps);
        address[3] memory who = [p1, p2, ref];
        for (uint256 i = 0; i < who.length; i++) {
            vm.prank(who[i]);
            token.approve(address(escrow), type(uint256).max);
        }
        vm.prank(ref);
        escrow.depositRefereeBond(STAKE + STAKE / 2);

        uint256 a = _newMatch(3);
        uint256 b = _newMatch(3);
        uint256 p1Start = escrow.claimable(p1);

        _falseMissDispute(a, true);
        assertEq(escrow.refereeBond(ref), STAKE / 2, "a full stake went to the first victim");
        assertEq(escrow.claimable(p1) - p1Start, STAKE);

        _falseMissDispute(b, true);
        assertEq(escrow.refereeBond(ref), 0, "the second slash took only what was left");
        assertEq(escrow.claimable(p1) - p1Start, STAKE + STAKE / 2);
        assertEq(escrow.totalRefereeBond(), 0);
    }

    function test_nothingIsLostOrCreated() public {
        uint256 id = _newMatch(3);
        JinxEscrowV2.Turn[] memory honest = _falseMissDispute(id, true);
        escrow.submitReplay(id, honest);
        vm.warp(block.timestamp + WINDOW);
        escrow.finalizeDispute(id);
        _claim(p1);
        _claim(treasury);
        assertEq(token.balanceOf(address(escrow)), escrow.totalCredited() + escrow.totalRefereeBond(), "balance = credits + collateral");
        assertEq(escrow.claimable(p2), 0);
    }

    // ================================================================= v2: fuzz

    function testFuzz_rakeIsNeverAboveTheCapAndNeverRisesWithThePot(uint256 pot, uint256 more) public view {
        more = bound(more, 0, type(uint128).max);
        pot = bound(pot, 0, type(uint128).max);
        uint16 a = escrow.rakeBpsFor(pot);
        uint16 b = escrow.rakeBpsFor(pot + more);
        assertLe(a, escrow.MAX_RAKE_BPS());
        assertLe(b, a, "a bigger pot never pays a higher rate");
        assertGe(a, 300);
    }

    function testFuzz_thePotIsAlwaysFullyAccounted(uint256 stake) public {
        stake = bound(stake, MIN_STAKE, HARD_MAX_STAKE);
        (uint256 win, uint256 fee) = _settledPot(stake);
        assertEq(win + fee, stake * 2);
        assertEq(fee, stake * 2 * escrow.rakeBpsFor(stake * 2) / 10_000);
    }
}
