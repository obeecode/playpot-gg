// JINX rules: simultaneous-move tic-tac-toe on a 5x5 board. Pure and deterministic (no randomness, no clocks).
// Ported from the playable prototype. A pick is a square index 0..24, or null for a missed clock.

export const SIZE = 5;
export const CELLS = SIZE * SIZE;
export const EMPTY = 0;
export const P1 = 1;
export const P2 = 2;
export const DEAD = 3;
export const REOPEN_TURNS = 2; // death match: a jinxed square reopens after this many turns
export const MISS_LIMIT = 2; // consecutive missed picks that forfeit a game

export const LINES: readonly (readonly number[])[] = (() => {
  const lines: number[][] = [];
  const dirs = [[0, 1], [1, 0], [1, 1], [1, -1]];
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      for (const [dr, dc] of dirs) {
        const line: number[] = [];
        for (let k = 0; k < 3; k++) {
          const rr = r + k * dr;
          const cc = c + k * dc;
          if (rr < 0 || rr >= SIZE || cc < 0 || cc >= SIZE) break;
          line.push(rr * SIZE + cc);
        }
        if (line.length === 3) lines.push(line);
      }
    }
  }
  return lines;
})();

export type PickOrMiss = number | null;
export type GameOutcome = "ongoing" | "p1" | "p2" | "draw";

export interface GameState {
  cells: number[]; // EMPTY, P1, P2 or DEAD
  age: number[]; // death match: turns left before a DEAD square reopens
  death: boolean;
  miss: [number, number]; // consecutive missed picks per player
  turns: number;
}

export interface TurnResult {
  state: GameState;
  outcome: GameOutcome;
  jinx: boolean;
  doubleWin: boolean;
  cleared: boolean; // death match: a full board with no possible line was wiped
  forfeit: 0 | 1 | 2; // which player forfeited (0 none)
  winLine: number[];
}

export const newGame = (death = false): GameState => ({
  cells: new Array(CELLS).fill(EMPTY),
  age: new Array(CELLS).fill(0),
  death,
  miss: [0, 0],
  turns: 0,
});

const empties = (cells: readonly number[]): number[] => {
  const out: number[] = [];
  cells.forEach((v, i) => {
    if (v === EMPTY) out.push(i);
  });
  return out;
};

const completeLines = (cells: readonly number[], p: number) => LINES.filter((l) => l.every((i) => cells[i] === p));

/** Empty squares that would complete three in a row for player p on the next reveal. */
export function winCells(state: GameState, p: 1 | 2): number[] {
  return empties(state.cells).filter((c) =>
    LINES.some((l) => l.includes(c) && l.every((i) => i === c || state.cells[i] === p)),
  );
}

/** Can player p still make three in a row? In a death match, reopening squares count as winnable. */
export function canWin(state: GameState, p: 1 | 2): boolean {
  return LINES.some((l) =>
    l.every((i) => state.cells[i] === p || state.cells[i] === EMPTY || (state.death && state.cells[i] === DEAD)),
  );
}

/** Applies one simultaneous reveal. Throws if a pick is not an empty square. */
export function applyTurn(prev: GameState, a: PickOrMiss, b: PickOrMiss): TurnResult {
  for (const p of [a, b]) {
    if (p !== null && (!Number.isInteger(p) || p < 0 || p >= CELLS || prev.cells[p] !== EMPTY)) {
      throw new Error(`illegal pick ${p}`);
    }
  }
  const heal = prev.death ? REOPEN_TURNS : 0;
  const state: GameState = {
    cells: prev.cells.slice(),
    age: prev.age.slice(),
    death: prev.death,
    miss: [a === null ? prev.miss[0] + 1 : 0, b === null ? prev.miss[1] + 1 : 0],
    turns: prev.turns + 1,
  };
  const { cells, age } = state;
  const justDead: number[] = [];
  const jinx = a !== null && a === b;

  if (jinx) {
    cells[a] = DEAD;
    age[a] = heal;
    justDead.push(a);
  } else {
    if (a !== null) cells[a] = P1;
    if (b !== null) cells[b] = P2;
  }

  let la = completeLines(cells, P1);
  let lb = completeLines(cells, P2);
  let doubleWin = false;
  if (la.length && lb.length) {
    doubleWin = true;
    for (const line of la.concat(lb)) {
      for (const i of line) {
        cells[i] = DEAD;
        age[i] = heal;
        justDead.push(i);
      }
    }
    la = [];
    lb = [];
  }

  const result: TurnResult = { state, outcome: "ongoing", jinx, doubleWin, cleared: false, forfeit: 0, winLine: [] };
  const f1 = state.miss[0] >= MISS_LIMIT;
  const f2 = state.miss[1] >= MISS_LIMIT;

  if (la.length || lb.length) {
    result.outcome = la.length ? "p1" : "p2";
    result.winLine = [...new Set((la.length ? la : lb).flat())];
  } else if (f1 && f2) {
    result.outcome = "draw";
  } else if (f1 || f2) {
    result.forfeit = f1 ? 1 : 2;
    result.outcome = f1 ? "p2" : "p1";
  } else if (state.death && !canWin(state, P1) && !canWin(state, P2)) {
    state.cells = new Array(CELLS).fill(EMPTY);
    state.age = new Array(CELLS).fill(0);
    result.cleared = true;
  } else if (!canWin(state, P1) && !canWin(state, P2)) {
    result.outcome = "draw";
  } else if (heal) {
    // Jinxed squares count down after each turn, but not on the turn they became dead.
    let first = true;
    do {
      for (let i = 0; i < CELLS; i++) {
        if (cells[i] !== DEAD || (first && justDead.includes(i))) continue;
        if (--age[i] <= 0) {
          cells[i] = EMPTY;
          age[i] = 0;
        }
      }
      first = false;
    } while (!empties(cells).length);
  }
  return result;
}

// ------------------------------------------------------------------------------------------------ matches

export interface MatchState {
  bestOf: 3 | 5;
  wins: [number, number];
  draws: number;
  games: number;
}

export const newMatch = (bestOf: 3 | 5): MatchState => ({ bestOf, wins: [0, 0], draws: 0, games: 0 });
export const matchTarget = (m: MatchState): number => (m.bestOf + 1) / 2;
/** Two drawn games make every remaining game of the match a death match. */
export const isDeathMatch = (m: MatchState): boolean => m.draws >= 2;

/** Records a finished game. `winner` is 0 while the match is still going. */
export function recordGame(m: MatchState, outcome: "p1" | "p2" | "draw"): { match: MatchState; winner: 0 | 1 | 2 } {
  const match: MatchState = { ...m, wins: [m.wins[0], m.wins[1]], games: m.games + 1 };
  if (outcome === "p1") match.wins[0]++;
  else if (outcome === "p2") match.wins[1]++;
  else match.draws++;
  const t = matchTarget(match);
  return { match, winner: match.wins[0] >= t ? 1 : match.wins[1] >= t ? 2 : 0 };
}
