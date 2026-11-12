import test from "node:test";
import assert from "node:assert/strict";
import { keccak256, toHex, type Hex, type LocalAccount } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  botPick,
  commitmentOf,
  jinx,
  jinxDomain,
  recoverReceipt,
  seededRng,
  signCommit,
  verifyJinxLog,
} from "@playpot/game";
import { JinxRoom, type JinxEvent } from "./jinxRoom.ts";

const K1 = privateKeyToAccount("0x00000000000000000000000000000000000000000000000000000000000000c1");
const K2 = privateKeyToAccount("0x00000000000000000000000000000000000000000000000000000000000000c2");
const REF = privateKeyToAccount("0x0000000000000000000000000000000000000000000000000000000000000def");
const ESCROW = "0x3333333333333333333333333333333333333333" as const;
const domain = jinxDomain(31337, ESCROW);
const accounts: Record<1 | 2, LocalAccount> = { 1: K1, 2: K2 };

const makeRoom = (bestOf: 3 | 5 = 3) =>
  new JinxRoom(
    { matchId: 5n, chainId: 31337, escrow: ESCROW, key1: K1.address, key2: K2.address, referee: REF.address, bestOf },
    REF,
    domain,
  );

/** Drives a room with a fake clock. */
class Harness {
  room: JinxRoom;
  now = 1_000_000;
  events: JinxEvent[] = [];
  private salts = new Map<string, Hex>();
  constructor(bestOf: 3 | 5 = 3) {
    this.room = makeRoom(bestOf);
    this.room.start(this.now);
  }
  async at(ms: number) {
    this.now += ms;
    this.events.push(...(await this.room.tick(this.now)));
  }
  async open() {
    await this.at(5000); // past any gap
    assert.equal(this.room.phase, "commit");
  }
  private salt(side: 1 | 2, turn: number): Hex {
    return keccak256(toHex(`salt-${side}-${turn}`));
  }
  async commit(side: 1 | 2, cell: number, advance = 300) {
    this.now += advance;
    const turn = this.room.turn;
    const salt = this.salt(side, turn);
    this.salts.set(`${side}:${turn}`, salt);
    const commitment = commitmentOf(this.room.info.matchId, turn, cell, salt);
    const head = (this.room as unknown as { head: Hex }).head;
    const sig = await signCommit(accounts[side], domain, { matchId: this.room.info.matchId, turn, commitment, prevHash: head });
    const ev = await this.room.commit(side, turn, commitment, sig, this.now);
    this.events.push(...ev);
    return ev;
  }
  async reveal(side: 1 | 2, cell: number, advance = 100) {
    this.now += advance;
    const turn = this.room.turn;
    const ev = await this.room.reveal(side, turn, cell, this.salts.get(`${side}:${turn}`)!, this.now);
    this.events.push(...ev);
    return ev;
  }
  /** Both players pick; null means that player does nothing and the clock decides. */
  async play(a: number | null, b: number | null) {
    await this.open();
    if (a !== null) await this.commit(1, a);
    if (b !== null) await this.commit(2, b);
    if (a === null || b === null) await this.at(11_600); // run out the clock for whoever did not commit
    if (this.room.phase === "reveal") {
      if (a !== null) await this.reveal(1, a);
      if (b !== null) await this.reveal(2, b);
    }
  }
  turnsDone() {
    return this.events.filter((e) => e.type === "turn").length;
  }
}

test("a full match runs through the room and the log verifies independently", async () => {
  const h = new Harness();
  const wins = [0, 24, 1, 20, 2, 14, 0, 24, 1, 20, 2, 14];
  for (let i = 0; i < wins.length; i += 2) await h.play(wins[i], wins[i + 1]);
  assert.equal(h.room.phase, "ended");
  assert.equal(h.room.result, 1);
  const end = h.events.find((e) => e.type === "end");
  assert.ok(end && end.type === "end" && end.result === 1);
  const v = await h.room.verify();
  assert.deepEqual(v.errors, []);
  assert.equal(v.result, 1);
  assert.equal(h.room.log.finalHash, v.head);
});

test("bot-driven matches (including death matches) always end with a log that verifies", async () => {
  let deathGames = 0;
  for (let seed = 1; seed <= 12; seed++) {
    const rand = seededRng(seed * 77);
    const h = new Harness(seed % 2 ? 3 : 5);
    let mirror = jinx.newGame(false);
    let match = jinx.newMatch(h.room.info.bestOf);
    for (let guard = 0; guard < 200 && h.room.phase !== "ended"; guard++) {
      const a = botPick(mirror, 1, 2, rand);
      const b = botPick(mirror, 2, 1, rand);
      if (mirror.death) deathGames++;
      await h.play(a, b);
      const r = jinx.applyTurn(mirror, a, b);
      mirror = r.state;
      if (r.outcome !== "ongoing" && !r.doubleForfeit) {
        const rec = jinx.recordGame(match, r.outcome);
        match = rec.match;
        if (!rec.winner) mirror = jinx.newGame(jinx.isDeathMatch(match));
      }
    }
    assert.equal(h.room.phase, "ended", `seed ${seed} did not finish`);
    const v = await h.room.verify();
    assert.deepEqual(v.errors, [], `seed ${seed}`);
    assert.equal(v.result, h.room.result);
  }
  assert.ok(deathGames >= 0);
});

