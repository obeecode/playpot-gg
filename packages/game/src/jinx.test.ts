import test from "node:test";
import assert from "node:assert/strict";
import {
  applyTurn,
  canWin,
  CELLS,
  DEAD,
  EMPTY,
  isDeathMatch,
  LINES,
  newGame,
  newMatch,
  P1,
  P2,
  recordGame,
  winCells,
  type GameState,
} from "./jinx.ts";

const state = (marks: Record<number, number>, opts: Partial<GameState> = {}): GameState => {
  const s = newGame(opts.death ?? false);
  for (const [i, v] of Object.entries(marks)) {
    s.cells[Number(i)] = v;
    if (v === DEAD) s.age[Number(i)] = opts.death ? 2 : 0;
  }
  return { ...s, ...opts, cells: s.cells, age: s.age };
};

test("the 5x5 board has 48 winning lines", () => {
  assert.equal(LINES.length, 48);
});

// P1 owns (0,0),(0,1),(1,0): threats at (0,2)=2 and (2,0)=10. P2 owns (4,3),(4,4): threat at (4,2)=22.
const guess = () => state({ 0: P1, 1: P1, 5: P1, 23: P2, 24: P2 });

test("threat setup is as described", () => {
  const s = guess();
  assert.deepEqual(winCells(s, P1), [2, 10]);
  assert.deepEqual(winCells(s, P2), [22]);
});

test("doc table: you pick a winning square, they pick your other winning square -> you win", () => {
  const r = applyTurn(guess(), 2, 10);
  assert.equal(r.outcome, "p1");
  assert.deepEqual(r.winLine.sort((x, y) => x - y), [0, 1, 2]);
});

test("doc table: both pick the same winning square -> jinx, each keeps one threat", () => {
  const r = applyTurn(guess(), 2, 2);
  assert.equal(r.jinx, true);
  assert.equal(r.outcome, "ongoing");
  assert.equal(r.state.cells[2], DEAD);
  assert.deepEqual(winCells(r.state, P1), [10]);
  assert.deepEqual(winCells(r.state, P2), [22]);
});

test("doc table: you take your win, they take their own win -> double win, both lines burn", () => {
  const r = applyTurn(guess(), 2, 22);
  assert.equal(r.doubleWin, true);
  assert.equal(r.outcome, "ongoing");
  for (const i of [0, 1, 2, 22, 23, 24]) assert.equal(r.state.cells[i], DEAD);
});

test("doc table: you pick their winning square, they pick it too -> jinx, their threat is gone, you keep two", () => {
  const r = applyTurn(guess(), 22, 22);
  assert.equal(r.jinx, true);
  assert.deepEqual(winCells(r.state, P2), []);
  assert.deepEqual(winCells(r.state, P1), [2, 10]);
});

test("doc table: you pick their winning square, they pick one of yours -> you keep one, they have none", () => {
  const r = applyTurn(guess(), 22, 2);
  assert.equal(r.outcome, "ongoing");
  assert.deepEqual(winCells(r.state, P1), [10]);
  assert.deepEqual(winCells(r.state, P2), []);
});

test("picks must be empty squares", () => {
  assert.throws(() => applyTurn(guess(), 0, 3), /illegal pick/);
  assert.throws(() => applyTurn(guess(), 3, 25), /illegal pick/);
  assert.throws(() => applyTurn(guess(), 3, -1), /illegal pick/);
});

test("clock: a missed pick lets the other pick land uncontested", () => {
  const r = applyTurn(newGame(), null, 12);
  assert.equal(r.state.cells[12], P2);
  assert.deepEqual(r.state.miss, [1, 0]);
  assert.equal(r.outcome, "ongoing");
});

test("clock: two misses in a row forfeit the game, and a pick resets the count", () => {
  let r = applyTurn(newGame(), null, 1);
  r = applyTurn(r.state, 2, 3);
  assert.deepEqual(r.state.miss, [0, 0]);
  r = applyTurn(r.state, null, 4);
  r = applyTurn(r.state, null, 5);
  assert.equal(r.forfeit, 1);
  assert.equal(r.outcome, "p2");
});

