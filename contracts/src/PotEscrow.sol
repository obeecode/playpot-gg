// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {TicTacToe} from "./TicTacToe.sol";

interface IERC20Minimal {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address who) external view returns (uint256);
}

/// Escrow for 1v1 tic-tac-toe pots (testnet v0).
///
/// Settlement paths:
///  - settle() with player 1, player 2 and referee signatures over the same result: instant payout.
///  - settle() with the referee plus at least one player: opens a challenge window; finalize() pays after it.
///  - dispute() inside the window freezes funds; anyone replays the players' own signed moves with
///    submitReplay(); the longest valid terminal log decides; no log means refund.
///  - abort() refunds both stakes if nothing settled by the deadline.
/// Payouts are credited and pulled with claim(). No proxies. Pause only affects new offers and challenges.
contract PotEscrow {
    enum Status {
        None,
        Active,
        Proposed,
        Disputed,
        Settled
    }

    // results: 0 none, 1 player1 wins, 2 player2 wins, 3 draw
    uint8 internal constant R_P1 = 1;
    uint8 internal constant R_P2 = 2;
    uint8 internal constant R_DRAW = 3;

    uint16 public constant MAX_RAKE_BPS = 1000;

    bytes32 public constant MOVE_TYPEHASH = keccak256("Move(uint256 matchId,uint8 index,uint8 cell,bytes32 prevHash)");
    bytes32 public constant RESULT_TYPEHASH = keccak256("Result(uint256 matchId,uint8 result,bytes32 finalHash)");
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    uint256 private constant HALF_N = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    struct Offer {
        address creator;
        address sessionKey;
        uint256 stake;
        uint64 expiry;
        bool open;
    }

    struct Match {
        address p1;
        address p2;
        address key1;
        address key2;
        address referee;
        uint256 stake;
        uint16 rakeBps;
        Status status;
        uint64 deadline;
        uint64 windowEnd;
        uint8 proposedResult;
        bytes32 proposedHash;
        address disputer;
        uint256 bond;
        uint8 bestResult;
        uint8 bestLen;
    }

    IERC20Minimal public immutable token;
    address public immutable treasury;
    uint16 public immutable rakeBps;
    uint64 public immutable challengeWindow;
    uint64 public immutable matchDuration;
    uint64 public immutable abortGrace;
    uint256 public immutable disputeBond;
    bytes32 public immutable domainSeparator;

    address public owner;
    address public referee;
    bool public paused;
    uint256 public nextId = 1;
    uint256 public totalCredited;

    mapping(uint256 => Offer) public offers;
    mapping(uint256 => Match) internal _matches;
    mapping(address => uint256) public claimable;

    event OfferCreated(uint256 indexed id, address indexed creator, uint256 stake, uint64 expiry, address sessionKey);
    event OfferCancelled(uint256 indexed id);
    event Challenged(uint256 indexed id, address indexed p1, address indexed p2, address key1, address key2, uint256 stake, address referee);
    event Proposed(uint256 indexed id, uint8 result, bytes32 finalHash, uint64 windowEnd);
    event Disputed(uint256 indexed id, address indexed disputer, uint64 replayEnd);
    event ReplaySubmitted(uint256 indexed id, uint8 result, uint8 length);
    event Settled(uint256 indexed id, uint8 result);
    event Aborted(uint256 indexed id);
    event Claimed(address indexed who, uint256 amount);

    error NotOwner();
    error PausedErr();
    error BadParam();
    error WrongStatus();
    error TooEarly();
    error TooLate();
    error NotPlayer();
    error BadSignature();
    error NotEnoughSignatures();
    error BadReplay();
    error TransferFailed();

    constructor(
        address _token,
        address _referee,
        address _treasury,
        uint16 _rakeBps,
        uint64 _challengeWindow,
        uint64 _matchDuration,
        uint64 _abortGrace,
        uint256 _disputeBond
    ) {
        if (_rakeBps > MAX_RAKE_BPS || _token == address(0) || _treasury == address(0) || _referee == address(0)) {
            revert BadParam();
        }
        if (_challengeWindow == 0 || _matchDuration == 0) revert BadParam();
        token = IERC20Minimal(_token);
        referee = _referee;
        treasury = _treasury;
        rakeBps = _rakeBps;
        challengeWindow = _challengeWindow;
        matchDuration = _matchDuration;
        abortGrace = _abortGrace;
        disputeBond = _disputeBond;
        owner = msg.sender;
        domainSeparator = keccak256(
            abi.encode(DOMAIN_TYPEHASH, keccak256("PlayPotEscrow"), keccak256("1"), block.chainid, address(this))
        );
    }

    // ---------------------------------------------------------------- admin

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// Pausing stops new offers and challenges only. Cancel, settle, dispute, abort and claim keep working.
    function setPaused(bool p) external onlyOwner {
        paused = p;
    }

    /// Applies to matches challenged after the change; live matches keep the referee they started with.
    function setReferee(address r) external onlyOwner {
        if (r == address(0)) revert BadParam();
        referee = r;
    }

    function transferOwnership(address o) external onlyOwner {
        owner = o;
    }

    // --------------------------------------------------------------- offers

    function createOffer(uint256 stake, uint64 expiry, address sessionKey) external returns (uint256 id) {
        if (paused) revert PausedErr();
        if (stake == 0 || sessionKey == address(0) || expiry <= block.timestamp) revert BadParam();
        id = nextId++;
        offers[id] = Offer(msg.sender, sessionKey, stake, expiry, true);
        _pull(msg.sender, stake);
        emit OfferCreated(id, msg.sender, stake, expiry, sessionKey);
    }

    function cancelOffer(uint256 id) external {
        Offer storage o = offers[id];
        if (!o.open) revert WrongStatus();
        if (o.creator != msg.sender) revert NotPlayer();
        o.open = false;
        _credit(o.creator, o.stake);
        emit OfferCancelled(id);
    }

    /// One atomic call: pulls the challenger's matching stake and starts the match.
    function challenge(uint256 id, address sessionKey) external {
        if (paused) revert PausedErr();
        Offer storage o = offers[id];
        if (!o.open) revert WrongStatus();
        if (block.timestamp > o.expiry) revert TooLate();
        if (msg.sender == o.creator || sessionKey == address(0) || sessionKey == o.sessionKey) revert BadParam();
        o.open = false;

        Match storage m = _matches[id];
        m.p1 = o.creator;
        m.p2 = msg.sender;
        m.key1 = o.sessionKey;
        m.key2 = sessionKey;
        m.referee = referee;
        m.stake = o.stake;
        m.rakeBps = rakeBps;
        m.status = Status.Active;
        m.deadline = uint64(block.timestamp) + matchDuration + abortGrace;

        _pull(msg.sender, o.stake);
        emit Challenged(id, m.p1, m.p2, m.key1, m.key2, m.stake, m.referee);
    }

    // ----------------------------------------------------------- settlement

    /// Empty signature bytes mean "absent". Any non-empty signature must be valid.
    function settle(uint256 id, uint8 result, bytes32 finalHash, bytes calldata sig1, bytes calldata sig2, bytes calldata sigRef)
        external
    {
        Match storage m = _matches[id];
        if (m.status != Status.Active && m.status != Status.Proposed) revert WrongStatus();
        if (result < R_P1 || result > R_DRAW) revert BadParam();

        bytes32 digest = resultDigest(id, result, finalHash);
        bool ok1 = _check(digest, sig1, m.key1);
        bool ok2 = _check(digest, sig2, m.key2);
        bool okR = _check(digest, sigRef, m.referee);

        if (ok1 && ok2 && okR) {
            _finish(id, m, result);
            return;
        }
        if (m.status != Status.Active) revert WrongStatus();
        if (!okR || !(ok1 || ok2)) revert NotEnoughSignatures();

        m.status = Status.Proposed;
        m.proposedResult = result;
        m.proposedHash = finalHash;
        m.windowEnd = uint64(block.timestamp) + challengeWindow;
        emit Proposed(id, result, finalHash, m.windowEnd);
    }

    function finalize(uint256 id) external {
        Match storage m = _matches[id];
        if (m.status != Status.Proposed) revert WrongStatus();
        if (block.timestamp < m.windowEnd) revert TooEarly();
        _finish(id, m, m.proposedResult);
    }

    function dispute(uint256 id) external {
        Match storage m = _matches[id];
        if (m.status != Status.Proposed) revert WrongStatus();
        if (block.timestamp >= m.windowEnd) revert TooLate();
        if (msg.sender != m.p1 && msg.sender != m.p2) revert NotPlayer();
        m.status = Status.Disputed;
        m.disputer = msg.sender;
        m.bond = disputeBond;
        m.windowEnd = uint64(block.timestamp) + challengeWindow;
        if (disputeBond > 0) _pull(msg.sender, disputeBond);
        emit Disputed(id, msg.sender, m.windowEnd);
    }

    /// Anyone may submit. `cells[i]` is move i, signed by the mover's session key over (id, i, cell, prevHash).
    /// The log must end in a win or a draw. The longest valid log seen during the window wins.
    function submitReplay(uint256 id, uint8[] calldata cells, bytes[] calldata sigs) external {
        Match storage m = _matches[id];
        if (m.status != Status.Disputed) revert WrongStatus();
        if (block.timestamp >= m.windowEnd) revert TooLate();
        if (cells.length == 0 || cells.length > 9 || cells.length != sigs.length) revert BadReplay();

        bytes32 h = genesisHash(id);
        uint16 x;
        uint16 o;
        uint8 outcome;
        for (uint256 i = 0; i < cells.length; i++) {
            if (outcome != TicTacToe.ONGOING) revert BadReplay();
            address signer = _recover(moveDigest(id, uint8(i), cells[i], h), sigs[i]);
            if (signer != (i % 2 == 0 ? m.key1 : m.key2)) revert BadSignature();
            (x, o, outcome) = TicTacToe.step(x, o, uint8(i), cells[i]);
            h = chainHash(h, cells[i]);
        }
        if (outcome == TicTacToe.ONGOING) revert BadReplay();

        if (cells.length > m.bestLen) {
            m.bestLen = uint8(cells.length);
            m.bestResult = outcome;
        }
        emit ReplaySubmitted(id, outcome, uint8(cells.length));
    }

    function finalizeDispute(uint256 id) external {
        Match storage m = _matches[id];
        if (m.status != Status.Disputed) revert WrongStatus();
        if (block.timestamp < m.windowEnd) revert TooEarly();

        uint256 bond = m.bond;
        address disputer = m.disputer;
        if (m.bestLen == 0) {
            m.status = Status.Settled;
            _credit(m.p1, m.stake);
            _credit(m.p2, m.stake);
            if (bond > 0) _credit(disputer, bond);
            emit Aborted(id);
            return;
        }
        uint8 result = m.bestResult;
        bool disputerWrong = result == m.proposedResult;
        _finish(id, m, result);
        if (bond > 0) {
            address other = disputer == m.p1 ? m.p2 : m.p1;
            _credit(disputerWrong ? other : disputer, bond);
        }
    }

    /// Nothing settled by the deadline: anyone can refund both stakes. No rake.
    function abort(uint256 id) external {
        Match storage m = _matches[id];
        if (m.status != Status.Active) revert WrongStatus();
        if (block.timestamp <= m.deadline) revert TooEarly();
        m.status = Status.Settled;
        _credit(m.p1, m.stake);
        _credit(m.p2, m.stake);
        emit Aborted(id);
    }

    function claim() external returns (uint256 amount) {
        amount = claimable[msg.sender];
        if (amount == 0) revert BadParam();
        claimable[msg.sender] = 0;
        totalCredited -= amount;
        _push(msg.sender, amount);
        emit Claimed(msg.sender, amount);
    }

    // ---------------------------------------------------------------- views

    function getMatch(uint256 id) external view returns (Match memory) {
        return _matches[id];
    }

    function genesisHash(uint256 id) public pure returns (bytes32) {
        return keccak256(abi.encode("PLAYPOT_TTT_GENESIS", id));
    }

    function chainHash(bytes32 prev, uint8 cell) public pure returns (bytes32) {
        return keccak256(abi.encode(prev, cell));
    }

    function moveDigest(uint256 id, uint8 index, uint8 cell, bytes32 prevHash) public view returns (bytes32) {
        return keccak256(
            abi.encodePacked("\x19\x01", domainSeparator, keccak256(abi.encode(MOVE_TYPEHASH, id, index, cell, prevHash)))
        );
    }

    function resultDigest(uint256 id, uint8 result, bytes32 finalHash) public view returns (bytes32) {
        return keccak256(
            abi.encodePacked("\x19\x01", domainSeparator, keccak256(abi.encode(RESULT_TYPEHASH, id, result, finalHash)))
        );
    }

    // ------------------------------------------------------------- internals

    function _finish(uint256 id, Match storage m, uint8 result) internal {
        m.status = Status.Settled;
        uint256 stake = m.stake;
        if (result == R_DRAW) {
            _credit(m.p1, stake);
            _credit(m.p2, stake);
        } else {
            uint256 pot = stake * 2;
            uint256 rake = (pot * m.rakeBps) / 10_000;
            _credit(result == R_P1 ? m.p1 : m.p2, pot - rake);
            if (rake > 0) _credit(treasury, rake);
        }
        emit Settled(id, result);
    }

    function _check(bytes32 digest, bytes calldata sig, address expected) internal pure returns (bool) {
        if (sig.length == 0) return false;
        if (_recover(digest, sig) != expected) revert BadSignature();
        return true;
    }

    function _recover(bytes32 digest, bytes memory sig) internal pure returns (address signer) {
        if (sig.length != 65) revert BadSignature();
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := mload(add(sig, 0x20))
            s := mload(add(sig, 0x40))
            v := byte(0, mload(add(sig, 0x60)))
        }
        if (uint256(s) > HALF_N || (v != 27 && v != 28)) revert BadSignature();
        signer = ecrecover(digest, v, r, s);
        if (signer == address(0)) revert BadSignature();
    }

    function _credit(address to, uint256 amount) internal {
        claimable[to] += amount;
        totalCredited += amount;
    }

    function _pull(address from, uint256 amount) internal {
        (bool ok, bytes memory ret) =
            address(token).call(abi.encodeCall(IERC20Minimal.transferFrom, (from, address(this), amount)));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }

    function _push(address to, uint256 amount) internal {
        (bool ok, bytes memory ret) = address(token).call(abi.encodeCall(IERC20Minimal.transfer, (to, amount)));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }
}
