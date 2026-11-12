// Generates cross-language test vectors: seeded JINX games played with the TypeScript rules, recording the outcome,
// flags and full board after every turn. The Foundry test replays them through the Solidity rules.
// Usage: node scripts/gen-jinx-fixtures.ts
import { writeFileSync } from "node:fs";
import { jinx } from "../packages/game/src/index.ts";
import { botPick, seededRng } from "../packages/game/src/jinxBot.ts";

const { applyTurn, newGame, DEAD, P1, P2, CELLS, winCells } = jinx;
type GameState = jinx.GameState;

const outcomeCode = { ongoing: 0, p1: 1, p2: 2, draw: 3 } as const;
const MISS = 255;

const masks = (s: GameState) => {
  let p1 = 0, p2 = 0, dead = 0, hi = 0, lo = 0;
  for (let i = 0; i < CELLS; i++) {
    const bit = 1 << i;
    if (s.cells[i] === P1) p1 |= bit;
    else if (s.cells[i] === P2) p2 |= bit;
    else if (s.cells[i] === DEAD) {
      dead |= bit;
      if (s.age[i] === 2) hi |= bit;
      else if (s.age[i] === 1) lo |= bit;
    }
  }
  return [p1, p2, dead, hi, lo];
};

const flagsOf = (r: jinx.TurnResult) =>
  (r.jinx ? 1 : 0) | (r.doubleWin ? 2 : 0) | (r.cleared ? 4 : 0) | (r.doubleForfeit ? 8 : 0) | (r.forfeit === 1 ? 16 : 0) | (r.forfeit === 2 ? 32 : 0);

type Style = "bot" | "random" | "jinxy" | "missy" | "clear" | "abandon";

// A full colouring of the board with no monochrome line: filling it exercises dead boards and the death-match clear.
const COLOURING = [0, 0, 1, 1, 0, 1, 1, 0, 0, 1, 0, 0, 1, 1, 0, 1, 1, 0, 0, 1, 0, 0, 1, 1, 0];

function play(seed: number, death: boolean, style: Style) {
  const rand = seededRng(seed);
  const pickRandom = (s: GameState) => {
    const es: number[] = [];
    s.cells.forEach((v, i) => v === 0 && es.push(i));
    return es[Math.floor(rand() * es.length)];
  };
  let s = newGame(death);
  const picks: number[] = [], expectOutcome: number[] = [], expectFlags: number[] = [], states: number[] = [];
  for (let t = 0; t < 300; t++) {
    let a: number | null, b: number | null;
    if (style === "abandon") {
      a = t < 2 ? pickRandom(s) : null;
      b = t < 2 ? pickRandom(s) : null;
    } else if (style === "clear") {
      const mine = (c: number, s2: GameState) => {
        const os: number[] = [];
        s2.cells.forEach((v, i) => v === 0 && COLOURING[i] === c && os.push(i));
        return os.length ? os[Math.floor(rand() * os.length)] : null;
      };
      a = mine(0, s);
      b = mine(1, s);
      if (a === null && b === null) break;
    } else if (style === "bot") {
      a = botPick(s, 1, 2, rand);
      b = botPick(s, 2, 1, rand);
    } else {
      a = pickRandom(s);
      b = style === "jinxy" && rand() < 0.45 ? a : pickRandom(s);
      if (style === "missy") {
        if (rand() < 0.3) a = null;
        if (rand() < 0.3) b = null;
      }
      if (style === "random" && rand() < 0.5) {
        // aim for completed lines so wins and double wins show up
        const w1 = winCells(s, 1), w2 = winCells(s, 2);
        if (w1.length && rand() < 0.7) a = w1[Math.floor(rand() * w1.length)];
        if (w2.length && rand() < 0.7) b = w2[Math.floor(rand() * w2.length)];
      }
    }
    if (a === null && b === null && s.cells.every((c) => c !== 0)) break;
    const r = applyTurn(s, a, b);
    s = r.state;
    picks.push(a ?? MISS, b ?? MISS);
    expectOutcome.push(outcomeCode[r.outcome]);
    expectFlags.push(flagsOf(r));
    states.push(...masks(s));
    if (r.outcome !== "ongoing" || (style === "clear" && r.cleared)) break;
  }
  return { death: death ? 1 : 0, expectFlags, expectOutcome, picks, states };
}

const games = [];
const styles: Style[] = ["bot", "random", "jinxy", "missy", "clear", "abandon"];
let seed = 1000;
for (let i = 0; i < 600; i++) games.push(play(seed++, Math.floor(i / styles.length) % 2 === 1, styles[i % styles.length]));

const tally = { turns: 0, p1: 0, p2: 0, draw: 0, jinx: 0, doubleWin: 0, cleared: 0, doubleForfeit: 0, forfeit: 0 };
for (const g of games) {
  tally.turns += g.expectOutcome.length;
  const last = g.expectOutcome[g.expectOutcome.length - 1];
  if (last === 1) tally.p1++; else if (last === 2) tally.p2++; else if (last === 3) tally.draw++;
  for (const f of g.expectFlags) {
    if (f & 1) tally.jinx++;
    if (f & 2) tally.doubleWin++;
    if (f & 4) tally.cleared++;
    if (f & 8) tally.doubleForfeit++;
    if (f & 48) tally.forfeit++;
  }
}
writeFileSync("contracts/test/fixtures/jinx_rules.json", JSON.stringify(games));
console.log(`wrote ${games.length} games`, tally);
