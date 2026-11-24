// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IERC20Minimal {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address who) external view returns (uint256);
}

/// Escrow for 1v1 real-time Fight matches (testnet v0).
///
/// A real-time match cannot be replayed on-chain, so this contract does not try to judge it. The referee replays the recorded
/// match off-chain and signs a verdict; anyone can verify that record and replay. The chain enforces the money rules:
///  - settle() with the referee's signature opens a challenge window; finalize() pays after it. If player 1, player 2 and the
///    referee all sign the same result, it pays at once.
///  - dispute() inside the window freezes the funds and posts a bond. The arbiter (a trusted address for now, replaced by
///    fraud proofs or an attested referee before launch) calls resolve(). If the arbiter stays silent, timeoutDispute()
///    refunds both stakes and returns the bond.
///  - concede() lets a player forfeit at any time while the match is active.
///  - abort() refunds both stakes if nothing settled by the deadline.
/// Outcomes: 1 player 1 wins, 2 player 2 wins, 3 void (both stakes back, no rake).
/// Payouts are credited and pulled with claim(). No proxies. Pause only stops new offers and challenges.
contract FightEscrow {
    enum Status {
        None,
        Active,
        Proposed,
        Disputed,
        Settled
    }

    uint8 internal constant O_P1 = 1;
    uint8 internal constant O_P2 = 2;
    uint8 internal constant O_VOID = 3;

    uint16 public constant MAX_RAKE_BPS = 1000;

    bytes32 public constant RESULT_TYPEHASH =
        keccak256("FightResult(uint256 matchId,uint8 outcome,bytes32 record,uint8 p1Score,uint8 p2Score)");
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    uint256 private constant HALF_N = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    struct Config {
        address token;
        address referee;
        address arbiter;
        address treasury;
        uint16 rakeBps;
        uint64 challengeWindow; // how long the loser has to dispute a proposed result
        uint64 matchDuration; // the longest a match may run before abort() becomes possible (with abortGrace)
        uint64 abortGrace;
        uint64 arbiterWindow; // how long the arbiter has to rule on a dispute
        uint256 disputeBond;
        uint256 minStake;
        uint256 maxStake;
    }

    /// What the referee signs about a finished match.
    struct Verdict {
        uint8 outcome; // 1 player 1 wins, 2 player 2 wins, 3 void
        bytes32 record; // head hash of the referee's signed match record
        uint8 p1Score;
        uint8 p2Score;
    }

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
        address key1; // each player's per-match key: it signs the player's join to the relay and, optionally, a result
        address key2;
        address referee;
        address arbiter;
        uint256 stake;
        uint16 rakeBps;
        Status status;
        uint64 deadline;
        uint64 windowEnd; // end of the challenge window while Proposed, the arbiter's deadline while Disputed
        uint8 outcome; // the proposed outcome
        bytes32 record; // head hash of the referee's signed match record
        uint8 p1Score;
        uint8 p2Score;
        address disputer;
        uint256 bond;
    }

    IERC20Minimal public immutable token;
    address public immutable treasury;
    uint16 public immutable rakeBps;
    uint64 public immutable challengeWindow;
    uint64 public immutable matchDuration;
    uint64 public immutable abortGrace;
    uint64 public immutable arbiterWindow;
    uint256 public immutable disputeBond;
    uint256 public immutable minStake;
    uint256 public immutable maxStake;
    bytes32 public immutable domainSeparator;

    address public owner;
    address public referee;
    address public arbiter;
    bool public paused;
    uint256 public nextId = 1;
    uint256 public totalCredited;

    mapping(uint256 => Offer) public offers;
    mapping(uint256 => Match) internal _matches;
    mapping(address => uint256) public claimable;

    event OfferCreated(uint256 indexed id, address indexed creator, uint256 stake, uint64 expiry, address sessionKey);
    event OfferCancelled(uint256 indexed id);
    event Challenged(uint256 indexed id, address indexed p1, address indexed p2, address key1, address key2, uint256 stake, address referee);
    event Proposed(uint256 indexed id, uint8 outcome, bytes32 record, uint8 p1Score, uint8 p2Score, uint64 windowEnd);
    event Disputed(uint256 indexed id, address indexed disputer, uint64 arbiterEnd);
    event Conceded(uint256 indexed id, address indexed loser);
    event Settled(uint256 indexed id, uint8 outcome);
    event Aborted(uint256 indexed id);
    event Claimed(address indexed who, uint256 amount);

    error NotOwner();
    error PausedErr();
    error BadParam();
    error WrongStatus();
    error TooEarly();
    error TooLate();
    error NotPlayer();
    error NotArbiter();
    error BadSignature();
    error NotReferee();
    error TransferFailed();

    constructor(Config memory c) {
        if (
            c.rakeBps > MAX_RAKE_BPS || c.token == address(0) || c.treasury == address(0) || c.referee == address(0)
                || c.arbiter == address(0)
        ) revert BadParam();
        if (c.challengeWindow == 0 || c.matchDuration == 0 || c.arbiterWindow == 0) revert BadParam();
        if (c.minStake == 0 || c.maxStake < c.minStake) revert BadParam();
        token = IERC20Minimal(c.token);
        referee = c.referee;
        arbiter = c.arbiter;
        treasury = c.treasury;
        rakeBps = c.rakeBps;
        challengeWindow = c.challengeWindow;
        matchDuration = c.matchDuration;
        abortGrace = c.abortGrace;
        arbiterWindow = c.arbiterWindow;
        disputeBond = c.disputeBond;
        minStake = c.minStake;
        maxStake = c.maxStake;
        owner = msg.sender;
        domainSeparator = keccak256(
            abi.encode(DOMAIN_TYPEHASH, keccak256("PlayPotFight"), keccak256("1"), block.chainid, address(this))
        );
    }

    // ---------------------------------------------------------------- admin

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// Pausing stops new offers and challenges only. Everything that settles or refunds keeps working.
    function setPaused(bool p) external onlyOwner {
        paused = p;
    }

    /// Applies to matches challenged after the change; live matches keep the referee they started with.
    function setReferee(address r) external onlyOwner {
        if (r == address(0)) revert BadParam();
        referee = r;
    }

    /// Same for the arbiter.
    function setArbiter(address a) external onlyOwner {
        if (a == address(0)) revert BadParam();
        arbiter = a;
    }

    function transferOwnership(address o) external onlyOwner {
        owner = o;
    }

    // --------------------------------------------------------------- offers

    function createOffer(uint256 stake, uint64 expiry, address sessionKey) external returns (uint256 id) {
        if (paused) revert PausedErr();
        if (stake < minStake || stake > maxStake || sessionKey == address(0) || expiry <= block.timestamp) revert BadParam();
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
        m.arbiter = arbiter;
        m.stake = o.stake;
        m.rakeBps = rakeBps;
        m.status = Status.Active;
        m.deadline = uint64(block.timestamp) + matchDuration + abortGrace;

        _pull(msg.sender, o.stake);
        emit Challenged(id, m.p1, m.p2, m.key1, m.key2, m.stake, m.referee);
    }

    // ----------------------------------------------------------- settlement

    /// The referee's signature is required. Empty signature bytes mean "absent"; any non-empty signature must be valid.
    /// All three signatures: paid at once. Referee only (or with one player): a proposal that opens the challenge window.
    function settle(uint256 id, Verdict calldata v, bytes calldata sig1, bytes calldata sig2, bytes calldata sigRef) external {
        Match storage m = _matches[id];
        if (m.status != Status.Active && m.status != Status.Proposed) revert WrongStatus();
        if (v.outcome < O_P1 || v.outcome > O_VOID) revert BadParam();

        bytes32 digest = resultDigest(id, v.outcome, v.record, v.p1Score, v.p2Score);
        bool ok1 = _check(digest, sig1, m.key1);
        bool ok2 = _check(digest, sig2, m.key2);
        if (!_check(digest, sigRef, m.referee)) revert NotReferee();

        if (ok1 && ok2) {
            _finish(id, m, v.outcome);
            return;
        }
        if (m.status != Status.Active) revert WrongStatus();

        m.status = Status.Proposed;
        m.outcome = v.outcome;
        m.record = v.record;
        m.p1Score = v.p1Score;
        m.p2Score = v.p2Score;
        m.windowEnd = uint64(block.timestamp) + challengeWindow;
        emit Proposed(id, v.outcome, v.record, v.p1Score, v.p2Score, m.windowEnd);
    }

    function finalize(uint256 id) external {
        Match storage m = _matches[id];
        if (m.status != Status.Proposed) revert WrongStatus();
        if (block.timestamp < m.windowEnd) revert TooEarly();
        _finish(id, m, m.outcome);
    }

    /// A player who believes the proposed result is wrong freezes the funds and posts the bond. The arbiter then rules.
    function dispute(uint256 id) external {
        Match storage m = _matches[id];
        if (m.status != Status.Proposed) revert WrongStatus();
        if (block.timestamp >= m.windowEnd) revert TooLate();
        if (msg.sender != m.p1 && msg.sender != m.p2) revert NotPlayer();
        m.status = Status.Disputed;
        m.disputer = msg.sender;
        m.bond = disputeBond;
        m.windowEnd = uint64(block.timestamp) + arbiterWindow;
        if (disputeBond > 0) _pull(msg.sender, disputeBond);
        emit Disputed(id, msg.sender, m.windowEnd);
    }

    /// The arbiter's ruling. If it matches the disputed proposal the disputer loses the bond to the other player; otherwise
    /// the bond is returned.
    function resolve(uint256 id, uint8 outcome) external {
        Match storage m = _matches[id];
        if (m.status != Status.Disputed) revert WrongStatus();
        if (msg.sender != m.arbiter) revert NotArbiter();
        if (block.timestamp >= m.windowEnd) revert TooLate();
        if (outcome < O_P1 || outcome > O_VOID) revert BadParam();
        uint256 bond = m.bond;
        address disputer = m.disputer;
        bool disputerWrong = outcome == m.outcome;
        _finish(id, m, outcome);
        if (bond > 0) _credit(disputerWrong ? (disputer == m.p1 ? m.p2 : m.p1) : disputer, bond);
    }

    /// The arbiter did not rule in time: both stakes back, the bond back, no rake.
    function timeoutDispute(uint256 id) external {
        Match storage m = _matches[id];
        if (m.status != Status.Disputed) revert WrongStatus();
        if (block.timestamp < m.windowEnd) revert TooEarly();
        m.status = Status.Settled;
        _credit(m.p1, m.stake);
        _credit(m.p2, m.stake);
        if (m.bond > 0) _credit(m.disputer, m.bond);
        emit Aborted(id);
    }

    /// A player gives up: the other wins, with the normal rake. Only while the match is active (no result proposed yet).
    function concede(uint256 id) external {
        Match storage m = _matches[id];
        if (m.status != Status.Active) revert WrongStatus();
        if (msg.sender != m.p1 && msg.sender != m.p2) revert NotPlayer();
        emit Conceded(id, msg.sender);
        _finish(id, m, msg.sender == m.p1 ? O_P2 : O_P1);
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

    function resultDigest(uint256 id, uint8 outcome, bytes32 record, uint8 p1Score, uint8 p2Score) public view returns (bytes32) {
        return keccak256(
            abi.encodePacked(
                "\x19\x01", domainSeparator, keccak256(abi.encode(RESULT_TYPEHASH, id, outcome, record, p1Score, p2Score))
            )
        );
    }

    // ------------------------------------------------------------- internals

    function _finish(uint256 id, Match storage m, uint8 outcome) internal {
        m.status = Status.Settled;
        uint256 stake = m.stake;
        if (outcome == O_VOID) {
            _credit(m.p1, stake);
            _credit(m.p2, stake);
        } else {
            uint256 pot = stake * 2;
            uint256 rake = (pot * m.rakeBps) / 10_000;
            _credit(outcome == O_P1 ? m.p1 : m.p2, pot - rake);
            if (rake > 0) _credit(treasury, rake);
        }
        emit Settled(id, outcome);
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