test("clock: both missing the same turn places nothing; both missing twice is a draw", () => {
  let r = applyTurn(newGame(), null, null);
  assert.equal(r.state.cells.every((c) => c === EMPTY), true);
  r = applyTurn(r.state, null, null);
  assert.equal(r.outcome, "draw");
});

test("a line completed on the same reveal as a forfeit still wins the game", () => {
  // P1 misses a second time but P2 completes a line on that reveal.
  const s = state({ 10: P2, 11: P2 }, { miss: [1, 0] });
  const r = applyTurn(s, null, 12);
  assert.equal(r.outcome, "p2");
  assert.equal(r.forfeit, 0);
});

test("normal game: a dead board is a draw", () => {
  const marks: Record<number, number> = {};
  for (let i = 0; i < CELLS; i++) marks[i] = DEAD;
  delete marks[0];
  delete marks[1];
  const r = applyTurn(state(marks), 0, 1);
  assert.equal(r.outcome, "draw");
});

test("death match: a jinxed square reopens after two turns, not on the turn it died", () => {
  let r = applyTurn(newGame(true), 12, 12);
  assert.equal(r.state.cells[12], DEAD);
  assert.equal(r.state.age[12], 2);
  r = applyTurn(r.state, 0, 24);
  assert.equal(r.state.cells[12], DEAD);
  assert.equal(r.state.age[12], 1);
  r = applyTurn(r.state, 1, 23);
  assert.equal(r.state.cells[12], EMPTY);
});

test("death match: a full board with no possible line clears and the game goes on", () => {
  // A full 5x5 colouring with no monochrome line (found by exhaustive search). 0 = P1, 1 = P2.
  const colouring = [0, 0, 1, 1, 0, 1, 1, 0, 0, 1, 0, 0, 1, 1, 0, 1, 1, 0, 0, 1, 0, 0, 1, 1, 0];
  const full = colouring.map((c) => (c === 0 ? P1 : P2));
  assert.equal(LINES.some((l) => l.every((i) => full[i] === full[l[0]])), false);
  // Leave one square of each colour open; the final picks complete the board.
  const marks: Record<number, number> = {};
  full.forEach((v, i) => (marks[i] = v));
  delete marks[0]; // P1's square
  delete marks[2]; // P2's square
  const r = applyTurn(state(marks, { death: true }), 0, 2);
  assert.equal(r.cleared, true);
  assert.equal(r.outcome, "ongoing");
  assert.equal(r.state.cells.every((c) => c === EMPTY), true);

  // The same position in a normal game is a draw.
  assert.equal(applyTurn(state(marks), 0, 2).outcome, "draw");
});

test("death match: a double win leaves the burned squares locked for two turns", () => {
  const s = state({ 0: P1, 1: P1, 23: P2, 24: P2 }, { death: true });
  const r = applyTurn(s, 2, 22);
  assert.equal(r.doubleWin, true);
  for (const i of [0, 1, 2, 22, 23, 24]) {
    assert.equal(r.state.cells[i], DEAD);
    assert.equal(r.state.age[i], 2);
  }
});

test("matches: draws are replayed and two draws trigger the death match", () => {
  let m = newMatch(3);
  assert.equal(isDeathMatch(m), false);
  m = recordGame(m, "draw").match;
  assert.equal(isDeathMatch(m), false);
  m = recordGame(m, "draw").match;
  assert.equal(isDeathMatch(m), true);
  assert.equal(m.wins[0] + m.wins[1], 0);
});

