// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {PotEscrow} from "../src/PotEscrow.sol";
import {TestToken} from "../src/TestToken.sol";

contract Handler is Test {
    PotEscrow public escrow;
    TestToken public token;

    uint256 constant PK_K1 = 0xC1;
    uint256 constant PK_K2 = 0xC2;
    uint256 constant PK_REF = 0xDEF;
    address public treasury = address(0x7EA5);
    address[3] public actors = [address(0xA1), address(0xA2), address(0xA3)];

    uint256 public ghostDeposited;
    uint256 public ghostClaimed;
    uint256[8] public hits; // 0 challenge,1 settle,2 finalize,3 dispute,4 replay,5 finalizeDispute,6 abort,7 claim

    constructor(PotEscrow e, TestToken t) {
        escrow = e;
        token = t;
        for (uint256 i = 0; i < 3; i++) {
            t.mint(actors[i], 1_000_000e6);
            vm.prank(actors[i]);
            t.approve(address(e), type(uint256).max);
        }
    }

    function _actor(uint256 s) internal view returns (address) {
        return actors[s % 3];
    }

    function _id(uint256 s) internal view returns (uint256) {
        uint256 n = escrow.nextId() - 1;
        return n == 0 ? 0 : (s % n) + 1;
    }

    function create(uint256 a, uint256 stake) external {
        stake = bound(stake, 1, 1000e6);
        address who = _actor(a);
        vm.prank(who);
        try escrow.createOffer(stake, uint64(block.timestamp + 1 days), vm.addr(PK_K1)) {
            ghostDeposited += stake;
        } catch {}
    }

    function cancel(uint256 s) external {
        uint256 id = _id(s);
        (address creator,,,,) = escrow.offers(id);
        vm.prank(creator);
        try escrow.cancelOffer(id) {} catch {}
    }

    function challenge(uint256 s, uint256 a) external {
        uint256 id = _id(s);
        (,, uint256 stake,,) = escrow.offers(id);
        vm.prank(_actor(a));
        try escrow.challenge(id, vm.addr(PK_K2)) {
            ghostDeposited += stake;
            hits[0]++;
        } catch {}
    }

    function _sigs(uint256 id, uint8 result, bytes32 fh) internal view returns (bytes memory s1, bytes memory s2, bytes memory sr) {
        bytes32 d = escrow.resultDigest(id, result, fh);
        (uint8 v, bytes32 r, bytes32 ss) = vm.sign(PK_K1, d);
        s1 = abi.encodePacked(r, ss, v);
        (v, r, ss) = vm.sign(PK_K2, d);
        s2 = abi.encodePacked(r, ss, v);
        (v, r, ss) = vm.sign(PK_REF, d);
        sr = abi.encodePacked(r, ss, v);
    }

    function settle(uint256 s, uint8 result, uint8 mask) external {
        uint256 id = _id(s);
        result = uint8(bound(result, 1, 3));
        bytes32 fh = keccak256(abi.encode(id, result));
        (bytes memory s1, bytes memory s2, bytes memory sr) = _sigs(id, result, fh);
        if (mask & 1 == 0) s1 = "";
        if (mask & 2 == 0) s2 = "";
        if (mask & 4 == 0) sr = "";
        try escrow.settle(id, result, fh, s1, s2, sr) { hits[1]++; } catch {}
    }

    function finalize(uint256 s) external {
        try escrow.finalize(_id(s)) { hits[2]++; } catch {}
    }

    function dispute(uint256 s, uint256 a) external {
        uint256 id = _id(s);
        PotEscrow.Match memory m = escrow.getMatch(id);
        address who = a % 2 == 0 ? m.p1 : m.p2;
        vm.prank(who);
        try escrow.dispute(id) {
            ghostDeposited += escrow.disputeBond();
            hits[3]++;
        } catch {}
    }

    function replay(uint256 s, uint8 which) external {
        uint256 id = _id(s);
        uint8[] memory cells;
        if (which % 3 == 0) {
            cells = new uint8[](5);
            cells[0] = 0; cells[1] = 3; cells[2] = 1; cells[3] = 4; cells[4] = 2;
        } else if (which % 3 == 1) {
            cells = new uint8[](6);
            cells[0] = 0; cells[1] = 3; cells[2] = 1; cells[3] = 4; cells[4] = 8; cells[5] = 5;
        } else {
            cells = new uint8[](9);
            cells[0] = 0; cells[1] = 1; cells[2] = 2; cells[3] = 4; cells[4] = 3; cells[5] = 5; cells[6] = 7; cells[7] = 6; cells[8] = 8;
        }
        bytes[] memory sigs = new bytes[](cells.length);
        bytes32 h = escrow.genesisHash(id);
        for (uint256 i = 0; i < cells.length; i++) {
            (uint8 v, bytes32 r, bytes32 ss) = vm.sign(i % 2 == 0 ? PK_K1 : PK_K2, escrow.moveDigest(id, uint8(i), cells[i], h));
            sigs[i] = abi.encodePacked(r, ss, v);
            h = escrow.chainHash(h, cells[i]);
        }
        try escrow.submitReplay(id, cells, sigs) { hits[4]++; } catch {}
    }

    function finalizeDispute(uint256 s) external {
        try escrow.finalizeDispute(_id(s)) { hits[5]++; } catch {}
    }

    function abort(uint256 s) external {
        try escrow.abort(_id(s)) { hits[6]++; } catch {}
    }

    function claim(uint256 a) external {
        address who = a % 4 == 3 ? treasury : _actor(a);
        uint256 before = token.balanceOf(who);
        vm.prank(who);
        try escrow.claim() {
            ghostClaimed += token.balanceOf(who) - before;
            hits[7]++;
        } catch {}
    }


    /// Drives one fresh match down a random path so deep states are reached often.
    function lifecycle(uint256 seed, uint256 stake) external {
        stake = bound(stake, 1, 1000e6);
        address a = _actor(seed);
        address b = _actor(seed + 1);
        vm.prank(a);
        uint256 id = escrow.createOffer(stake, uint64(block.timestamp + 1 days), vm.addr(PK_K1));
        ghostDeposited += stake;
        vm.prank(b);
        escrow.challenge(id, vm.addr(PK_K2));
        ghostDeposited += stake;
        hits[0]++;

        uint256 path = (seed >> 8) % 6;
        uint8 result = uint8(((seed >> 16) % 3) + 1);
        bytes32 fh = keccak256(abi.encode(id, result));
        (bytes memory s1, bytes memory s2, bytes memory sr) = _sigs(id, result, fh);

        if (path == 0) {
            escrow.settle(id, result, fh, s1, s2, sr);
            hits[1]++;
        } else if (path == 1) {
            escrow.settle(id, result, fh, s1, "", sr);
            vm.warp(block.timestamp + 30 minutes);
            escrow.finalize(id);
            hits[2]++;
        } else if (path == 2 || path == 3) {
            escrow.settle(id, result, fh, "", s2, sr);
            vm.prank(path == 2 ? a : b);
            escrow.dispute(id);
            ghostDeposited += escrow.disputeBond();
            hits[3]++;
            if (path == 3) {
                this.replay(id - 1, uint8(seed >> 24));
            }
            vm.warp(block.timestamp + 30 minutes);
            escrow.finalizeDispute(id);
            hits[5]++;
        } else if (path == 4) {
            vm.warp(block.timestamp + 1 hours + 10 minutes + 1);
            escrow.abort(id);
            hits[6]++;
        }
        // path 5 leaves the match Active.
    }

    function warp(uint256 secs) external {
        vm.warp(block.timestamp + bound(secs, 1, 2 hours));
    }

    // Sum of everything the escrow currently owes.
    function obligations() external view returns (uint256 sum) {
        uint256 n = escrow.nextId() - 1;
        uint256 bond = escrow.disputeBond();
        for (uint256 id = 1; id <= n; id++) {
            (,, uint256 offerStake,, bool open) = escrow.offers(id);
            if (open) sum += offerStake;
            PotEscrow.Match memory m = escrow.getMatch(id);
            if (m.status == PotEscrow.Status.Active || m.status == PotEscrow.Status.Proposed) sum += m.stake * 2;
            if (m.status == PotEscrow.Status.Disputed) sum += m.stake * 2 + bond;
        }
        sum += escrow.totalCredited();
    }

    function sumClaimable() external view returns (uint256 sum) {
        for (uint256 i = 0; i < 3; i++) sum += escrow.claimable(actors[i]);
        sum += escrow.claimable(treasury);
    }
}

contract InvariantTest is Test {
    TestToken token;
    PotEscrow escrow;
    Handler handler;

    function setUp() public {
        token = new TestToken();
        escrow = new PotEscrow(address(token), vm.addr(0xDEF), address(0x7EA5), 300, 30 minutes, 1 hours, 10 minutes, 5e6);
        handler = new Handler(escrow, token);
        targetContract(address(handler));
    }

    /// Escrow balance equals open offers + live matches + dispute bonds + unclaimed credits.
    function invariant_balanceEqualsObligations() public view {
        assertEq(token.balanceOf(address(escrow)), handler.obligations());
    }

    function invariant_creditsMatchClaimable() public view {
        assertEq(escrow.totalCredited(), handler.sumClaimable());
    }

    function invariant_noValueCreatedOrLost() public view {
        assertEq(handler.ghostDeposited() - handler.ghostClaimed(), token.balanceOf(address(escrow)));
    }
}
