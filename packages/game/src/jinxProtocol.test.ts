import test from "node:test";
import assert from "node:assert/strict";
import { privateKeyToAccount } from "viem/accounts";
import { keccak256, toHex, type Hex } from "viem";
import {
  commitmentOf,
  jinxChain,
  jinxDomain,
  jinxGenesis,
  NO_PICK,
  signCommit,
  signMiss,
  signReceipt,
  verifyJinxLog,
  ZERO32,
  type JinxMatchLog,
  type JinxSide,
  type JinxTurnLog,
} from "./index.ts";

const K1 = privateKeyToAccount("0x00000000000000000000000000000000000000000000000000000000000000c1");
const K2 = privateKeyToAccount("0x00000000000000000000000000000000000000000000000000000000000000c2");
const REF = privateKeyToAccount("0x0000000000000000000000000000000000000000000000000000000000000def");
const ESCROW = "0x2222222222222222222222222222222222222222" as const;
const matchId = 9n;
const domain = jinxDomain(84532, ESCROW);

const salt = (turn: number, side: number): Hex => keccak256(toHex(`salt-${turn}-${side}`));
const opened = (turn: number) => BigInt(turn * 20_000);

async function side(turn: number, s: 1 | 2, cell: number, head: Hex): Promise<{ side: JinxSide; commitment: Hex; cell: number }> {
  const openedMs = opened(turn);
  if (cell === NO_PICK) {
    const atMs = openedMs + 10_000n;
    const refSig = await signMiss(REF, domain, { matchId, turn, side: s, kind: 0, commitment: ZERO32, openedMs, atMs });
    return {
      side: { missed: true, missKind: 0, cell: 0, salt: ZERO32, commitment: ZERO32, openedMs: `${openedMs}`, recvMs: "0", atMs: `${atMs}`, commitSig: "0x", refSig },
      commitment: ZERO32,
      cell: NO_PICK,
    };
  }
  const sl = salt(turn, s);
  const commitment = commitmentOf(matchId, turn, cell, sl);
  const recvMs = openedMs + 1500n + BigInt(s * 10);
  const commitSig = await signCommit(s === 1 ? K1 : K2, domain, { matchId, turn, commitment, prevHash: head });
  const refSig = await signReceipt(REF, domain, { matchId, turn, side: s, commitment, openedMs, recvMs });
  return {
    side: { missed: false, missKind: 0, cell, salt: sl, commitment: ZERO32, openedMs: `${openedMs}`, recvMs: `${recvMs}`, atMs: "0", commitSig, refSig },
    commitment,
    cell,
  };
}

async function buildLog(picks: number[], bestOf: 3 | 5 = 3): Promise<JinxMatchLog> {
  let head = jinxGenesis(matchId);
  const turns: JinxTurnLog[] = [];
  for (let i = 0; i < picks.length / 2; i++) {
    const a = await side(i, 1, picks[2 * i], head);
    const b = await side(i, 2, picks[2 * i + 1], head);
    head = jinxChain(head, i, a.commitment, b.commitment, a.cell, b.cell);
    turns.push({ a: a.side, b: b.side });
  }
  return { matchId: `${matchId}`, chainId: 84532, escrow: ESCROW, key1: K1.address, key2: K2.address, referee: REF.address, bestOf, turns };
}

const P1_WINS = [0, 24, 1, 20, 2, 14, 0, 24, 1, 20, 2, 14];
const P2_WINS = [24, 0, 20, 1, 14, 2, 24, 0, 20, 1, 14, 2];

test("a genuine best-of-3 log verifies and decides the match", async () => {
  const v = await verifyJinxLog(await buildLog(P1_WINS));
  assert.deepEqual(v.errors, []);
  assert.equal(v.result, 1);
  assert.deepEqual(v.match.wins, [2, 0]);
  const w = await verifyJinxLog(await buildLog(P2_WINS));
  assert.equal(w.result, 2);
});

test("the claimed result and final hash are checked against the replay", async () => {
  const log = await buildLog(P1_WINS);
  const v = await verifyJinxLog(log);
  assert.equal((await verifyJinxLog({ ...log, result: 1, finalHash: v.head })).ok, true);
  assert.match((await verifyJinxLog({ ...log, result: 2, finalHash: v.head })).errors.join(), /claimed result/);
  assert.match((await verifyJinxLog({ ...log, result: 1, finalHash: ZERO32 })).errors.join(), /finalHash/);
});

test("a double forfeit abandons the match and refunds", async () => {
  const log = await buildLog([NO_PICK, NO_PICK, NO_PICK, NO_PICK]);
  const v = await verifyJinxLog(log);
  assert.deepEqual(v.errors, []);
  assert.equal(v.result, 3);
});

test("forfeits decide games; a miss voided by a receipt is rejected", async () => {
  const log = await buildLog([NO_PICK, 24, NO_PICK, 20, NO_PICK, 24, NO_PICK, 20]);
  assert.equal((await verifyJinxLog(log)).result, 2);
  const voided = await verifyJinxLog(log, new Set([0])); // slot 0 = turn 0, side 1
  assert.equal(voided.ok, false);
  assert.match(voided.errors.join(), /voided/);
});

test("tampering is detected", async () => {
  const good = await buildLog(P1_WINS);

  const wrongCell = structuredClone(good);
  wrongCell.turns[0].a.cell = 7;
  assert.match((await verifyJinxLog(wrongCell)).errors.join(), /bad commitment signature/);

  const swapped = structuredClone(good);
  [swapped.turns[0], swapped.turns[1]] = [swapped.turns[1], swapped.turns[0]];
  assert.equal((await verifyJinxLog(swapped)).ok, false);

  const wrongKey = structuredClone(good);
  wrongKey.turns[1].b.commitSig = good.turns[1].a.commitSig;
  assert.match((await verifyJinxLog(wrongKey)).errors.join(), /bad commitment signature/);

  const truncated = structuredClone(good);
  truncated.turns = truncated.turns.slice(0, 4);
  assert.match((await verifyJinxLog(truncated)).errors.join(), /does not end in a decided match/);

  const extra = await buildLog([...P1_WINS, 5, 6]);
  assert.match((await verifyJinxLog(extra)).errors.join(), /after the match was decided/);

  const lateReceipt = structuredClone(good);
  const t = lateReceipt.turns[0].a;
  t.recvMs = `${BigInt(t.openedMs) + 13_000n}`;
  assert.match((await verifyJinxLog(lateReceipt)).errors.join(), /receipt outside the clock/);

  const early = await buildLog([NO_PICK, 24, NO_PICK, 20, NO_PICK, 24, NO_PICK, 20]);
  early.turns[0].a.atMs = `${BigInt(early.turns[0].a.openedMs) + 5_000n}`;
  assert.match((await verifyJinxLog(early)).errors.join(), /before the clock ran out/);
});
