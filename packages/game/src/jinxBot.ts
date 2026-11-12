// The prototype's simple bot, used by tests and fixture generation (and later a practice mode).
import { DEAD, EMPTY, LINES, winCells, type GameState } from "./jinx.ts";

export const seededRng = (seed: number) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

export function botPick(s: GameState, me: 1 | 2, them: 1 | 2, rand: () => number): number {
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

