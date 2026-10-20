import test from "node:test";
import assert from "node:assert/strict";
import { privateKeyToAccount } from "viem/accounts";
import {
  applyMove,
  chainHash,
  DRAW,
  eip712Domain,
  genesisHash,
  initialBoard,
  ONGOING,
  P1_WIN,
  P2_WIN,
  replay,
  signEvent,
  signMove,
  signResult,
  verifyLog,
  type Board,
  type LoggedMove,
  type MatchLog,
} from "./index.ts";

test("exhaustive game count matches the known totals", () => {
  const tally = { [P1_WIN]: 0, [P2_WIN]: 0, [DRAW]: 0, total: 0 };
  const walk = (b: Board) => {
    for (let c = 0; c < 9; c++) {
      if ((b.x | b.o) & (1 << c)) continue;
      const { board, outcome } = applyMove(b, c);
      if (outcome === ONGOING) walk(board);
      else {
        tally[outcome]++;
        tally.total++;
      }
    }
  };
  walk(initialBoard());
  assert.deepEqual(tally, { [P1_WIN]: 131184, [P2_WIN]: 77904, [DRAW]: 46080, total: 255168 });
});

test("illegal moves are rejected", () => {
  assert.throws(() => replay([4, 4]), /occupied/);
  assert.throws(() => replay([9]), /range/);
  assert.throws(() => replay([0, 3, 1, 4, 2, 5]), /after game end/);
});

test("fixture games end as the contract tests expect", () => {
  assert.equal(replay([0, 3, 1, 4, 2]).outcome, P1_WIN);
  assert.equal(replay([0, 3, 1, 4, 8, 5]).outcome, P2_WIN);
  assert.equal(replay([0, 1, 2, 4, 3, 5, 7, 6, 8]).outcome, DRAW);
});

const K1 = privateKeyToAccount("0x00000000000000000000000000000000000000000000000000000000000000c1");
const K2 = privateKeyToAccount("0x00000000000000000000000000000000000000000000000000000000000000c2");
const REF = privateKeyToAccount("0x0000000000000000000000000000000000000000000000000000000000000def");
const ESCROW = "0x1111111111111111111111111111111111111111" as const;
const domain = eip712Domain(31337, ESCROW);
const matchId = 7n;

async function buildLog(cells: number[]): Promise<MatchLog> {
  let head = genesisHash(matchId);
  const moves: LoggedMove[] = [];
  for (let i = 0; i < cells.length; i++) {
    const acct = i % 2 === 0 ? K1 : K2;
    const sig = await signMove(acct, domain, { matchId, index: i, cell: cells[i], prevHash: head });
    head = chainHash(head, cells[i]);
    const recvMs = BigInt(1_000 + i);
    const serverSig = await signEvent(REF, domain, { matchId, index: i, cell: cells[i], hash: head, recvMs });
    moves.push({ index: i, cell: cells[i], sig, hash: head, recvMs: recvMs.toString(), serverSig });
  }
  const result = replay(cells).outcome;
  const refSig = await signResult(REF, domain, { matchId, result, finalHash: head });
  return {
    matchId: matchId.toString(),
    chainId: 31337,
    escrow: ESCROW,
    key1: K1.address,
    key2: K2.address,
    referee: REF.address,
    moves,
    result,
    finalHash: head,
    refSig,
  };
}

test("a genuine log verifies end to end", async () => {
  const v = await verifyLog(await buildLog([0, 3, 1, 4, 8, 5]));
  assert.deepEqual(v.errors, []);
  assert.equal(v.outcome, P2_WIN);
});

test("tampering is detected", async () => {
  const log = await buildLog([0, 3, 1, 4, 2]);

  const wrongResult = { ...log, result: P2_WIN };
  assert.match((await verifyLog(wrongResult)).errors.join(), /replayed outcome/);

  const swapped = structuredClone(log);
  swapped.moves[2].cell = 5;
  assert.ok((await verifyLog(swapped)).errors.length > 0);

  const wrongSigner = structuredClone(log);
  wrongSigner.moves[1].sig = log.moves[0].sig; // P1's signature on P2's move
  assert.match((await verifyLog(wrongSigner)).errors.join(), /bad player signature/);

  const truncatedClaim = { ...structuredClone(log), moves: log.moves.slice(0, 3) };
  assert.match((await verifyLog(truncatedClaim)).errors.join(), /not finished/);

  const badFinal = { ...log, finalHash: genesisHash(1n) };
  assert.match((await verifyLog(badFinal)).errors.join(), /finalHash/);
});
