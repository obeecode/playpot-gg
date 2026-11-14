// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {JinxRules} from "./JinxRules.sol";

interface IERC20JinxV2 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// Escrow for 1v1 JINX matches (best of 3 or 5, one pot per match). Version 2. Testnet only until audited.
///
/// What v2 adds to JinxEscrow (v1), without touching the match, signing or dispute logic:
///  - a minimum stake and an owner-adjustable maximum stake (bounded by an immutable hard cap);
///  - a rake that falls in steps as the pot grows ("cliffs", fixed at deployment, never above MAX_RAKE_BPS);
///  - a bonded referee: it must post collateral to be assigned matches, and the collateral is slashed to the wronged
///    player when the referee provably contradicts itself (a miss it signed, voided by its own receipt).
///
///
/// Every turn, each player signs a commitment to their pick, the referee signs a receipt for it, and then the picks are
/// revealed together. A match settles like the tic-tac-toe escrow:
///  - settle() with both players and the referee signing the same result: instant payout.
///  - settle() with the referee plus one player: a challenge window, then finalize().
///  - dispute() freezes funds; anyone replays the signed turns with submitReplay(). The contract checks every player
///    signature, every referee receipt, and runs the JINX rules. The longest valid log wins; no log means refund.
///  - abort() refunds both stakes if nothing settled by the deadline.
/// The referee's clock is the one thing the chain cannot check: a missed pick is the referee's word. The one provable
/// fraud is a miss the referee itself contradicts with a signed receipt, which voidMiss() rejects.
/// Result codes: 1 player 1 wins the match, 2 player 2 wins, 3 refund both stakes (double forfeit or turn cap).
contract JinxEscrowV2 {
    enum Status {
        None,
        Active,
        Proposed,
        Disputed,
        Settled
    }

    uint8 internal constant R_P1 = 1;
    uint8 internal constant R_P2 = 2;
    uint8 internal constant R_REFUND = 3;

    uint16 public constant MAX_RAKE_BPS = 1000;
    uint256 public constant MAX_RAKE_TIERS = 8;
    uint64 public constant TURN_LIMIT_MS = 10_000;
    uint64 public constant GRACE_MS = 1_500; // network allowance on top of the clock
    uint256 public constant MAX_TURNS = 120;

    bytes32 public constant COMMIT_TYPEHASH =
        keccak256("Commit(uint256 matchId,uint16 turn,bytes32 commitment,bytes32 prevHash)");
    bytes32 public constant RECEIPT_TYPEHASH = keccak256(
        "Receipt(uint256 matchId,uint16 turn,uint8 side,bytes32 commitment,uint64 openedMs,uint64 recvMs)"
    );
    bytes32 public constant MISS_TYPEHASH = keccak256(
        "Miss(uint256 matchId,uint16 turn,uint8 side,uint8 kind,bytes32 commitment,uint64 openedMs,uint64 atMs)"
    );
    bytes32 public constant RESULT_TYPEHASH = keccak256("Result(uint256 matchId,uint8 result,bytes32 finalHash)");
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    uint256 private constant HALF_N = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    struct Offer {
        address creator;
        address sessionKey;
        uint256 stake;
        uint64 expiry;
        uint8 bestOf;
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
        uint8 bestOf;
        Status status;
        uint64 deadline;
        uint64 windowEnd;
        uint8 proposedResult;
        bytes32 proposedHash;
        address disputer;
        uint256 bond;
        uint8 bestResult;
        uint16 bestLen;
        uint256 bestMissMask;
    }

    /// One player's evidence for one turn: either a revealed pick or a referee-asserted miss.
    struct Side {
        bool missed;
        uint8 missKind; // 0: no commitment arrived in time, 1: committed but never revealed
        uint8 cell;
        bytes32 salt;
        bytes32 commitment; // only for missKind 1
        uint64 openedMs;
        uint64 recvMs; // receipt time (pick)
        uint64 atMs; // time the referee called the miss
        bytes commitSig; // the player's session key over Commit(...)
        bytes refSig; // the referee's receipt (pick) or miss signature
    }

    struct Turn {
        Side a;
        Side b;
    }

    struct Replay {
        bytes32 head;
        uint256 missMask;
        uint8 result;
        uint8 wins1;
        uint8 wins2;
        uint8 draws;
        uint8 target;
    }

    /// Everything fixed at deployment except the maximum stake, which the owner may move within the hard cap.
    struct Config {
        address token;
        address referee;
        address treasury;
        uint64 challengeWindow;
        uint64 matchDuration;
        uint64 abortGrace;
        uint256 disputeBond;
        uint256 minStake; // per player
        uint256 maxStake; // per player, the starting value
        uint256 hardMaxStake; // per player; maxStake can never be raised above this
        uint256 refereeBondFloor; // collateral the referee needs to be assigned any match
    }

    IERC20JinxV2 public immutable token;
    address public immutable treasury;
    uint64 public immutable challengeWindow;
    uint64 public immutable matchDuration;
    uint64 public immutable abortGrace;
    uint256 public immutable disputeBond;
    uint256 public immutable minStake;
    uint256 public immutable hardMaxStake;
    uint256 public immutable refereeBondFloor;
    bytes32 public immutable domainSeparator;

    address public owner;
    address public referee;
    bool public paused;
    uint256 public maxStake;
    uint256 public nextId = 1;
    uint256 public totalCredited;

    /// Rake tiers: a pot at or above rakeFloors[i] pays rakeTiers[i] basis points (the highest floor reached applies).
    uint256[] internal _rakeFloors;
    uint16[] internal _rakeTiers;

    mapping(address => uint256) public refereeBond; // collateral by referee address
    mapping(address => uint256) public refereeActive; // matches not yet settled, by referee
    mapping(address => bool) public refereeExiting; // a referee that is leaving takes no new matches
    mapping(uint256 => bool) public slashed; // a match slashes the referee at most once
    uint256 public totalRefereeBond;

    mapping(uint256 => Offer) public offers;
    mapping(uint256 => Match) internal _matches;
    mapping(address => uint256) public claimable;
    mapping(uint256 => mapping(uint256 => bool)) public voided; // match => turn*2+side-1 => miss voided by a receipt

    event OfferCreated(uint256 indexed id, address indexed creator, uint256 stake, uint64 expiry, address sessionKey, uint8 bestOf);
    event OfferCancelled(uint256 indexed id);
    event Challenged(uint256 indexed id, address indexed p1, address indexed p2, address key1, address key2, uint256 stake, uint8 bestOf, address referee);
    event Proposed(uint256 indexed id, uint8 result, bytes32 finalHash, uint64 windowEnd);
    event Disputed(uint256 indexed id, address indexed disputer, uint64 replayEnd);
    event ReplaySubmitted(uint256 indexed id, uint8 result, uint16 turns);
    event MissVoided(uint256 indexed id, uint16 turn, uint8 side);
    event Settled(uint256 indexed id, uint8 result);
    event Aborted(uint256 indexed id);
    event Claimed(address indexed who, uint256 amount);
    event MaxStakeSet(uint256 maxStake);
    event RefereeBondDeposited(address indexed referee, uint256 amount);
    event RefereeExitRequested(address indexed referee);
    event RefereeExitCancelled(address indexed referee);
    event RefereeBondWithdrawn(address indexed referee, uint256 amount);
    event RefereeSlashed(uint256 indexed id, address indexed referee, address indexed victim, uint256 amount);

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
    error MissIsVoided();
    error TransferFailed();
    error StakeTooLow();
    error StakeTooHigh();
    error RefereeUnavailable();
    error RefereeUnderBonded();
    error BondLocked();

    constructor(Config memory c, uint256[] memory floors, uint16[] memory bps) {
        if (c.token == address(0) || c.treasury == address(0) || c.referee == address(0)) revert BadParam();
        if (c.challengeWindow == 0 || c.matchDuration == 0) revert BadParam();
        if (c.minStake == 0 || c.maxStake < c.minStake || c.hardMaxStake < c.maxStake) revert BadParam();
        _checkTiers(floors, bps, c.minStake * 2);
        _rakeFloors = floors;
        _rakeTiers = bps;
        token = IERC20JinxV2(c.token);
        referee = c.referee;
        treasury = c.treasury;
        challengeWindow = c.challengeWindow;
        matchDuration = c.matchDuration;
        abortGrace = c.abortGrace;
        disputeBond = c.disputeBond;
        minStake = c.minStake;
        maxStake = c.maxStake;
        hardMaxStake = c.hardMaxStake;
        refereeBondFloor = c.refereeBondFloor;
        owner = msg.sender;
        domainSeparator = keccak256(
            abi.encode(DOMAIN_TYPEHASH, keccak256("PlayPotJinx"), keccak256("1"), block.chainid, address(this))
        );
    }

    /// Floors must start at or below the smallest possible pot and strictly rise; rates must never rise and never
    /// exceed MAX_RAKE_BPS.
    function _checkTiers(uint256[] memory floors, uint16[] memory tiers, uint256 minPot) private pure {
        uint256 n = floors.length;
        if (n == 0 || n > MAX_RAKE_TIERS || n != tiers.length || floors[0] > minPot) revert BadParam();
        for (uint256 i = 0; i < n; i++) {
            if (tiers[i] > MAX_RAKE_BPS) revert BadParam();
            if (i > 0 && (floors[i] <= floors[i - 1] || tiers[i] > tiers[i - 1])) revert BadParam();
        }
    }

    // ---------------------------------------------------------------- admin

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// Pausing stops new offers and challenges only. Everything that releases funds keeps working.
    function setPaused(bool p) external onlyOwner {
        paused = p;
    }

    /// Applies to matches challenged after the change.
    function setReferee(address r) external onlyOwner {
        if (r == address(0)) revert BadParam();
        referee = r;
    }

    function transferOwnership(address o) external onlyOwner {
        owner = o;
    }

    /// The stake cap is a launch safety knob. It applies to offers created and challenged after the change, never
    /// above the hard cap fixed at deployment.
    function setMaxStake(uint256 v) external onlyOwner {
        if (v < minStake || v > hardMaxStake) revert BadParam();
        maxStake = v;
        emit MaxStakeSet(v);
    }

    // ------------------------------------------------------- referee bond

    /// The rake rate for a pot, in basis points. The highest tier floor at or below the pot applies.
    function rakeBpsFor(uint256 pot) public view returns (uint16) {
        uint256 i = _rakeFloors.length;
        while (i > 1 && pot < _rakeFloors[i - 1]) i--;
        return _rakeTiers[i - 1];
    }

    function rakeTiers() external view returns (uint256[] memory floors, uint16[] memory bps) {
        return (_rakeFloors, _rakeTiers);
    }

    /// Anyone posting under their own address. The referee needs this collateral to be assigned matches.
    function depositRefereeBond(uint256 amount) external {
        if (amount == 0) revert BadParam();
        refereeBond[msg.sender] += amount;
        totalRefereeBond += amount;
        _pull(msg.sender, amount);
        emit RefereeBondDeposited(msg.sender, amount);
    }

    /// A referee that wants its collateral back stops taking new matches first.
    function requestBondExit() external {
        refereeExiting[msg.sender] = true;
        emit RefereeExitRequested(msg.sender);
    }

    function cancelBondExit() external {
        refereeExiting[msg.sender] = false;
        emit RefereeExitCancelled(msg.sender);
    }

    /// Only once none of its matches is still unsettled, so a slash can always be paid. Every unsettled match can be
    /// closed by anyone (abort, finalize, finalizeDispute), so this cannot be blocked forever.
    function withdrawBond(uint256 amount) external {
        if (amount == 0 || amount > refereeBond[msg.sender]) revert BadParam();
        if (refereeActive[msg.sender] != 0) revert BondLocked();
        if (msg.sender == referee && !refereeExiting[msg.sender]) revert BondLocked();
        refereeBond[msg.sender] -= amount;
        totalRefereeBond -= amount;
        _push(msg.sender, amount);
        emit RefereeBondWithdrawn(msg.sender, amount);
    }

    /// Only a miss the referee itself contradicts is slashable, and only once per match.
    function _slash(uint256 id, Match storage m, uint8 side) private {
        if (slashed[id]) return;
        slashed[id] = true;
        address ref = m.referee;
        uint256 bond = refereeBond[ref];
        uint256 amount = m.stake < bond ? m.stake : bond;
        if (amount == 0) return;
        refereeBond[ref] = bond - amount;
        totalRefereeBond -= amount;
        address victim = side == 1 ? m.p1 : m.p2;
        _credit(victim, amount);
        emit RefereeSlashed(id, ref, victim, amount);
    }

    // --------------------------------------------------------------- offers

    function createOffer(uint256 stake, uint64 expiry, address sessionKey, uint8 bestOf) external returns (uint256 id) {
        if (paused) revert PausedErr();
        if (sessionKey == address(0) || expiry <= block.timestamp) revert BadParam();
        if (stake < minStake) revert StakeTooLow();
        if (stake > maxStake) revert StakeTooHigh();
        if (bestOf != 3 && bestOf != 5) revert BadParam();
        id = nextId++;
        offers[id] = Offer(msg.sender, sessionKey, stake, expiry, bestOf, true);
        _pull(msg.sender, stake);
        emit OfferCreated(id, msg.sender, stake, expiry, sessionKey, bestOf);
    }

    function cancelOffer(uint256 id) external {
        Offer storage o = offers[id];
        if (!o.open) revert WrongStatus();
        if (o.creator != msg.sender) revert NotPlayer();
        o.open = false;
        _credit(o.creator, o.stake);
        emit OfferCancelled(id);
    }

    function challenge(uint256 id, address sessionKey) external {
        if (paused) revert PausedErr();
        Offer storage o = offers[id];
        if (!o.open) revert WrongStatus();
        if (block.timestamp > o.expiry) revert TooLate();
        if (msg.sender == o.creator || sessionKey == address(0) || sessionKey == o.sessionKey) revert BadParam();
        if (o.stake > maxStake) revert StakeTooHigh(); // a lowered cap also stops older, larger offers
        address ref = referee;
        if (refereeExiting[ref]) revert RefereeUnavailable();
        uint256 needed = o.stake > refereeBondFloor ? o.stake : refereeBondFloor;
        if (refereeBond[ref] < needed) revert RefereeUnderBonded();
        o.open = false;
        refereeActive[ref]++;

        Match storage m = _matches[id];
        m.p1 = o.creator;
        m.p2 = msg.sender;
        m.key1 = o.sessionKey;
        m.key2 = sessionKey;
        m.referee = ref;
        m.stake = o.stake;
        m.rakeBps = rakeBpsFor(o.stake * 2);
        m.bestOf = o.bestOf;
        m.status = Status.Active;
        m.deadline = uint64(block.timestamp) + matchDuration + abortGrace;

        _pull(msg.sender, o.stake);
        emit Challenged(id, m.p1, m.p2, m.key1, m.key2, m.stake, m.bestOf, m.referee);
    }

    // ----------------------------------------------------------- settlement

    /// Empty signature bytes mean "absent". Any non-empty signature must be valid.
    function settle(uint256 id, uint8 result, bytes32 finalHash, bytes calldata sig1, bytes calldata sig2, bytes calldata sigRef)
        external
    {
        Match storage m = _matches[id];
        if (m.status != Status.Active && m.status != Status.Proposed) revert WrongStatus();
        if (result < R_P1 || result > R_REFUND) revert BadParam();

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

    /// Anyone may submit the signed turns. The log must end with a decided match, a double forfeit or the turn cap.
    /// The longest valid log seen during the window wins.
    function submitReplay(uint256 id, Turn[] calldata turns) external {
        Match storage m = _matches[id];
        if (m.status != Status.Disputed) revert WrongStatus();
        if (block.timestamp >= m.windowEnd) revert TooLate();
        if (turns.length == 0 || turns.length > MAX_TURNS) revert BadReplay();

        Replay memory r = _replay(id, m, turns);
        if (turns.length > m.bestLen) {
            m.bestLen = uint16(turns.length);
            m.bestResult = r.result;
            m.bestMissMask = r.missMask;
        }
        emit ReplaySubmitted(id, r.result, uint16(turns.length));
    }

    /// Rejects a "no commitment arrived" miss that the referee itself contradicts with a signed, in-time receipt.
    function voidMiss(
        uint256 id,
        uint16 turn,
        uint8 side,
        bytes32 commitment,
        uint64 openedMs,
        uint64 recvMs,
        bytes calldata receiptSig
    ) external {
        Match storage m = _matches[id];
        if (m.status != Status.Disputed) revert WrongStatus();
        if (block.timestamp >= m.windowEnd) revert TooLate();
        if ((side != 1 && side != 2) || turn >= MAX_TURNS) revert BadParam();
        uint256 slot = uint256(turn) * 2 + side - 1;
        _checkReceipt(id, m.referee, slot, commitment, openedMs, recvMs, receiptSig);
        voided[id][slot] = true;
        if ((m.bestMissMask >> slot) & 1 == 1) {
            // The referee signed this miss (checked when the log was replayed) and also signed a receipt for the pick.
            m.bestLen = 0;
            m.bestResult = 0;
            m.bestMissMask = 0;
            _slash(id, m, side);
        }
        emit MissVoided(id, turn, side);
    }

    function finalizeDispute(uint256 id) external {
        Match storage m = _matches[id];
        if (m.status != Status.Disputed) revert WrongStatus();
        if (block.timestamp < m.windowEnd) revert TooEarly();

        uint256 bond = m.bond;
        address disputer = m.disputer;
        if (m.bestLen == 0) {
            m.status = Status.Settled;
            refereeActive[m.referee]--;
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
        refereeActive[m.referee]--;
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
        return keccak256(abi.encode("PLAYPOT_JINX_GENESIS", id));
    }

    function commitmentOf(uint256 id, uint16 turn, uint8 cell, bytes32 salt) public pure returns (bytes32) {
        return keccak256(abi.encode(id, turn, cell, salt));
    }

    function chainHash(bytes32 head, uint16 turn, bytes32 commitA, bytes32 commitB, uint8 cellA, uint8 cellB)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(head, turn, commitA, commitB, cellA, cellB));
    }

    function commitDigest(uint256 id, uint16 turn, bytes32 commitment, bytes32 prevHash) public view returns (bytes32) {
        return _digest(keccak256(abi.encode(COMMIT_TYPEHASH, id, turn, commitment, prevHash)));
    }

    function receiptDigest(uint256 id, uint16 turn, uint8 side, bytes32 commitment, uint64 openedMs, uint64 recvMs)
        public
        view
        returns (bytes32)
    {
        return _digest(keccak256(abi.encode(RECEIPT_TYPEHASH, id, turn, side, commitment, openedMs, recvMs)));
    }

    function missDigest(uint256 id, uint16 turn, uint8 side, uint8 kind, bytes32 commitment, uint64 openedMs, uint64 atMs)
        public
        view
        returns (bytes32)
    {
        return _digest(keccak256(abi.encode(MISS_TYPEHASH, id, turn, side, kind, commitment, openedMs, atMs)));
    }

    function resultDigest(uint256 id, uint8 result, bytes32 finalHash) public view returns (bytes32) {
        return _digest(keccak256(abi.encode(RESULT_TYPEHASH, id, result, finalHash)));
    }

    // ------------------------------------------------------------- internals

    function _digest(bytes32 structHash) internal view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
    }

    function _replay(uint256 id, Match storage m, Turn[] calldata turns) internal view returns (Replay memory r) {
        uint32[48] memory l = JinxRules.lines();
        JinxRules.Game memory g;
        r.head = genesisHash(id);
        r.target = (m.bestOf + 1) / 2;

        for (uint256 i = 0; i < turns.length; i++) {
            if (r.result != 0) revert BadReplay(); // turns after the match was decided
            (uint8 cellA, bytes32 commitA) = _side(id, m, i * 2, turns[i].a, r);
            (uint8 cellB, bytes32 commitB) = _side(id, m, i * 2 + 1, turns[i].b, r);
            r.head = chainHash(r.head, uint16(i), commitA, commitB, cellA, cellB);

            (uint8 outcome, uint8 flags) = JinxRules.applyTurn(g, cellA, cellB, l);
            if (flags & JinxRules.F_DOUBLE_FORFEIT != 0) {
                r.result = R_REFUND;
            } else if (outcome != JinxRules.ONGOING) {
                if (outcome == JinxRules.P1_WINS) r.wins1++;
                else if (outcome == JinxRules.P2_WINS) r.wins2++;
                else r.draws++;
                if (r.wins1 >= r.target) r.result = R_P1;
                else if (r.wins2 >= r.target) r.result = R_P2;
                else g = JinxRules.Game(0, 0, 0, 0, 0, 0, 0, r.draws >= 2); // next game; two draws make it a death match
            }
            if (r.result == 0 && i + 1 == MAX_TURNS) r.result = R_REFUND; // turn cap: abandoned
        }
        if (r.result == 0) revert BadReplay(); // the log must end in a decided match
    }

    /// Verifies one side of one turn and returns the pick (or NONE) and the commitment it was bound to.
    /// `slot` is turn * 2 + (side - 1).
    function _side(uint256 id, Match storage m, uint256 slot, Side calldata s, Replay memory r)
        internal
        view
        returns (uint8 cell, bytes32 commitment)
    {
        if (!s.missed) {
            commitment = _checkPick(id, m, slot, s, r.head);
            return (s.cell, commitment);
        }
        commitment = _checkMiss(id, m, slot, s);
        if (s.missKind == 0) r.missMask |= uint256(1) << slot;
        return (JinxRules.NONE, commitment);
    }

    function _checkPick(uint256 id, Match storage m, uint256 slot, Side calldata s, bytes32 head)
        private
        view
        returns (bytes32 commitment)
    {
        if (s.cell >= 25) revert BadReplay();
        commitment = commitmentOf(id, uint16(slot >> 1), s.cell, s.salt);
        address key = slot & 1 == 0 ? m.key1 : m.key2;
        if (_recover(commitDigest(id, uint16(slot >> 1), commitment, head), s.commitSig) != key) revert BadSignature();
        _checkReceipt(id, m.referee, slot, commitment, s.openedMs, s.recvMs, s.refSig);
    }

    /// A referee-signed receipt that the commitment arrived within the clock (plus the network allowance).
    function _checkReceipt(
        uint256 id,
        address ref,
        uint256 slot,
        bytes32 commitment,
        uint64 openedMs,
        uint64 recvMs,
        bytes calldata sig
    ) private view {
        if (recvMs < openedMs || recvMs > uint256(openedMs) + TURN_LIMIT_MS + GRACE_MS) revert BadReplay();
        bytes32 d = receiptDigest(id, uint16(slot >> 1), uint8(slot & 1) + 1, commitment, openedMs, recvMs);
        if (_recover(d, sig) != ref) revert BadSignature();
    }

    function _checkMiss(uint256 id, Match storage m, uint256 slot, Side calldata s) private view returns (bytes32 commitment) {
        if (s.missKind > 1) revert BadReplay();
        commitment = s.missKind == 1 ? s.commitment : bytes32(0);
        bytes32 d = missDigest(id, uint16(slot >> 1), uint8(slot & 1) + 1, s.missKind, commitment, s.openedMs, s.atMs);
        if (_recover(d, s.refSig) != m.referee) revert BadSignature();
        if (s.missKind == 0) {
            // The referee may only call a missing commitment once the clock has run out, and a signed receipt for it
            // (voidMiss) cancels the call.
            if (s.atMs < uint256(s.openedMs) + TURN_LIMIT_MS) revert BadReplay();
            if (voided[id][slot]) revert MissIsVoided();
        }
    }

    function _finish(uint256 id, Match storage m, uint8 result) internal {
        m.status = Status.Settled;
        refereeActive[m.referee]--;
        uint256 stake = m.stake;
        if (result == R_REFUND) {
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
            address(token).call(abi.encodeCall(IERC20JinxV2.transferFrom, (from, address(this), amount)));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }

    function _push(address to, uint256 amount) internal {
        (bool ok, bytes memory ret) = address(token).call(abi.encodeCall(IERC20JinxV2.transfer, (to, amount)));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }
}
