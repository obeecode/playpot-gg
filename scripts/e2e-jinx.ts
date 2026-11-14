// End-to-end JINX on a local anvil chain: real WebSocket players, the real referee server (with a controllable clock)
// and the real JinxEscrow contract. Includes the cross-check that logs signed in TypeScript replay on-chain.
// Usage: (cd contracts && forge build) && node scripts/e2e-jinx.ts
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { createPublicClient, createTestClient, createWalletClient, http, keccak256, toHex, type Address, type Hex, type LocalAccount } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  commitmentOf,
  jinxChain,
  jinxDomain,
  jinxEscrowAbi,
  jinxEscrowV2Abi,
  jinxGenesis,
  NO_PICK,
  signCommit,
  signJinxResult,
  signMiss,
  signReceipt,
  testTokenAbi,
  toContractTurns,
  verifyJinxLog,
  ZERO32,
  type JinxMatchLog,
  type JinxSide,
  type JinxTurnLog,
} from "@playpot/game";
import { startServer } from "../packages/server/src/main.ts";
import { deployContracts, deployJinx, deployJinxV2 } from "./lib.ts";

// --v2 (or E2E_V2=1) runs every scenario against JinxEscrowV2 (one flat rake tier, so the arithmetic below is unchanged).
const V2 = process.argv.includes("--v2") || process.env.E2E_V2 === "1";

const PORT = 18547;
const RPC = `http://127.0.0.1:${PORT}`;
const KEYS = {
  deployer: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  referee: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  alice: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  bob: "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
} as const;
const TREASURY: Address = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const STAKE = 100_000_000n;
const BOND = 5_000_000n;
const WINDOW = 1800;
const RAKE_BPS = 300n;
const POT = STAKE * 2n;
const RAKE = (POT * RAKE_BPS) / 10_000n;

