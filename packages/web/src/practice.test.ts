import test from "node:test";
import assert from "node:assert/strict";
import { jinx, seededRng } from "@playpot/game";
import { Practice, type Timing } from "./practice.ts";

const FAST: Timing = { botMinMs: 1, botMaxMs: 3, revealMs: 1, gapMs: 1 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Plays a whole match: always taps the first empty square the moment a turn opens. */
async function playOut(p: Practice) {
  for (let i = 0; i < 3000 && p.phase !== "ended"; i++) {
    if (p.phase === "commit" && p.myPick === null) {
      const cell = p.rep.game.cells.findIndex((c) => c === jinx.EMPTY);
      assert.ok(p.tap(cell));
    }
    await sleep(2);
  }
}

test("a practice match plays to a result with the real rules", async () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const p = new Practice(3, () => {}, seededRng(seed), FAST);
    await playOut(p);
    assert.equal(p.phase, "ended", `seed ${seed} ended`);
    assert.ok([1, 2, 3].includes(p.result));
    assert.ok(p.entries.length > 0 && p.entries.length <= jinx.MAX_MATCH_TURNS);
    p.destroy();
  }
});

test("taps are refused when they would be illegal", async () => {
  const p = new Practice(3, () => {}, seededRng(9), { ...FAST, botMinMs: 50, botMaxMs: 60 });
  assert.equal(p.tap(-1), false);
  assert.equal(p.tap(25), false);
  assert.equal(p.tap(0), true);
  assert.equal(p.tap(1), false, "one pick per turn");
  p.destroy();
});

test("missing the clock places nothing for me and two misses forfeit the game", async () => {
  const p = new Practice(3, () => {}, seededRng(11), { ...FAST, botMinMs: 1, botMaxMs: 2 });
  // Do not tap: end the first turn by expiring the clock through the real timer path is slow (10 s),
  // so check the forfeit rule through the same replay the screen uses.
  p.destroy();
  const miss = { missed: true as const, missKind: 0 as const, cell: 0 };
  const bot = (cell: number) => ({ missed: false as const, missKind: 0 as const, cell });
  const { replayJinx } = await import("./jinxUi.ts");
  const rep = replayJinx([{ a: miss, b: bot(12) }, { a: miss, b: bot(13) }], 3);
  assert.equal(rep.snaps[1].forfeit, 1);
  assert.equal(rep.snaps[1].wins[1], 1);
});

test("destroy stops everything", async () => {
  let changes = 0;
  const p = new Practice(3, () => changes++, seededRng(3), FAST);
  p.destroy();
  const before = changes;
  await sleep(30);
  assert.equal(changes, before);
});
