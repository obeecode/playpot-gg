// End-to-end run against a local anvil chain: contracts + referee server + two simulated players.
// Usage: (cd contracts && forge build) && node scripts/e2e.ts
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import WebSocket from "ws";
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  http,
  type Address,
  type Hex,
  type LocalAccount,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  chainHash,
  eip712Domain,
  genesisHash,
  potEscrowAbi,
  replayArgs,
  signMove,
  signResult,
  testTokenAbi,
  verifyLog,
  type MatchLog,
  type ServerMsg,
} from "@playpot/game";
import { startServer } from "../packages/server/src/main.ts";

const PORT = 18545;
const RPC = `http://127.0.0.1:${PORT}`;
const KEYS = {
  deployer: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  referee: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  alice: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  bob: "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
} as const;
const TREASURY: Address = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const STAKE = 100_000_000n; // 100 tPUSD
const BOND = 5_000_000n;
const WINDOW = 1800;
const RAKE_BPS = 300n;

const P1_WIN = [0, 3, 1, 4, 2];
const P2_WIN = [0, 3, 1, 4, 8, 5];
const DRAW = [0, 1, 2, 4, 3, 5, 7, 6, 8];

const log = (s: string) => console.log(`\n== ${s}`);
const ok = (s: string) => console.log(`   ok  ${s}`);

function artifact(name: string): { abi: unknown; bytecode: Hex } {
  const path = join("contracts", "out", `${name}.sol`, `${name}.json`);
  const j = JSON.parse(readFileSync(path, "utf8"));
  return { abi: j.abi, bytecode: j.bytecode.object as Hex };
}

