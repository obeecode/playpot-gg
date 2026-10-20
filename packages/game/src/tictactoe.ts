// Tic-tac-toe rules. Cells 0..8 row-major. Move 0 is X (player 1). Mirrors contracts/src/TicTacToe.sol.

export const ONGOING = 0;
export const P1_WIN = 1;
export const P2_WIN = 2;
export const DRAW = 3;
export type Outcome = 0 | 1 | 2 | 3;

export const WIN_MASKS = [0x007, 0x038, 0x1c0, 0x049, 0x092, 0x124, 0x111, 0x054] as const;

export interface Board {
  x: number;
  o: number;
  moves: number;
}

export const initialBoard = (): Board => ({ x: 0, o: 0, moves: 0 });

const wins = (mask: number): boolean => WIN_MASKS.some((m) => (mask & m) === m);

export function legalCells(b: Board): number[] {
  const out: number[] = [];
  for (let c = 0; c < 9; c++) if (((b.x | b.o) & (1 << c)) === 0) out.push(c);
  return out;
}

export function applyMove(b: Board, cell: number): { board: Board; outcome: Outcome } {
  if (!Number.isInteger(cell) || cell < 0 || cell > 8) throw new Error("cell out of range");
  const bit = 1 << cell;
  if ((b.x | b.o) & bit) throw new Error("cell occupied");
  const xTurn = b.moves % 2 === 0;
  const board: Board = { x: xTurn ? b.x | bit : b.x, o: xTurn ? b.o : b.o | bit, moves: b.moves + 1 };
  let outcome: Outcome = ONGOING;
  if (xTurn && wins(board.x)) outcome = P1_WIN;
  else if (!xTurn && wins(board.o)) outcome = P2_WIN;
  else if (board.moves === 9) outcome = DRAW;
  return { board, outcome };
}

export function replay(cells: readonly number[]): { board: Board; outcome: Outcome } {
  let board = initialBoard();
  let outcome: Outcome = ONGOING;
  for (const c of cells) {
    if (outcome !== ONGOING) throw new Error("move after game end");
    ({ board, outcome } = applyMove(board, c));
  }
  return { board, outcome };
}

export function toGrid(b: Board): Array<"X" | "O" | null> {
  return Array.from({ length: 9 }, (_, c) => (b.x & (1 << c) ? "X" : b.o & (1 << c) ? "O" : null));
}

export const turnOf = (b: Board): 0 | 1 => (b.moves % 2) as 0 | 1;
