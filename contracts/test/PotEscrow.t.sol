// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {PotEscrow} from "../src/PotEscrow.sol";
import {TestToken} from "../src/TestToken.sol";

abstract contract Fixture is Test {
    uint256 internal constant PK_P1 = 0xA11CE;
    uint256 internal constant PK_P2 = 0xB0B;
    uint256 internal constant PK_K1 = 0xC1;
    uint256 internal constant PK_K2 = 0xC2;
    uint256 internal constant PK_REF = 0xDEF;

    address internal p1 = vm.addr(PK_P1);
    address internal p2 = vm.addr(PK_P2);
    address internal k1 = vm.addr(PK_K1);
    address internal k2 = vm.addr(PK_K2);
    address internal ref = vm.addr(PK_REF);
    address internal treasury = address(0x7EA5);

    uint256 internal constant STAKE = 100e6;
    uint64 internal constant WINDOW = 30 minutes;
    uint64 internal constant DURATION = 1 hours;
    uint64 internal constant GRACE = 10 minutes;
    uint256 internal constant BOND = 5e6;
    uint16 internal constant RAKE = 300;

    TestToken internal token;
    PotEscrow internal escrow;

    // X wins on move 4 (top row).
    function _p1Win() internal pure returns (uint8[] memory c) {
        c = new uint8[](5);
        c[0] = 0; c[1] = 3; c[2] = 1; c[3] = 4; c[4] = 2;
    }

    // O wins on move 5 (middle row).
    function _p2Win() internal pure returns (uint8[] memory c) {
        c = new uint8[](6);
        c[0] = 0; c[1] = 3; c[2] = 1; c[3] = 4; c[4] = 8; c[5] = 5;
    }

    function _draw() internal pure returns (uint8[] memory c) {
        c = new uint8[](9);
        c[0] = 0; c[1] = 1; c[2] = 2; c[3] = 4; c[4] = 3; c[5] = 5; c[6] = 7; c[7] = 6; c[8] = 8;
    }

    function setUp() public virtual {
        token = new TestToken();
        escrow = new PotEscrow(address(token), ref, treasury, RAKE, WINDOW, DURATION, GRACE, BOND);
        address[3] memory who = [p1, p2, address(0xC0FFEE)];
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

    function _newMatch() internal returns (uint256 id) {
        vm.prank(p1);
        id = escrow.createOffer(STAKE, uint64(block.timestamp + 1 days), k1);
        vm.prank(p2);
        escrow.challenge(id, k2);
    }

    function _signMoves(uint256 id, uint8[] memory cells) internal view returns (bytes[] memory sigs) {
        sigs = new bytes[](cells.length);
        bytes32 h = escrow.genesisHash(id);
        for (uint256 i = 0; i < cells.length; i++) {
            sigs[i] = _sig(i % 2 == 0 ? PK_K1 : PK_K2, escrow.moveDigest(id, uint8(i), cells[i], h));
            h = escrow.chainHash(h, cells[i]);
        }
    }

    function _finalHash(uint256 id, uint8[] memory cells) internal view returns (bytes32 h) {
        h = escrow.genesisHash(id);
        for (uint256 i = 0; i < cells.length; i++) h = escrow.chainHash(h, cells[i]);
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
}

contract PotEscrowTest is Fixture {
    // ------------------------------------------------------------ happy path

    function test_instantPayoutWhenEveryoneSigns() public {
        uint256 id = _newMatch();
        uint8[] memory cells = _p1Win();
        bytes32 fh = _finalHash(id, cells);
        (bytes memory s1, bytes memory s2, bytes memory sr) = _resultSigs(id, 1, fh);

        escrow.settle(id, 1, fh, s1, s2, sr);

        uint256 pot = STAKE * 2;
        uint256 rake = pot * RAKE / 10_000;
        assertEq(_claim(p1), pot - rake);
        assertEq(_claim(treasury), rake);
        assertEq(escrow.claimable(p2), 0);
        assertEq(token.balanceOf(address(escrow)), 0);
    }

    function test_drawRefundsBothWithoutRake() public {
        uint256 id = _newMatch();
        bytes32 fh = _finalHash(id, _draw());
        (bytes memory s1, bytes memory s2, bytes memory sr) = _resultSigs(id, 3, fh);
        escrow.settle(id, 3, fh, s1, s2, sr);
        assertEq(_claim(p1), STAKE);
        assertEq(_claim(p2), STAKE);
        assertEq(escrow.claimable(treasury), 0);
    }

    function test_challengePullsMatchingStakeAtomically() public {
        vm.prank(p1);
        uint256 id = escrow.createOffer(STAKE, uint64(block.timestamp + 1 days), k1);
        assertEq(token.balanceOf(address(escrow)), STAKE);
        vm.prank(p2);
        escrow.challenge(id, k2);
        assertEq(token.balanceOf(address(escrow)), STAKE * 2);
        vm.prank(p2);
        vm.expectRevert(PotEscrow.WrongStatus.selector);
        escrow.challenge(id, k2);
    }

    // ------------------------------------------------- silent loser + window

    function test_silentLoserThenWindow() public {
        uint256 id = _newMatch();
        bytes32 fh = _finalHash(id, _p1Win());
        (bytes memory s1,, bytes memory sr) = _resultSigs(id, 1, fh);

        escrow.settle(id, 1, fh, s1, "", sr);

        vm.expectRevert(PotEscrow.TooEarly.selector);
        escrow.finalize(id);

        vm.warp(block.timestamp + WINDOW);
        escrow.finalize(id);

        assertEq(_claim(p1), STAKE * 2 - STAKE * 2 * RAKE / 10_000);
        assertEq(escrow.claimable(p2), 0);
    }

    function test_lateSignaturesUpgradeProposalToInstant() public {
        uint256 id = _newMatch();
        bytes32 fh = _finalHash(id, _p1Win());
        (bytes memory s1, bytes memory s2, bytes memory sr) = _resultSigs(id, 1, fh);
        escrow.settle(id, 1, fh, s1, "", sr);
        escrow.settle(id, 1, fh, s1, s2, sr);
        assertGt(escrow.claimable(p1), 0);
    }

    function test_proposalNeedsRefereeAndAPlayer() public {
        uint256 id = _newMatch();
        bytes32 fh = _finalHash(id, _p1Win());
        (bytes memory s1, bytes memory s2, bytes memory sr) = _resultSigs(id, 1, fh);

        vm.expectRevert(PotEscrow.NotEnoughSignatures.selector);
        escrow.settle(id, 1, fh, "", "", sr);
        vm.expectRevert(PotEscrow.NotEnoughSignatures.selector);
        escrow.settle(id, 1, fh, s1, s2, "");
        vm.expectRevert(PotEscrow.NotEnoughSignatures.selector);
        escrow.settle(id, 1, fh, s1, "", "");
    }

    // ---------------------------------------------------------- dispute replay

    function test_fabricatedResultOverturnedByReplay() public {
        uint256 id = _newMatch();
        // Referee and P1 collude and claim P1 won, but the signed moves show P2 won.
        bytes32 fakeHash = keccak256("fake");
        (bytes memory s1,, bytes memory sr) = _resultSigs(id, 1, fakeHash);
        escrow.settle(id, 1, fakeHash, s1, "", sr);

        vm.prank(p2);
        escrow.dispute(id);
        assertEq(token.balanceOf(address(escrow)), STAKE * 2 + BOND);

        uint8[] memory cells = _p2Win();
        escrow.submitReplay(id, cells, _signMoves(id, cells));

        vm.expectRevert(PotEscrow.TooEarly.selector);
        escrow.finalizeDispute(id);
        vm.warp(block.timestamp + WINDOW);
        escrow.finalizeDispute(id);

        uint256 pot = STAKE * 2;
        assertEq(escrow.claimable(p1), 0);
        assertEq(escrow.claimable(p2), pot - pot * RAKE / 10_000 + BOND);
        assertEq(escrow.claimable(treasury), pot * RAKE / 10_000);
    }

    function test_unfoundedDisputeForfeitsBondToCounterparty() public {
        uint256 id = _newMatch();
        uint8[] memory cells = _p1Win();
        bytes32 fh = _finalHash(id, cells);
        (bytes memory s1,, bytes memory sr) = _resultSigs(id, 1, fh);
        escrow.settle(id, 1, fh, s1, "", sr);

        vm.prank(p2);
        escrow.dispute(id);
        escrow.submitReplay(id, cells, _signMoves(id, cells));
        vm.warp(block.timestamp + WINDOW);
        escrow.finalizeDispute(id);

        uint256 pot = STAKE * 2;
        assertEq(escrow.claimable(p1), pot - pot * RAKE / 10_000 + BOND);
        assertEq(escrow.claimable(p2), 0);
    }

    function test_disputeWithoutReplayRefundsEverything() public {
        uint256 id = _newMatch();
        bytes32 fh = keccak256("x");
        (bytes memory s1,, bytes memory sr) = _resultSigs(id, 1, fh);
        escrow.settle(id, 1, fh, s1, "", sr);

        vm.prank(p2);
        escrow.dispute(id);
        vm.warp(block.timestamp + WINDOW);
        escrow.finalizeDispute(id);

        assertEq(escrow.claimable(p1), STAKE);
        assertEq(escrow.claimable(p2), STAKE + BOND);
        assertEq(escrow.claimable(treasury), 0);
    }

    function test_disputeOnlyInsideWindowAndByPlayers() public {
        uint256 id = _newMatch();
        bytes32 fh = _finalHash(id, _p1Win());
        (bytes memory s1,, bytes memory sr) = _resultSigs(id, 1, fh);
        escrow.settle(id, 1, fh, s1, "", sr);

        vm.prank(address(0xBAD));
        vm.expectRevert(PotEscrow.NotPlayer.selector);
        escrow.dispute(id);

        vm.warp(block.timestamp + WINDOW);
        vm.prank(p2);
        vm.expectRevert(PotEscrow.TooLate.selector);
        escrow.dispute(id);
    }

    function test_longestValidLogWinsAgainstEquivocation() public {
        uint256 id = _newMatch();
        bytes32 fh = keccak256("claim");
        (bytes memory s1,, bytes memory sr) = _resultSigs(id, 1, fh);
        escrow.settle(id, 1, fh, s1, "", sr);
        vm.prank(p2);
        escrow.dispute(id);

        // P1 signed two different moves at index 4: the real one (cell 8) and a secret winning one (cell 2).
        uint8[] memory real = _p2Win();
        uint8[] memory alt = _p1Win();
        bytes[] memory realSigs = _signMoves(id, real);
        bytes[] memory altSigs = _signMoves(id, alt);

        escrow.submitReplay(id, alt, altSigs); // attacker goes first
        escrow.submitReplay(id, real, realSigs); // honest longer log supersedes
        escrow.submitReplay(id, alt, altSigs); // resubmitting the shorter one changes nothing

        vm.warp(block.timestamp + WINDOW);
        escrow.finalizeDispute(id);
        uint256 pot = STAKE * 2;
        assertEq(escrow.claimable(p2), pot - pot * RAKE / 10_000 + BOND);
        assertEq(escrow.claimable(p1), 0);
    }

    function _disputedMatch() internal returns (uint256 id) {
        id = _newMatch();
        bytes32 fh = keccak256("claim");
        (bytes memory s1,, bytes memory sr) = _resultSigs(id, 1, fh);
        escrow.settle(id, 1, fh, s1, "", sr);
        vm.prank(p2);
        escrow.dispute(id);
    }

    function test_replayRejectsWrongSigner() public {
        uint256 id = _disputedMatch();
        uint8[] memory cells = _p1Win();
        bytes[] memory forged = _signMoves(id, cells);
        bytes32 prev = escrow.chainHash(escrow.genesisHash(id), cells[0]);
        forged[1] = _sig(PK_K1, escrow.moveDigest(id, 1, cells[1], prev));
        vm.expectRevert(PotEscrow.BadSignature.selector);
        escrow.submitReplay(id, cells, forged);
    }

    function test_replayRejectsNonTerminalLog() public {
        uint256 id = _disputedMatch();
        uint8[] memory cells = new uint8[](3);
        cells[0] = 0; cells[1] = 3; cells[2] = 1;
        bytes[] memory sigs = _signMoves(id, cells);
        vm.expectRevert(PotEscrow.BadReplay.selector);
        escrow.submitReplay(id, cells, sigs);
    }

    function test_replayRejectsReorderedMoves() public {
        uint256 id = _disputedMatch();
        uint8[] memory cells = _p1Win();
        bytes[] memory sigs = _signMoves(id, cells);
        (cells[0], cells[2]) = (cells[2], cells[0]);
        vm.expectRevert(PotEscrow.BadSignature.selector);
        escrow.submitReplay(id, cells, sigs);
    }

    function test_replayRejectsSignaturesFromAnotherMatch() public {
        uint256 id = _disputedMatch();
        uint256 other = _newMatch();
        uint8[] memory cells = _p1Win();
        bytes[] memory sigs = _signMoves(other, cells);
        vm.expectRevert(PotEscrow.BadSignature.selector);
        escrow.submitReplay(id, cells, sigs);
    }

    function test_replayRejectsOccupiedCell() public {
        uint256 id = _disputedMatch();
        uint8[] memory dup = new uint8[](3);
        dup[0] = 4; dup[1] = 4; dup[2] = 0;
        bytes[] memory sigs = _signMoves(id, dup);
        vm.expectRevert();
        escrow.submitReplay(id, dup, sigs);
    }

    function test_replayRejectsMovesAfterGameEnd() public {
        uint256 id = _disputedMatch();
        uint8[] memory cells = _p1Win();
        uint8[] memory tooLong = new uint8[](6);
        for (uint256 i = 0; i < 5; i++) tooLong[i] = cells[i];
        tooLong[5] = 5;
        bytes[] memory sigs = _signMoves(id, tooLong);
        vm.expectRevert(PotEscrow.BadReplay.selector);
        escrow.submitReplay(id, tooLong, sigs);
    }

    function test_replayOutsideWindowOrStatusRejected() public {
        uint256 id = _disputedMatch();
        uint8[] memory cells = _p1Win();
        bytes[] memory sigs = _signMoves(id, cells);
        vm.warp(block.timestamp + WINDOW);
        vm.expectRevert(PotEscrow.TooLate.selector);
        escrow.submitReplay(id, cells, sigs);

        uint256 fresh = _newMatch();
        bytes[] memory freshSigs = _signMoves(fresh, cells);
        vm.expectRevert(PotEscrow.WrongStatus.selector);
        escrow.submitReplay(fresh, cells, freshSigs);
    }

    function test_fabricatedSignaturesRejected() public {
        uint256 id = _newMatch();
        bytes32 fh = _finalHash(id, _p1Win());
        bytes32 d = escrow.resultDigest(id, 1, fh);
        // Referee signature made by a different key.
        bytes memory fakeRef = _sig(0xBAD, d);
        vm.expectRevert(PotEscrow.BadSignature.selector);
        escrow.settle(id, 1, fh, _sig(PK_K1, d), "", fakeRef);

        // Signature over a different result does not verify for the claimed one.
        bytes32 other = escrow.resultDigest(id, 2, fh);
        vm.expectRevert(PotEscrow.BadSignature.selector);
        escrow.settle(id, 1, fh, _sig(PK_K1, other), "", _sig(PK_REF, d));

        // Malformed signature length.
        vm.expectRevert(PotEscrow.BadSignature.selector);
        escrow.settle(id, 1, fh, hex"1234", "", _sig(PK_REF, d));
    }

    // ----------------------------------------------------------------- abort

    function test_abortRefundsAfterDeadline() public {
        uint256 id = _newMatch();
        vm.expectRevert(PotEscrow.TooEarly.selector);
        escrow.abort(id);

        vm.warp(block.timestamp + DURATION + GRACE + 1);
        escrow.abort(id);
        assertEq(_claim(p1), STAKE);
        assertEq(_claim(p2), STAKE);
        assertEq(token.balanceOf(address(escrow)), 0);

        vm.expectRevert(PotEscrow.WrongStatus.selector);
        escrow.abort(id);
    }

    function test_cannotAbortOnceProposed() public {
        uint256 id = _newMatch();
        bytes32 fh = _finalHash(id, _p1Win());
        (bytes memory s1,, bytes memory sr) = _resultSigs(id, 1, fh);
        escrow.settle(id, 1, fh, s1, "", sr);
        vm.warp(block.timestamp + DURATION + GRACE + 1);
        vm.expectRevert(PotEscrow.WrongStatus.selector);
        escrow.abort(id);
    }

    // --------------------------------------------------- offers, pause, rake

    function test_cancelOfferRefundsCreator() public {
        vm.prank(p1);
        uint256 id = escrow.createOffer(STAKE, uint64(block.timestamp + 1 days), k1);
        vm.prank(p2);
        vm.expectRevert(PotEscrow.NotPlayer.selector);
        escrow.cancelOffer(id);
        vm.prank(p1);
        escrow.cancelOffer(id);
        assertEq(_claim(p1), STAKE);
        vm.prank(p2);
        vm.expectRevert(PotEscrow.WrongStatus.selector);
        escrow.challenge(id, k2);
    }

    function test_expiredOfferCannotBeChallenged() public {
        vm.prank(p1);
        uint256 id = escrow.createOffer(STAKE, uint64(block.timestamp + 1 hours), k1);
        vm.warp(block.timestamp + 1 hours + 1);
        vm.prank(p2);
        vm.expectRevert(PotEscrow.TooLate.selector);
        escrow.challenge(id, k2);
    }

    function test_challengeValidation() public {
        vm.prank(p1);
        uint256 id = escrow.createOffer(STAKE, uint64(block.timestamp + 1 days), k1);
        vm.prank(p1);
        vm.expectRevert(PotEscrow.BadParam.selector);
        escrow.challenge(id, k2);
        vm.prank(p2);
        vm.expectRevert(PotEscrow.BadParam.selector);
        escrow.challenge(id, k1);
        vm.prank(p2);
        vm.expectRevert(PotEscrow.BadParam.selector);
        escrow.challenge(id, address(0));
    }

    function test_pauseBlocksOnlyNewOffersAndChallenges() public {
        uint256 live = _newMatch();
        vm.prank(p1);
        uint256 open = escrow.createOffer(STAKE, uint64(block.timestamp + 1 days), k1);

        escrow.setPaused(true);

        vm.prank(p1);
        vm.expectRevert(PotEscrow.PausedErr.selector);
        escrow.createOffer(STAKE, uint64(block.timestamp + 1 days), k1);
        vm.prank(p2);
        vm.expectRevert(PotEscrow.PausedErr.selector);
        escrow.challenge(open, k2);

        // Everything that releases funds still works.
        vm.prank(p1);
        escrow.cancelOffer(open);
        bytes32 fh = _finalHash(live, _p1Win());
        (bytes memory s1, bytes memory s2, bytes memory sr) = _resultSigs(live, 1, fh);
        escrow.settle(live, 1, fh, s1, s2, sr);
        assertGt(_claim(p1), STAKE);

        uint256 stuck = 0;
        escrow.setPaused(false);
        stuck = _newMatch();
        escrow.setPaused(true);
        vm.warp(block.timestamp + DURATION + GRACE + 1);
        escrow.abort(stuck);
    }

    function test_onlyOwnerAdmin() public {
        vm.prank(p1);
        vm.expectRevert(PotEscrow.NotOwner.selector);
        escrow.setPaused(true);
        vm.prank(p1);
        vm.expectRevert(PotEscrow.NotOwner.selector);
        escrow.setReferee(p1);
    }

    function test_refereeChangeDoesNotAffectLiveMatches() public {
        uint256 id = _newMatch();
        escrow.setReferee(address(0x1234));
        bytes32 fh = _finalHash(id, _p1Win());
        (bytes memory s1, bytes memory s2, bytes memory sr) = _resultSigs(id, 1, fh);
        escrow.settle(id, 1, fh, s1, s2, sr);
        assertGt(escrow.claimable(p1), 0);
    }

    function test_rakeCapEnforcedAtDeploy() public {
        vm.expectRevert(PotEscrow.BadParam.selector);
        new PotEscrow(address(token), ref, treasury, 1001, WINDOW, DURATION, GRACE, BOND);
    }

    function test_claimTwiceFails() public {
        uint256 id = _newMatch();
        bytes32 fh = _finalHash(id, _p1Win());
        (bytes memory s1, bytes memory s2, bytes memory sr) = _resultSigs(id, 1, fh);
        escrow.settle(id, 1, fh, s1, s2, sr);
        _claim(p1);
        vm.prank(p1);
        vm.expectRevert(PotEscrow.BadParam.selector);
        escrow.claim();
    }

    function test_cannotSettleTwice() public {
        uint256 id = _newMatch();
        bytes32 fh = _finalHash(id, _p1Win());
        (bytes memory s1, bytes memory s2, bytes memory sr) = _resultSigs(id, 1, fh);
        escrow.settle(id, 1, fh, s1, s2, sr);
        vm.expectRevert(PotEscrow.WrongStatus.selector);
        escrow.settle(id, 1, fh, s1, s2, sr);
    }
}