async function startAnvil(): Promise<ChildProcess> {
  const bin = process.env.ANVIL ?? "anvil";
  const p = spawn(bin, ["--port", String(PORT), "--silent"], { stdio: "ignore" });
  const pub = createPublicClient({ transport: http(RPC) });
  for (let i = 0; i < 50; i++) {
    try {
      await pub.getChainId();
      return p;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  p.kill();
  throw new Error("anvil did not start (is it on PATH? set ANVIL=/path/to/anvil)");
}

// ------------------------------------------------------------------ a simulated browser client

class Player {
  readonly session: LocalAccount = privateKeyToAccount(generatePrivateKey());
  ws!: WebSocket;
  events: ServerMsg[] = [];
  readonly name: string;
  readonly wallet: LocalAccount;
  readonly serverUrl: string;
  readonly domain: ReturnType<typeof eip712Domain>;
  constructor(name: string, wallet: LocalAccount, serverUrl: string, domain: ReturnType<typeof eip712Domain>) {
    this.name = name;
    this.wallet = wallet;
    this.serverUrl = serverUrl;
    this.domain = domain;
  }

  async connect(matchId: bigint) {
    this.ws = new WebSocket(this.serverUrl);
    this.ws.on("message", (raw) => this.events.push(JSON.parse(raw.toString())));
    await new Promise((r) => this.ws.once("open", r));
    this.ws.send(JSON.stringify({ type: "join", matchId: matchId.toString() }));
    await this.waitFor((m) => m.type === "state");
  }

  async waitFor<T extends ServerMsg["type"]>(pred: (m: ServerMsg) => boolean, ms = 8000): Promise<ServerMsg & { type: T }> {
    const start = Date.now();
    for (;;) {
      const hit = this.events.find(pred);
      if (hit) {
        this.events.splice(this.events.indexOf(hit), 1);
        return hit as ServerMsg & { type: T };
      }
      if (Date.now() - start > ms) throw new Error(`${this.name}: timed out; saw ${JSON.stringify(this.events).slice(0, 300)}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  async sendMove(matchId: bigint, index: number, cell: number, prevHash: Hex) {
    const sig = await signMove(this.session, this.domain, { matchId, index, cell, prevHash });
    this.ws.send(JSON.stringify({ type: "move", matchId: matchId.toString(), index, cell, sig }));
  }

  async signResult(matchId: bigint, side: 1 | 2, result: number, finalHash: Hex) {
    const sig = await signResult(this.session, this.domain, { matchId, result, finalHash });
    this.ws.send(JSON.stringify({ type: "result-sig", matchId: matchId.toString(), side, result, sig }));
  }

  close() {
    this.ws.close();
  }
}

// ------------------------------------------------------------------------------------- main

const anvil = await startAnvil();
let exitCode = 0;
let server: Awaited<ReturnType<typeof startServer>> | undefined;
try {
  const pub = createPublicClient({ transport: http(RPC) });
  const testClient = createTestClient({ mode: "anvil", transport: http(RPC) });
  const chainId = await pub.getChainId();
  const wallets = Object.fromEntries(
    Object.entries(KEYS).map(([k, v]) => [k, privateKeyToAccount(v as Hex)]),
  ) as Record<keyof typeof KEYS, LocalAccount>;
  const wc = (a: LocalAccount) => createWalletClient({ account: a, transport: http(RPC) });
  const send = async (hash: Promise<Hex>) => pub.waitForTransactionReceipt({ hash: await hash });

  log("deploy");
  const tokenArt = artifact("TestToken");
  const escrowArt = artifact("PotEscrow");
  const dep = wc(wallets.deployer);
  const tokenRcpt = await send(dep.deployContract({ chain: null, abi: tokenArt.abi as never, bytecode: tokenArt.bytecode }));
  const token = tokenRcpt.contractAddress!;
  const escrowRcpt = await send(
    dep.deployContract({
      chain: null,
      abi: escrowArt.abi as never,
      bytecode: escrowArt.bytecode,
      args: [token, wallets.referee.address, TREASURY, Number(RAKE_BPS), WINDOW, 3600, 600, BOND] as never,
    }),
  );
  const escrow = escrowRcpt.contractAddress!;
  ok(`token ${token}`);
  ok(`escrow ${escrow}`);
  const domain = eip712Domain(chainId, escrow);

  const read = <T>(fn: string, args: unknown[] = []) =>
    pub.readContract({ address: escrow, abi: potEscrowAbi, functionName: fn as never, args: args as never }) as Promise<T>;
  const write = (a: LocalAccount, fn: string, args: unknown[]) =>
    send(wc(a).writeContract({ chain: null, address: escrow, abi: potEscrowAbi, functionName: fn as never, args: args as never }));
  const balance = (who: Address) =>
    pub.readContract({ address: token, abi: testTokenAbi, functionName: "balanceOf", args: [who] }) as Promise<bigint>;
  const claimable = (who: Address) => read<bigint>("claimable", [who]);

  for (const a of [wallets.alice, wallets.bob]) {
    await send(wc(a).writeContract({ chain: null, address: token, abi: testTokenAbi, functionName: "mint", args: [a.address, 10_000_000_000n] }));
    await send(wc(a).writeContract({ chain: null, address: token, abi: testTokenAbi, functionName: "approve", args: [escrow, 2n ** 256n - 1n] }));
  }

  server = await startServer({
    rpcUrl: RPC,
    escrow,
    refereePk: KEYS.referee,
    port: 0,
    dataDir: mkdtempSync(join(tmpdir(), "playpot-e2e-")),
    resultWaitMs: 1500,
  });
  const serverUrl = `ws://127.0.0.1:${server.port}`;
  ok(`referee ${server.referee} on :${server.port}`);

  async function newMatch(): Promise<{ id: bigint; alice: Player; bob: Player }> {
    const alice = new Player("alice", wallets.alice, serverUrl, domain);
    const bob = new Player("bob", wallets.bob, serverUrl, domain);
    const id = (await read<bigint>("nextId")) as bigint;
    await write(wallets.alice, "createOffer", [STAKE, BigInt(Math.floor(Date.now() / 1000) + 86_400), alice.session.address]);
    await write(wallets.bob, "challenge", [id, bob.session.address]);
    await alice.connect(id);
    await bob.connect(id);
    return { id, alice, bob };
  }

  /** Plays the moves through the referee; every client checks every countersigned event. */
  async function play(id: bigint, alice: Player, bob: Player, cells: number[]) {
    let head = genesisHash(id);
    for (let i = 0; i < cells.length; i++) {
      const mover = i % 2 === 0 ? alice : bob;
      await mover.sendMove(id, i, cells[i], head);
      head = chainHash(head, cells[i]);
      for (const p of [alice, bob]) {
        const ev = (await p.waitFor((m) => m.type === "event")) as Extract<ServerMsg, { type: "event" }>;
        assert.equal(ev.move.hash, head, `${p.name} sees the same chain head`);
      }
    }
    const ends = await Promise.all([alice, bob].map((p) => p.waitFor((m) => m.type === "end")));
    const end = ends[0] as Extract<ServerMsg, { type: "end" }>;
    assert.equal(end.finalHash, head);
    return end;
  }

  const pot = STAKE * 2n;
  const rake = (pot * RAKE_BPS) / 10_000n;

  // ---------------------------------------------------------------------------------- A
  log("A. happy path: both players sign, payout is instant");
  {
    const { id, alice, bob } = await newMatch();
    const end = await play(id, alice, bob, P1_WIN);
    assert.equal(end.result, 1);
    await alice.signResult(id, 1, end.result, end.finalHash);
    await bob.signResult(id, 2, end.result, end.finalHash);
    const settled = (await alice.waitFor((m) => m.type === "settled")) as Extract<ServerMsg, { type: "settled" }>;
    assert.equal(settled.mode, "instant");
    assert.equal(await claimable(wallets.alice.address), pot - rake);
    ok("alice credited pot minus rake, immediately");
    const before = await balance(wallets.alice.address);
    await write(wallets.alice, "claim", []);
    assert.equal((await balance(wallets.alice.address)) - before, pot - rake);
    ok("alice claimed tokens");
    const logJson = (await (await fetch(`http://127.0.0.1:${server.port}/log/${id}`)).json()) as MatchLog;
    const v = await verifyLog(logJson);
    assert.deepEqual(v.errors, []);
    ok("anyone can re-derive the result from the published log");
    alice.close();
    bob.close();
  }

  // ---------------------------------------------------------------------------------- B
  log("B. silent loser: challenge window, then finalize");
  {
    const { id, alice, bob } = await newMatch();
    const end = await play(id, alice, bob, P2_WIN);
    assert.equal(end.result, 2);
    await bob.signResult(id, 2, end.result, end.finalHash); // winner signs, loser (alice) stays silent
    const settled = (await bob.waitFor((m) => m.type === "settled")) as Extract<ServerMsg, { type: "settled" }>;
    assert.equal(settled.mode, "window");
    const m = await read<{ status: number }>("getMatch", [id]);
    assert.equal(m.status, 2, "match is Proposed");
    await assert.rejects(write(wallets.bob, "finalize", [id]), "cannot finalize inside the window");
    const bobBefore = await claimable(wallets.bob.address);
    await testClient.increaseTime({ seconds: WINDOW + 1 });
    await testClient.mine({ blocks: 1 });
    await write(wallets.alice, "finalize", [id]);
    assert.equal((await claimable(wallets.bob.address)) - bobBefore, pot - rake);
    ok("bob paid after the window with alice silent");
    alice.close();
    bob.close();
  }

  // ---------------------------------------------------------------------------------- C
  log("C. fabricated result is overturned by on-chain replay of the players' signed moves");
  {
    const { id, alice, bob } = await newMatch();
    const end = await play(id, alice, bob, P2_WIN); // bob really won
    assert.equal(end.result, 2);
    // Referee key and alice collude and push a fake "alice won" before the honest settlement lands.
    const fakeHash = genesisHash(id);
    const fakeSigAlice = await signResult(alice.session, domain, { matchId: id, result: 1, finalHash: fakeHash });
    const fakeSigRef = await signResult(wallets.referee, domain, { matchId: id, result: 1, finalHash: fakeHash });
    await write(wallets.alice, "settle", [id, 1, fakeHash, fakeSigAlice, "0x", fakeSigRef]);
    assert.equal((await read<{ status: number }>("getMatch", [id])).status, 2);
    ok("fake proposal accepted into the window (alice + referee signed)");

    const bobBefore = await claimable(wallets.bob.address);
    await write(wallets.bob, "dispute", [id]);
    const realLog = (await (await fetch(`http://127.0.0.1:${server.port}/log/${id}`)).json()) as MatchLog;
    const { cells, sigs } = replayArgs(realLog);
    await write(wallets.bob, "submitReplay", [id, cells, sigs]);
    await testClient.increaseTime({ seconds: WINDOW + 1 });
    await testClient.mine({ blocks: 1 });
    await write(wallets.bob, "finalizeDispute", [id]);
    assert.equal((await claimable(wallets.bob.address)) - bobBefore, pot - rake + BOND);
    assert.equal(await claimable(wallets.alice.address), 0n, "the colluding side gets nothing");
    ok("bob paid the real winnings and got his dispute bond back");
    alice.close();
    bob.close();
  }

  // ---------------------------------------------------------------------------------- D
  log("D. draw refunds both stakes with no rake");
  {
    const { id, alice, bob } = await newMatch();
    const end = await play(id, alice, bob, DRAW);
    assert.equal(end.result, 3);
    await alice.signResult(id, 1, end.result, end.finalHash);
    await bob.signResult(id, 2, end.result, end.finalHash);
    await alice.waitFor((m) => m.type === "settled");
    assert.equal(await claimable(TREASURY), rake * 3n, "treasury holds rake from A, B and C only, none from the draw");
    ok("draw added no rake");
    alice.close();
    bob.close();
  }

  // ---------------------------------------------------------------------------------- E
  log("E. nobody plays: abort refunds both stakes");
  {
    const alice = new Player("alice", wallets.alice, serverUrl, domain);
    const id = await read<bigint>("nextId");
    await write(wallets.alice, "createOffer", [STAKE, BigInt(Math.floor(Date.now() / 1000) + 86_400 * 30), alice.session.address]);
    await write(wallets.bob, "challenge", [id, privateKeyToAccount(generatePrivateKey()).address]);
    await assert.rejects(write(wallets.alice, "abort", [id]), "too early");
    await testClient.increaseTime({ seconds: 3600 + 600 + 5 });
    await testClient.mine({ blocks: 1 });
    const aBefore = await claimable(wallets.alice.address);
    const bBefore = await claimable(wallets.bob.address);
    await write(wallets.deployer, "abort", [id]); // anyone can call it
    assert.equal((await claimable(wallets.alice.address)) - aBefore, STAKE);
    assert.equal((await claimable(wallets.bob.address)) - bBefore, STAKE);
    ok("both stakes refunded by a third party after the deadline");
  }

  const held = await balance(escrow);
  const owed =
    (await claimable(wallets.alice.address)) + (await claimable(wallets.bob.address)) + (await claimable(TREASURY));
  assert.equal(held, owed, "escrow holds exactly what is owed");
  ok(`escrow balance ${held} equals all unclaimed credits`);
  log("ALL SCENARIOS PASSED");
} catch (e) {
  console.error("\nFAILED:", e);
  exitCode = 1;
} finally {
  await server?.close();
  anvil.kill();
  process.exit(exitCode);
}