const log = (s: string) => console.log(`\n== ${s}`);
const ok = (s: string) => console.log(`   ok  ${s}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (what: string, cond: () => boolean, ms = 10_000) => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(15);
  }
};

let fake = 1_000_000; // the referee's clock in this run

// -------------------------------------------------------------------------------------- a simulated browser client

interface Receipt {
  turn: number;
  side: 1 | 2;
  commitment: Hex;
  openedMs: string;
  recvMs: string;
  refSig: Hex;
}

class Player {
  readonly name: string;
  readonly side: 1 | 2;
  readonly session: LocalAccount = privateKeyToAccount(generatePrivateKey());
  readonly matchId: bigint;
  readonly domain: ReturnType<typeof jinxDomain>;
  readonly picks: Array<number | null | undefined>;
  readonly signResult: boolean;
  ws!: WebSocket;
  entries: JinxTurnLog[] = [];
  head: Hex;
  receipts = new Map<number, Receipt>();
  pending = new Map<number, { cell: number; salt: Hex }>();
  committedTurns = new Set<number>();
  openedTurns = new Set<number>();
  ended?: { result: number; finalHash: Hex; refSig: Hex };
  settled?: { tx: Hex; mode: string };
  errors: string[] = [];
  base: Omit<JinxMatchLog, "turns">;

  constructor(
    name: string,
    side: 1 | 2,
    matchId: bigint,
    domain: ReturnType<typeof jinxDomain>,
    base: Omit<JinxMatchLog, "turns">,
    picks: Array<number | null | undefined>,
    signResult = true,
  ) {
    this.name = name;
    this.side = side;
    this.matchId = matchId;
    this.domain = domain;
    this.base = base;
    this.picks = picks;
    this.signResult = signResult;
    this.head = jinxGenesis(matchId);
  }

  async connect(url: string) {
    this.ws = new WebSocket(url);
    this.ws.on("message", (raw) => void this.onMessage(JSON.parse(raw.toString())));
    await new Promise((r) => this.ws.once("open", r));
    this.ws.send(JSON.stringify({ type: "jinx-join", matchId: this.matchId.toString(), side: this.side }));
  }

  private send(m: unknown) {
    this.ws.send(JSON.stringify(m));
  }

  private advanceHead(turn: number, entry: JinxTurnLog) {
    const one = (s: JinxSide) =>
      s.missed
        ? { commitment: s.missKind === 1 ? s.commitment : ZERO32, cell: NO_PICK }
        : { commitment: commitmentOf(this.matchId, turn, s.cell, s.salt), cell: s.cell };
    const a = one(entry.a);
    const b = one(entry.b);
    this.head = jinxChain(this.head, turn, a.commitment, b.commitment, a.cell, b.cell);
  }

  /** After a reconnect the referee sends the whole log so far: rebuild our copy and chain head from it. */
  private resync(log: JinxMatchLog) {
    this.entries = log.turns.slice();
    this.head = jinxGenesis(this.matchId);
    this.entries.forEach((e, t) => this.advanceHead(t, e));
  }

  private async onMessage(msg: any) {
    if (process.env.DEBUG) console.log(`      [${this.name}] ${msg.type}${msg.event ? ":" + msg.event.type + (msg.event.turn !== undefined ? "#" + msg.event.turn : "") : ""}${msg.type === "error" ? " " + String(msg.message).slice(0, 150) : ""}`);
    try {
      if (msg.type === "error") this.errors.push(msg.message);
      else if (msg.type === "jinx-state") this.resync(msg.log);
      else if (msg.type === "jinx-settled") this.settled = { tx: msg.tx, mode: msg.mode };
      else if (msg.type === "jinx-event") await this.onEvent(msg.event);
    } catch (e) {
      this.errors.push(`${this.name}: ${(e as Error).message}`);
    }
  }

  private async onEvent(ev: any) {
    if (ev.type === "open") {
      this.openedTurns.add(ev.turn);
      const cell = this.picks[ev.turn];
      if (cell === null || cell === undefined) return;
      const salt = keccak256(toHex(`${this.name}-${ev.turn}-${Math.random()}`));
      const commitment = commitmentOf(this.matchId, ev.turn, cell, salt);
      const prevHash = this.head;
      const sig = await signCommit(this.session, this.domain, { matchId: this.matchId, turn: ev.turn, commitment, prevHash });
      this.pending.set(ev.turn, { cell, salt });
      this.committedTurns.add(ev.turn);
      this.send({ type: "jinx-commit", matchId: this.matchId.toString(), turn: ev.turn, commitment, sig });
    } else if (ev.type === "receipt") {
      this.receipts.set(ev.receipt.turn, ev.receipt);
    } else if (ev.type === "reveal-now") {
      const p = this.pending.get(ev.turn);
      if (p) this.send({ type: "jinx-reveal", matchId: this.matchId.toString(), turn: ev.turn, cell: p.cell, salt: p.salt });
    } else if (ev.type === "turn") {
      this.advanceHead(ev.turn, ev.entry);
      this.entries.push(ev.entry);
    } else if (ev.type === "end") {
      this.ended = { result: ev.result, finalHash: ev.finalHash, refSig: ev.refSig };
      // A client only co-signs a result that matches its own replay of the log.
      const v = await verifyJinxLog({ ...this.base, turns: this.entries, result: ev.result, finalHash: ev.finalHash, refSig: ev.refSig });
      if (!v.ok) {
        this.errors.push(`${this.name}: log does not verify: ${v.errors.join("; ")}`);
        return;
      }
      if (this.signResult) {
        const sig = await signJinxResult(this.session, this.domain, { matchId: this.matchId, result: ev.result, finalHash: ev.finalHash });
        this.send({ type: "jinx-result-sig", matchId: this.matchId.toString(), side: this.side, result: ev.result, sig });
      }
    }
  }
}

// ------------------------------------------------------------------------------------------------------- main

async function startAnvil(): Promise<ChildProcess> {
  const p = spawn(process.env.ANVIL ?? "anvil", ["--port", String(PORT), "--silent"], { stdio: "ignore" });
  const pub = createPublicClient({ transport: http(RPC) });
  for (let i = 0; i < 50; i++) {
    try {
      await pub.getChainId();
      return p;
    } catch {
      await sleep(100);
    }
  }
  p.kill();
  throw new Error("anvil did not start");
}

const anvil = await startAnvil();
let exitCode = 0;
let server: Awaited<ReturnType<typeof startServer>> | undefined;
const players: Player[] = [];
try {
  const pub = createPublicClient({ transport: http(RPC) });
  const testClient = createTestClient({ mode: "anvil", transport: http(RPC) });
  const chainId = await pub.getChainId();
  const wallets = Object.fromEntries(Object.entries(KEYS).map(([k, v]) => [k, privateKeyToAccount(v as Hex)])) as Record<keyof typeof KEYS, LocalAccount>;
  const wc = (a: LocalAccount) => createWalletClient({ account: a, transport: http(RPC) });
  const send = async (hash: Promise<Hex>) => pub.waitForTransactionReceipt({ hash: await hash });

  log("deploy");
  const { token, escrow } = await deployContracts({ rpc: RPC, deployerPk: KEYS.deployer, referee: wallets.referee.address, treasury: TREASURY, bond: BOND });
  const jinxEscrow = V2
    ? await deployJinxV2({
        rpc: RPC,
        deployerPk: KEYS.deployer,
        refereePk: KEYS.referee,
        treasury: TREASURY,
        bond: BOND,
        token,
        challengeWindow: WINDOW,
        rakeFloors: [0n],
        rakeBpsTiers: [Number(RAKE_BPS)],
        bondFloor: STAKE,
        refereeBond: STAKE * 3n,
      })
    : await deployJinx({ rpc: RPC, deployerPk: KEYS.deployer, referee: wallets.referee.address, treasury: TREASURY, bond: BOND, token, challengeWindow: WINDOW, rakeBps: Number(RAKE_BPS) });
  const abi = V2 ? jinxEscrowV2Abi : jinxEscrowAbi;
  ok(`token ${token}`);
  ok(`jinx escrow ${jinxEscrow}`);
  const domain = jinxDomain(chainId, jinxEscrow);

  const read = <T,>(fn: string, args: unknown[] = []) =>
    pub.readContract({ address: jinxEscrow, abi, functionName: fn as never, args: args as never } as never) as Promise<T>;
  const write = (a: LocalAccount, fn: string, args: unknown[]) =>
    send(wc(a).writeContract({ chain: null, address: jinxEscrow, abi, functionName: fn as never, args: args as never } as never));
  const claimable = (who: Address) => read<bigint>("claimable", [who]);
  const getMatch = (id: bigint) => read<{ status: number; bestLen: number; bestResult: number }>("getMatch", [id]);

  for (const a of [wallets.alice, wallets.bob]) {
    await send(wc(a).writeContract({ chain: null, address: token, abi: testTokenAbi, functionName: "mint", args: [a.address, 10_000_000_000n] }));
    await send(wc(a).writeContract({ chain: null, address: token, abi: testTokenAbi, functionName: "approve", args: [jinxEscrow, 2n ** 256n - 1n] }));
  }

  const dataDir = mkdtempSync(join(tmpdir(), "playpot-jinx-"));
  const serverConfig = {
    rpcUrl: RPC,
    escrow,
    jinxEscrow,
    refereePk: KEYS.referee as Hex,
    port: 0,
    dataDir,
    resultWaitMs: 1500,
    clock: () => fake,
    jinxRoom: { startDelayMs: 0, turnGapMs: 0, gameGapMs: 0, revealMs: 4000 },
  };
  server = await startServer(serverConfig);
  let wsUrl = `ws://127.0.0.1:${server.port}`;
  let httpUrl = `http://127.0.0.1:${server.port}`;
  ok(`referee on :${server.port}`);
  const cfg = (await (await fetch(`${httpUrl}/config`)).json()) as { jinx?: { escrow: Address } };
  assert.equal(cfg.jinx?.escrow.toLowerCase(), jinxEscrow.toLowerCase());
  ok("server advertises the JINX escrow");

  async function newMatch(bestOf: 3 | 5, picks1: Array<number | null>, picks2: Array<number | null>, sign1 = true, sign2 = true) {
    const id = await read<bigint>("nextId");
    const k1 = privateKeyToAccount(generatePrivateKey());
    const k2 = privateKeyToAccount(generatePrivateKey());
    await write(wallets.alice, "createOffer", [STAKE, BigInt(Math.floor(Date.now() / 1000) + 86_400), k1.address, bestOf]);
    await write(wallets.bob, "challenge", [id, k2.address]);
    const base = { matchId: id.toString(), chainId, escrow: jinxEscrow, key1: k1.address, key2: k2.address, referee: wallets.referee.address, bestOf } as const;
    const p1 = new Player("alice", 1, id, domain, base, picks1, sign1);
    const p2 = new Player("bob", 2, id, domain, base, picks2, sign2);
    // The players use the keys registered on-chain.
    (p1 as { session: LocalAccount }).session = k1;
    (p2 as { session: LocalAccount }).session = k2;
    players.push(p1, p2);
    await p1.connect(wsUrl);
    await p2.connect(wsUrl);
    return { id, p1, p2, k1, k2 };
  }
  const fetchLog = async (id: bigint) => (await (await fetch(`${httpUrl}/jinx-log/${id}`)).json()) as JinxMatchLog;
  const noErrors = (...ps: Player[]) => ps.forEach((p) => assert.deepEqual(p.errors, [], `${p.name} errors`));

  const P1_WINS = [0, 1, 2, 0, 1, 2];
  const P2_PICKS = [24, 20, 14, 24, 20, 14];

  // ---------------------------------------------------------------------------------------------- A
  log("A. a full best-of-3 played through the referee; everyone signs, payout is instant");
  {
    const { id, p1, p2 } = await newMatch(3, P1_WINS, P2_PICKS);
    await until("both players to see the end", () => !!p1.ended && !!p2.ended);
    assert.equal(p1.ended!.result, 1);
    assert.equal(p1.entries.length, 6);
    await until("instant settlement", () => !!p1.settled);
    assert.equal(p1.settled!.mode, "instant");
    assert.equal(await claimable(wallets.alice.address), POT - RAKE);
    ok("alice credited the pot minus rake, immediately");
    const served = await fetchLog(id);
    const v = await verifyJinxLog(served);
    assert.deepEqual(v.errors, []);
    ok("the published log re-verifies independently (signatures, receipts, hash chain, rules)");
    noErrors(p1, p2);
  }

  // ---------------------------------------------------------------------------------------------- B
  log("B. silent loser: only the winner signs, so the challenge window applies");
  {
    const { id, p1, p2 } = await newMatch(3, P1_WINS, P2_PICKS, true, false);
    await until("settlement", () => !!p1.settled);
    assert.equal(p1.settled!.mode, "window");
    assert.equal((await getMatch(id)).status, 2);
    await testClient.increaseTime({ seconds: WINDOW + 1 });
    await testClient.mine({ blocks: 1 });
    const before = await claimable(wallets.alice.address);
    await write(wallets.bob, "finalize", [id]);
    assert.equal((await claimable(wallets.alice.address)) - before, POT - RAKE);
    ok("alice paid after the window with bob silent");
    noErrors(p1, p2);
  }

  // ---------------------------------------------------------------------------------------------- C
  log("C. a false miss: the referee and bob claim alice missed; her own receipts void it and the replay settles it");
  {
    // Real play: alice wins 2-0. Nobody signs, so we have time to attack before the server settles.
    const { id, p1, p2, k2 } = await newMatch(3, P1_WINS, P2_PICKS, false, false);
    await until("the match to end", () => !!p1.ended && !!p2.ended);
    assert.equal(p1.ended!.result, 1);
    const real = await fetchLog(id);

    // The dishonest log: alice's genuine picks at turns 0 and 1, then referee-signed "no commitment" misses for her at
    // turns 2-5, which forfeit both games to bob. Bob re-signs his own picks over the altered history.
    const open = (t: number) => BigInt(100_000 + t * 20_000);
    const turns: JinxTurnLog[] = [real.turns[0], real.turns[1]];
    let head = jinxGenesis(id);
    for (let t = 0; t < 2; t++) {
      const one = (s: JinxSide) => commitmentOf(id, t, s.cell, s.salt);
      head = jinxChain(head, t, one(real.turns[t].a), one(real.turns[t].b), real.turns[t].a.cell, real.turns[t].b.cell);
    }
    const bobCells = [14, 7, 24, 20];
    for (let t = 2; t < 6; t++) {
      const openedMs = open(t);
      const atMs = openedMs + 10_000n;
      const aSig = await signMiss(wallets.referee, domain, { matchId: id, turn: t, side: 1, kind: 0, commitment: ZERO32, openedMs, atMs });
      const a: JinxSide = { missed: true, missKind: 0, cell: 0, salt: ZERO32, commitment: ZERO32, openedMs: `${openedMs}`, recvMs: "0", atMs: `${atMs}`, commitSig: "0x", refSig: aSig };
      const cell = bobCells[t - 2];
      const salt = keccak256(toHex(`bob-fake-${t}`));
      const commitment = commitmentOf(id, t, cell, salt);
      const recvMs = openedMs + 2_000n;
      const commitSig = await signCommit(k2, domain, { matchId: id, turn: t, commitment, prevHash: head });
      const refSig = await signReceipt(wallets.referee, domain, { matchId: id, turn: t, side: 2, commitment, openedMs, recvMs });
      const b: JinxSide = { missed: false, missKind: 0, cell, salt, commitment: ZERO32, openedMs: `${openedMs}`, recvMs: `${recvMs}`, atMs: "0", commitSig, refSig };
      turns.push({ a, b });
      head = jinxChain(head, t, ZERO32, commitment, NO_PICK, cell);
    }
    const fake2: JinxMatchLog = { ...real, turns, result: 2, finalHash: head, refSig: undefined, sig1: undefined, sig2: undefined };
    const fv = await verifyJinxLog(fake2);
    assert.deepEqual(fv.errors, []);
    assert.equal(fv.result, 2);
    ok("the dishonest log is internally valid (it needs only the referee and bob)");

    // Referee + bob propose that bob won.
    const resSig2 = await signJinxResult(k2, domain, { matchId: id, result: 2, finalHash: head });
    const resSigRef = await signJinxResult(wallets.referee, domain, { matchId: id, result: 2, finalHash: head });
    await write(wallets.bob, "settle", [id, 2, head, "0x", resSig2, resSigRef]);
    assert.equal((await getMatch(id)).status, 2);
    ok("the fake proposal is accepted into the challenge window");

    await write(wallets.alice, "dispute", [id]);
    await write(wallets.bob, "submitReplay", [id, toContractTurns(fake2)]);
    let m = await getMatch(id);
    assert.equal(m.bestResult, 2);
    await write(wallets.alice, "submitReplay", [id, toContractTurns(real)]);
    m = await getMatch(id);
    assert.equal(m.bestResult, 2, "an equal-length honest log does not displace the first one");
    ok("on-chain replay accepted the TypeScript-signed logs, and the dishonest one is leading");

    // Alice holds the referee's own signed receipt for her pick at turn 2.
    const r = p1.receipts.get(2)!;
    assert.ok(r, "alice kept her receipt");
    const aliceBeforeVoid = await claimable(wallets.alice.address);
    await write(wallets.alice, "voidMiss", [id, 2, 1, r.commitment, BigInt(r.openedMs), BigInt(r.recvMs), r.refSig]);
    if (V2) {
      assert.equal((await claimable(wallets.alice.address)) - aliceBeforeVoid, STAKE, "the referee's collateral is slashed to alice");
      ok("the referee signed a miss and a receipt for the same pick, so one stake of its collateral went to alice");
    }
    m = await getMatch(id);
    assert.equal(m.bestLen, 0);
    ok("her receipt voided the false miss and cleared the dishonest log");
    await assert.rejects(write(wallets.bob, "submitReplay", [id, toContractTurns(fake2)]), "the voided miss cannot be replayed");
    await write(wallets.alice, "submitReplay", [id, toContractTurns(real)]);
    assert.equal((await getMatch(id)).bestResult, 1);

    await testClient.increaseTime({ seconds: WINDOW + 1 });
    await testClient.mine({ blocks: 1 });
    const before = await claimable(wallets.alice.address);
    await write(wallets.alice, "finalizeDispute", [id]);
    assert.equal((await claimable(wallets.alice.address)) - before, POT - RAKE + BOND);
    assert.equal(await claimable(wallets.bob.address), 0n);
    ok("alice is paid the real winnings and gets her dispute bond back");
  }

  // ---------------------------------------------------------------------------------------------- D
  log("D. the referee's clock: bob never commits, so he is called as missing and forfeits both games");
  {
    const { id, p1, p2 } = await newMatch(3, [0, 1, 0, 1], []);
    for (let t = 0; t < 4; t++) {
      await until(`the referee to receipt alice's commitment for turn ${t}`, () => p1.receipts.has(t));
      fake += 12_000; // run out the clock for bob
      await until(`turn ${t} to resolve`, () => p1.entries.length > t);
    }
    await until("the match to end", () => !!p1.ended && !!p2.ended);
    assert.equal(p1.ended!.result, 1);
    const served = await fetchLog(id);
    assert.equal(served.turns[0].b.missed, true);
    assert.equal(served.turns[0].b.missKind, 0);
    assert.deepEqual((await verifyJinxLog(served)).errors, []);
    await until("settlement", () => !!p1.settled);
    ok("called as missing only after the clock plus grace; alice won on forfeits and was paid");
    noErrors(p1, p2);
  }

  // ---------------------------------------------------------------------------------------------- E
  log("E. both players stop picking: the match is abandoned and both stakes are refunded");
  {
    const { id, p1, p2 } = await newMatch(3, [], []);
    for (let t = 0; t < 2; t++) {
      await until(`turn ${t} to open`, () => p1.openedTurns.has(t));
      fake += 12_000;
      await until(`turn ${t} to resolve`, () => p1.entries.length > t);
    }
    await until("the end", () => !!p1.ended && !!p2.ended);
    assert.equal(p1.ended!.result, 3);
    await until("settlement", () => !!p1.settled);
    const a = await claimable(wallets.alice.address);
    ok(`refunded (alice's credit is now ${a})`);
    assert.equal((await getMatch(id)).status, 4);
    noErrors(p1, p2);
  }

  // ---------------------------------------------------------------------------------------------- F
  log("F. the referee restarts in the middle of a match: both players reconnect and the match carries on from its saved log");
  {
    // Bob stalls from turn 3 on, so the match waits there while we restart the server.
    const { id, p1, p2 } = await newMatch(3, P1_WINS, [24, 20, 14]);
    await until("three turns to resolve", () => p1.entries.length === 3 && p2.entries.length === 3);
    await until("alice's turn-3 pick to be received", () => p1.receipts.has(3));
    const savedTurns = (await fetchLog(id)).turns.length;
    assert.equal(savedTurns, 3);
    p1.ws.close();
    p2.ws.close();
    await server!.close();
    ok("the referee is down, mid-turn, with a pick already committed");

    server = await startServer(serverConfig);
    wsUrl = `ws://127.0.0.1:${server.port}`;
    httpUrl = `http://127.0.0.1:${server.port}`;
    assert.equal((await fetchLog(id)).turns.length, 3, "the new server serves the saved log before anyone reconnects");
    for (let t = 3; t < 6; t++) p2.picks[t] = P2_PICKS[t]; // bob is back
    await p1.connect(wsUrl);
    await p2.connect(wsUrl);
    await until("both players to see the end", () => !!p1.ended && !!p2.ended, 20_000);
    assert.equal(p1.ended!.result, 1);
    assert.equal(p1.entries.length, 6);
    await until("instant settlement", () => !!p1.settled, 20_000);
    assert.equal(p1.settled!.mode, "instant");
    const served = await fetchLog(id);
    assert.deepEqual((await verifyJinxLog(served)).errors, []);
    ok("the match resumed after the restart, finished, verified and settled instantly");
    noErrors(p1, p2);
  }

  const held = (await pub.readContract({ address: token, abi: testTokenAbi, functionName: "balanceOf", args: [jinxEscrow] })) as bigint;
  const collateral = V2 ? await read<bigint>("totalRefereeBond") : 0n;
  const owed = (await claimable(wallets.alice.address)) + (await claimable(wallets.bob.address)) + (await claimable(TREASURY)) + collateral;
  assert.equal(held, owed, "escrow holds exactly what is owed (plus the referee's collateral on v2)");
  ok(`escrow balance ${held} equals all unclaimed credits`);
  log("ALL JINX SCENARIOS PASSED");
} catch (e) {
  console.error("\nFAILED:", e);
  for (const p of players) if (p.errors.length) console.error(`${p.name} errors:`, p.errors);
  exitCode = 1;
} finally {
  players.forEach((p) => p.ws?.close());
  await server?.close();
  anvil.kill();
  process.exit(exitCode);
}