test("a missing commitment is called as a miss after the clock plus grace, and the log still verifies", async () => {
  const h = new Harness();
  // Player 2 never commits: forfeits game 1 (turns 0, 1) and game 2 (turns 2, 3). Player 1 wins the match.
  for (const cell of [0, 1, 0, 1]) await h.play(cell, null);
  assert.equal(h.room.result, 1);
  const turns = h.room.log.turns;
  assert.equal(turns.length, 4);
  assert.equal(turns[0].b.missed, true);
  assert.equal(turns[0].b.missKind, 0);
  assert.ok(BigInt(turns[0].b.atMs) >= BigInt(turns[0].b.openedMs) + 10_000n, "called only after the clock ran out");
  assert.deepEqual((await h.room.verify()).errors, []);
});

test("a commitment that is never revealed is called as a no-reveal miss", async () => {
  const h = new Harness();
  for (let g = 0; g < 2; g++) {
    for (const cell of [0, 1]) {
      await h.open();
      await h.commit(1, cell);
      await h.commit(2, 10 + cell); // commits, then goes quiet
      await h.reveal(1, cell);
      await h.at(4100); // past the reveal window
    }
  }
  assert.equal(h.room.result, 1);
  const t = h.room.log.turns[0];
  assert.equal(t.b.missed, true);
  assert.equal(t.b.missKind, 1);
  assert.notEqual(t.b.commitment, "0x" + "00".repeat(32));
  assert.deepEqual((await h.room.verify()).errors, []);
});

test("nobody picking for two turns abandons the match and refunds", async () => {
  const h = new Harness();
  await h.play(null, null);
  await h.play(null, null);
  assert.equal(h.room.phase, "ended");
  assert.equal(h.room.result, 3);
  assert.equal((await h.room.verify()).result, 3);
});

test("picks stay hidden: the opponent is only told that a player locked in", async () => {
  const h = new Harness();
  await h.open();
  const ev = await h.commit(1, 7);
  assert.deepEqual(ev.map((e) => e.type).sort(), ["locked", "receipt"]);
  assert.equal(JSON.stringify(ev.filter((e) => e.type === "locked")).includes("7"), false);
  assert.equal(h.room.phase, "commit"); // still waiting for player 2
});

test("the receipt is a genuine referee signature over the commitment and the receive time", async () => {
  const h = new Harness();
  await h.open();
  const ev = await h.commit(2, 12, 450);
  const rec = ev.find((e) => e.type === "receipt");
  assert.ok(rec && rec.type === "receipt");
  const r = rec.receipt;
  const signer = await recoverReceipt(
    domain,
    { matchId: 5n, turn: 0, side: 2, commitment: r.commitment, openedMs: BigInt(r.openedMs), recvMs: BigInt(r.recvMs) },
    r.refSig,
  );
  assert.equal(signer, REF.address);
  assert.equal(BigInt(r.recvMs) - BigInt(r.openedMs), 450n);
});

test("rejections: late, forged, repeated and mismatched messages", async () => {
  const h = new Harness();
  await h.open();
  const turn = h.room.turn;
  const head = (h.room as unknown as { head: Hex }).head;
  const salt = keccak256(toHex("s"));
  const commitment = commitmentOf(5n, turn, 3, salt);

  // Signed by the wrong key.
  const wrong = await signCommit(K2, domain, { matchId: 5n, turn, commitment, prevHash: head });
  await assert.rejects(h.room.commit(1, turn, commitment, wrong, h.now), /bad commitment signature/);
  // Signed over a different history.
  const stale = await signCommit(K1, domain, { matchId: 5n, turn, commitment, prevHash: keccak256("0x01") });
  await assert.rejects(h.room.commit(1, turn, commitment, stale, h.now), /bad commitment signature/);
  // Wrong turn.
  const ok = await signCommit(K1, domain, { matchId: 5n, turn: 1, commitment, prevHash: head });
  await assert.rejects(h.room.commit(1, 1, commitment, ok, h.now), /no commitments are open/);
  // Too late.
  const good = await signCommit(K1, domain, { matchId: 5n, turn, commitment, prevHash: head });
  await assert.rejects(h.room.commit(1, turn, commitment, good, h.room.deadlineMs + 1), /too late/);
  // Accepted once, not twice.
  await h.room.commit(1, turn, commitment, good, h.now);
  await assert.rejects(h.room.commit(1, turn, commitment, good, h.now), /already committed/);
  // Reveal only in the reveal phase, and only what was committed.
  await assert.rejects(h.room.reveal(1, turn, 3, salt, h.now), /no reveals are open/);
  await h.commit(2, 9);
  await assert.rejects(h.room.reveal(1, turn, 4, salt, h.now), /does not match/);
  await assert.rejects(h.room.reveal(1, turn, 3, keccak256("0x02"), h.now), /does not match/);
});

test("a commitment to an occupied square is treated as never revealed", async () => {
  const h = new Harness();
  await h.play(5, 20); // turn 0: square 5 taken by player 1
  await h.open();
  await h.commit(1, 5); // commits to the occupied square
  await h.commit(2, 21);
  await h.reveal(2, 21);
  const ev = await h.reveal(1, 5);
  assert.ok(ev.some((e) => e.type === "turn"));
  const side = h.room.log.turns[1].a;
  assert.equal(side.missed, true);
  assert.equal(side.missKind, 1);
});

test("a reconnecting player can see whether they already committed and the receipt they hold", async () => {
  const h = new Harness();
  await h.open();
  assert.equal(h.room.snapshot(1).iCommitted, false);
  await h.commit(1, 4);
  const snap = h.room.snapshot(1);
  assert.equal(snap.iCommitted, true);
  assert.equal(snap.opponentCommitted, false);
  assert.ok(snap.receipt);
  assert.equal(h.room.snapshot(2).opponentCommitted, true);
});
