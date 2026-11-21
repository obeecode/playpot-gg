import type { Mark, Move } from '../lib/types';

export type Cell = Mark | null;

const LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6],
];

/** Board after the first `step` moves. */
export function boardAt(moves: Move[], step: number): Cell[] {
  const b: Cell[] = Array(9).fill(null);
  moves.slice(0, step).forEach((m) => { b[m.cell] = m.mark; });
  return b;
}

export function winLine(b: Cell[]): number[] {
  return LINES.find((l) => b[l[0]] && b[l[0]] === b[l[1]] && b[l[0]] === b[l[2]]) ?? [];
}

export function outcome(b: Cell[]): Mark | 'draw' | null {
  const l = winLine(b);
  if (l.length) return b[l[0]] as Mark;
  return b.every(Boolean) ? 'draw' : null;
}

/** Simple opponent for the mock only: win, sometimes block, else random. */
export function mockOpponentMove(b: Cell[], me: Mark, them: Mark): number {
  const free = b.map((c, i) => (c ? -1 : i)).filter((i) => i >= 0);
  const tryWin = (p: Mark) => free.find((i) => winLine(b.map((c, j) => (j === i ? p : c))).length > 0);
  const w = tryWin(me);
  if (w !== undefined) return w;
  if (Math.random() < 0.5) {
    const blk = tryWin(them);
    if (blk !== undefined) return blk;
  }
  return free[Math.floor(Math.random() * free.length)];
}
