// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// Pure tic-tac-toe rules. Cells are 0..8 (row-major). Move index 0 is X (player 1).
library TicTacToe {
    uint8 internal constant ONGOING = 0;
    uint8 internal constant P1_WIN = 1;
    uint8 internal constant P2_WIN = 2;
    uint8 internal constant DRAW = 3;

    error CellOutOfRange();
    error CellOccupied();

    function _wins(uint16 m) private pure returns (bool) {
        return (m & 0x007) == 0x007 || (m & 0x038) == 0x038 || (m & 0x1C0) == 0x1C0
            || (m & 0x049) == 0x049 || (m & 0x092) == 0x092 || (m & 0x124) == 0x124
            || (m & 0x111) == 0x111 || (m & 0x054) == 0x054;
    }

    /// Applies move number `index` (even = X, odd = O) and returns the new masks and outcome.
    function step(uint16 x, uint16 o, uint8 index, uint8 cell)
        internal
        pure
        returns (uint16 nx, uint16 no, uint8 outcome)
    {
        if (cell > 8) revert CellOutOfRange();
        uint16 bit = uint16(1) << cell;
        if ((x | o) & bit != 0) revert CellOccupied();
        nx = x;
        no = o;
        if (index % 2 == 0) {
            nx = x | bit;
            if (_wins(nx)) return (nx, no, P1_WIN);
        } else {
            no = o | bit;
            if (_wins(no)) return (nx, no, P2_WIN);
        }
        outcome = index == 8 ? DRAW : ONGOING;
    }
}