test("matches: first to 2 (best of 3) or 3 (best of 5) wins, and a series is bounded", () => {
  let m = newMatch(3);
  let r = recordGame(m, "p1");
  assert.equal(r.winner, 0);
  r = recordGame(r.match, "p1");
  assert.equal(r.winner, 1);

  m = newMatch(5);
  for (const o of ["p2", "p2"] as const) m = recordGame(m, o).match;
  assert.equal(recordGame(m, "p2").winner, 2);

  // Longest possible series: two draws, then the maximum number of decisive games.
  const longest = (bestOf: 3 | 5) => {
    let match = newMatch(bestOf);
    match = recordGame(match, "draw").match;
    match = recordGame(match, "draw").match;
    const t = (bestOf + 1) / 2;
    for (let i = 0; i < t - 1; i++) {
      match = recordGame(match, "p1").match;
      match = recordGame(match, "p2").match;
    }
    return recordGame(match, "p1").match.games;
  };
  assert.equal(longest(3), 5);
  assert.equal(longest(5), 7);
});

// -------------------------------------------- fidelity check against the numbers published in the doc

const rng = (seed: number) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

function bot(s: GameState, me: 1 | 2, them: 1 | 2, rand: () => number): number {
  const pick = (a: number[]) => a[Math.floor(rand() * a.length)];
  const build = () => {
    const es: number[] = [];
    s.cells.forEach((v, i) => v === EMPTY && es.push(i));
    const weights = es.map((c) => {
      let w = 0.3;
      for (const l of LINES) {
        if (!l.includes(c)) continue;
        let mine = 0, theirs = 0, dead = 0;
        for (const i of l) {
          if (s.cells[i] === me) mine++;
          else if (s.cells[i] === them) theirs++;
          else if (s.cells[i] === DEAD) dead++;
        }
        if (dead) continue;
        if (!theirs) w += 1 + 3 * mine;
        if (!mine) w += 0.6 * (1 + 3 * theirs);
      }
      return w * w;
    });
    let r = rand() * weights.reduce((x, y) => x + y, 0);
    for (let i = 0; i < es.length; i++) {
      r -= weights[i];
      if (r <= 0) return es[i];
    }
    return es[es.length - 1];
  };
  const mineW = winCells(s, me);
  const theirW = winCells(s, them);
  if (mineW.length && theirW.length) return rand() < 0.5 ? pick(mineW) : pick(theirW);
  if (mineW.length > 1) return pick(mineW);
  if (mineW.length === 1) return rand() < 0.65 ? mineW[0] : build();
  if (theirW.length) return pick(theirW);
  return build();
}

function simulate(games: number, death: boolean, seed: number) {
  const rand = rng(seed);
  let draws = 0;
  let turns = 0;
  for (let g = 0; g < games; g++) {
    let s = newGame(death);
    for (let t = 0; t < 500; t++) {
      const r = applyTurn(s, bot(s, 1, 2, rand), bot(s, 2, 1, rand));
      s = r.state;
      if (r.outcome !== "ongoing") {
        if (r.outcome === "draw") draws++;
        turns += s.turns;
        break;
      }
    }
  }
  return { drawRate: draws / games, avgTurns: turns / games };
}

test("fidelity: 5x5 permanent jinx draws about 32% of bot-vs-bot games over about 8.1 turns (doc table)", () => {
  const { drawRate, avgTurns } = simulate(3000, false, 1);
  console.log(`  permanent jinx: ${(drawRate * 100).toFixed(1)}% drawn, ${avgTurns.toFixed(1)} turns (doc: 32%, 8.1)`);
  assert.ok(Math.abs(drawRate - 0.32) < 0.06, `draw rate ${drawRate}`);
  assert.ok(Math.abs(avgTurns - 8.1) < 1.0, `avg turns ${avgTurns}`);
});

test("fidelity: the death match never draws and takes about 9.3 turns (doc table)", () => {
  const { drawRate, avgTurns } = simulate(3000, true, 2);
  console.log(`  death match:    ${(drawRate * 100).toFixed(1)}% drawn, ${avgTurns.toFixed(1)} turns (doc: 0%, 9.3)`);
  assert.equal(drawRate, 0);
  assert.ok(Math.abs(avgTurns - 9.3) < 1.2, `avg turns ${avgTurns}`);
});
