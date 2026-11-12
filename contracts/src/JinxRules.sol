// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// JINX rules on bitboards: simultaneous-move tic-tac-toe on a 5x5 board. Must match packages/game/src/jinx.ts exactly
/// (checked against generated cross-language fixtures). Square i is bit i of a 25-bit mask.
library JinxRules {
    uint8 internal constant NONE = 255; // a missed pick
    uint32 internal constant ALL = 0x1FFFFFF;
    uint8 internal constant MISS_LIMIT = 2;

    // outcomes
    uint8 internal constant ONGOING = 0;
    uint8 internal constant P1_WINS = 1;
    uint8 internal constant P2_WINS = 2;
    uint8 internal constant DRAW = 3;

    // turn flags
    uint8 internal constant F_JINX = 1;
    uint8 internal constant F_DOUBLE_WIN = 2;
    uint8 internal constant F_CLEARED = 4;
    uint8 internal constant F_DOUBLE_FORFEIT = 8;
    uint8 internal constant F_FORFEIT_P1 = 16;
    uint8 internal constant F_FORFEIT_P2 = 32;

    error IllegalPick();

    struct Game {
        uint32 p1;
        uint32 p2;
        uint32 dead;
        uint32 ageHi; // dead squares with 2 turns left before reopening (death match only)
        uint32 ageLo; // dead squares with 1 turn left
        uint8 miss1;
        uint8 miss2;
        bool death;
    }

    function lines() internal pure returns (uint32[48] memory l) {
        l[0] = 0x0000007;
        l[1] = 0x0000421;
        l[2] = 0x0001041;
        l[3] = 0x000000E;
        l[4] = 0x0000842;
        l[5] = 0x0002082;
        l[6] = 0x000001C;
        l[7] = 0x0001084;
        l[8] = 0x0004104;
        l[9] = 0x0000444;
        l[10] = 0x0002108;
        l[11] = 0x0000888;
        l[12] = 0x0004210;
        l[13] = 0x0001110;
        l[14] = 0x00000E0;
        l[15] = 0x0008420;
        l[16] = 0x0020820;
        l[17] = 0x00001C0;
        l[18] = 0x0010840;
        l[19] = 0x0041040;
        l[20] = 0x0000380;
        l[21] = 0x0021080;
        l[22] = 0x0082080;
        l[23] = 0x0008880;
        l[24] = 0x0042100;
        l[25] = 0x0011100;
        l[26] = 0x0084200;
        l[27] = 0x0022200;
        l[28] = 0x0001C00;
        l[29] = 0x0108400;
        l[30] = 0x0410400;
        l[31] = 0x0003800;
        l[32] = 0x0210800;
        l[33] = 0x0820800;
        l[34] = 0x0007000;
        l[35] = 0x0421000;
        l[36] = 0x1041000;
        l[37] = 0x0111000;
        l[38] = 0x0842000;
        l[39] = 0x0222000;
        l[40] = 0x1084000;
        l[41] = 0x0444000;
        l[42] = 0x0038000;
        l[43] = 0x0070000;
        l[44] = 0x00E0000;
        l[45] = 0x0700000;
        l[46] = 0x0E00000;
        l[47] = 0x1C00000;
    }

    function empties(Game memory g) internal pure returns (uint32) {
        return ALL & ~(g.p1 | g.p2 | g.dead);
    }

    /// Can a player with `opp` as the other player's marks still make three in a row?
    function canWin(Game memory g, uint32 opp, uint32[48] memory l) internal pure returns (bool) {
        uint32 blocked = g.death ? opp : (opp | g.dead);
        for (uint256 i = 0; i < 48; i++) {
            if (l[i] & blocked == 0) return true;
        }
        return false;
    }

    function validate(Game memory g, uint8 a, uint8 b) private pure {
        uint32 occupied = g.p1 | g.p2 | g.dead;
        if (a != NONE && (a >= 25 || (occupied >> a) & 1 != 0)) revert IllegalPick();
        if (b != NONE && (b >= 25 || (occupied >> b) & 1 != 0)) revert IllegalPick();
    }

    /// Places the picks (or jinxes the square), then finds completed lines. Returns the flags so far, the squares that
    /// died this turn, and the winner if exactly one player completed a line.
    function place(Game memory g, uint8 a, uint8 b, uint32[48] memory l)
        private
        pure
        returns (uint8 flags, uint32 justDead, uint8 winner)
    {
        if (a != NONE && a == b) {
            flags = F_JINX;
            justDead = uint32(1) << a;
            g.dead |= justDead;
            if (g.death) g.ageHi |= justDead;
        } else {
            if (a != NONE) g.p1 |= uint32(1) << a;
            if (b != NONE) g.p2 |= uint32(1) << b;
        }

        uint32 burn1;
        uint32 burn2;
        for (uint256 i = 0; i < 48; i++) {
            uint32 m = l[i];
            if (m & g.p1 == m) burn1 |= m;
            if (m & g.p2 == m) burn2 |= m;
        }
        if (burn1 != 0 && burn2 != 0) {
            // Both finished a line on the same reveal: neither wins and every square in both lines dies.
            flags |= F_DOUBLE_WIN;
            uint32 burn = burn1 | burn2;
            g.p1 &= ~burn;
            g.p2 &= ~burn;
            g.dead |= burn;
            if (g.death) g.ageHi |= burn;
            justDead |= burn;
        } else if (burn1 != 0) {
            winner = P1_WINS;
        } else if (burn2 != 0) {
            winner = P2_WINS;
        }
    }

    /// Death match: jinxed squares count down after each turn, but not on the turn they died.
    function age(Game memory g, uint32 justDead) private pure {
        bool first = true;
        do {
            uint32 fresh = first ? justDead : 0;
            g.dead &= ~g.ageLo;
            g.ageLo = g.ageHi & ~fresh;
            g.ageHi = g.ageHi & fresh;
            first = false;
        } while (empties(g) == 0);
    }

    /// Applies one simultaneous reveal. Returns (outcome, flags). Reverts on a pick that is not an empty square.
    function applyTurn(Game memory g, uint8 a, uint8 b, uint32[48] memory l)
        internal
        pure
        returns (uint8 outcome, uint8 flags)
    {
        validate(g, a, b);
        g.miss1 = a == NONE ? g.miss1 + 1 : 0;
        g.miss2 = b == NONE ? g.miss2 + 1 : 0;

        uint32 justDead;
        (flags, justDead, outcome) = place(g, a, b, l);
        if (outcome != ONGOING) return (outcome, flags);

        if (g.miss1 >= MISS_LIMIT && g.miss2 >= MISS_LIMIT) return (DRAW, flags | F_DOUBLE_FORFEIT);
        if (g.miss1 >= MISS_LIMIT) return (P2_WINS, flags | F_FORFEIT_P1);
        if (g.miss2 >= MISS_LIMIT) return (P1_WINS, flags | F_FORFEIT_P2);

        if (!canWin(g, g.p2, l) && !canWin(g, g.p1, l)) {
            if (!g.death) return (DRAW, flags);
            g.p1 = 0;
            g.p2 = 0;
            g.dead = 0;
            g.ageHi = 0;
            g.ageLo = 0;
            return (ONGOING, flags | F_CLEARED);
        }

        if (g.death) age(g, justDead);
        return (ONGOING, flags);
    }
}
