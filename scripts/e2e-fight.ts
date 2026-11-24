// Staked Fight, end to end: a local chain with the contracts, the server, and two real browsers playing the real game in a room
// named for an on-chain match. When a player leaves, the server replays the record, signs the result, submits it to FightEscrow,
// and finalizes it after the challenge window; the winner claims. Two matches: one played to the end, one where the host walks out.
//   FIGHT_DIR=<gameplay-core> FIGHT_REF=<counterpick-ref> CHROMIUM=<browser path> node scripts/e2e-fight.ts
//   (needs `cd contracts && forge build` and anvil; or set RPC_URL to a local chain that is already running, with anvil's keys funded)
// Skipped when the game's files are not configured.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPublicClient, createWalletClient, http, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { chromium, type Page } from "playwright-core";
import { fightEscrowAbi, testTokenAbi } from "../packages/game/src/index.ts";
import { startServer } from "../packages/server/src/main.ts";
import { fightFromEnv } from "../packages/server/src/fight.ts";
import { joinMessage } from "../packages/server/src/fightLog.ts";
import { roomForMatch } from "../packages/server/src/fightSettle.ts";
import { deployContracts, deployFight } from "./lib.ts";

const env = fightFromEnv();
if (!env.options) {
  console.log(`skipped: ${env.problem ?? "set FIGHT_DIR and FIGHT_REF"}`);
  process.exit(0);
}

const KEY = {
  deployer: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  referee: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  alice: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  bob: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
} as const satisfies Record<string, Hex>;
const TREASURY: Address = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const ARBITER: Address = "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc";
const STAKE = 20_000_000n;
const RAKE_BPS = 300n;
const WINDOW = 4; // seconds: the challenge window, kept short for the test

const failures: string[] = [];
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};

let anvil: ChildProcess | undefined;
const port = Number(process.env.ANVIL_PORT ?? 8548);
const rpc = process.env.RPC_URL ?? `http://127.0.0.1:${port}`;
if (!process.env.RPC_URL) anvil = spawn(process.env.ANVIL ?? "anvil", ["--port", String(port), "--silent"], { stdio: "inherit" });
const pub = createPublicClient({ transport: http(rpc) });
for (let i = 0; ; i++) {
  try {
    await pub.getChainId();
    break;
  } catch {
    if (i > 80) throw new Error("the chain did not start");
    await new Promise((r) => setTimeout(r, 100));
  }
}

const dataDir = mkdtempSync(join(tmpdir(), "e2e-fight-"));
const referee = privateKeyToAccount(KEY.referee);
const alice = privateKeyToAccount(KEY.alice);
const bob = privateKeyToAccount(KEY.bob);
const wallet = (a: typeof alice) => createWalletClient({ account: a, transport: http(rpc) });
const send = async (a: typeof alice, address: Address, abi: unknown, functionName: string, args: unknown[]) => {
  const hash = await wallet(a).writeContract({ chain: null, address, abi: abi as never, functionName, args } as never);
  return pub.waitForTransactionReceipt({ hash });
};

const { token, escrow } = await deployContracts({ rpc, deployerPk: KEY.deployer, referee: referee.address, treasury: TREASURY });
const fightEscrow = await deployFight({ rpc, deployerPk: KEY.deployer, token, referee: referee.address, arbiter: ARBITER, treasury: TREASURY, rakeBps: Number(RAKE_BPS), challengeWindow: WINDOW, matchDuration: 3600, abortGrace: 600 });
for (const a of [alice, bob]) {
  await send(a, token, testTokenAbi, "mint", [a.address, 1_000_000_000n]);
  await send(a, token, testTokenAbi, "approve", [fightEscrow, 2n ** 256n - 1n]);
}
const server = await startServer({ rpcUrl: rpc, escrow, refereePk: KEY.referee, port: 0, dataDir, resultWaitMs: 1000, fight: env.options, fightEscrow });
const base = `http://127.0.0.1:${server.port}`;
console.log(`chain ${rpc}, FightEscrow ${fightEscrow}, server ${base}`);

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? process.env.CHROME, args: ["--no-sandbox", "--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const balance = async (a: Address) => (await pub.readContract({ address: token, abi: testTokenAbi, functionName: "balanceOf", args: [a] } as never)) as bigint;
const matchOf = async (id: bigint) => (await pub.readContract({ address: fightEscrow, abi: fightEscrowAbi, functionName: "getMatch", args: [id] } as never)) as { status: number; outcome: number; p1Score: number; p2Score: number };
const claimable = async (a: Address) => (await pub.readContract({ address: fightEscrow, abi: fightEscrowAbi, functionName: "claimable", args: [a] } as never)) as bigint;
const rng = (s: number) => () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296; };
const until = async (what: string, f: () => Promise<boolean>, ms: number) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await f()) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  console.log(`  (gave up waiting for: ${what})`);
  return false;
};

/** An offer, a challenge, and the two per-match keys. Returns the match id. */
async function newMatch() {
  const id = (await pub.readContract({ address: fightEscrow, abi: fightEscrowAbi, functionName: "nextId" } as never)) as bigint;
  const k1 = privateKeyToAccount(generatePrivateKey()), k2 = privateKeyToAccount(generatePrivateKey());
  const now = Number((await pub.getBlock()).timestamp);
  await send(alice, fightEscrow, fightEscrowAbi, "createOffer", [STAKE, BigInt(now + 3600), k1.address]);
  await send(bob, fightEscrow, fightEscrowAbi, "challenge", [id, k2.address]);
  return { id, k1, k2 };
}

async function play(label: string, seed: number, ending: "to the end" | "host walks out") {
  console.log(`\n== ${label}`);
  const aliceBefore = await balance(alice.address), bobBefore = await balance(bob.address), treasuryBefore = await claimable(TREASURY);
  const { id, k1, k2 } = await newMatch();
  const room = roomForMatch(id);
  check((await matchOf(id)).status === 1, `match ${id} is active on the chain with both stakes locked`);
  const sigHost = await k1.signMessage({ message: joinMessage(room, "host") });
  const sigGuest = await k2.signMessage({ message: joinMessage(room, "guest") });

  const mk = async () => (await browser.newContext({ viewport: { width: 960, height: 540 } })).newPage();
  const host = await mk(), guest = await mk();
  // a stranger with no match key cannot take a seat
  const intruder = await mk();
  await intruder.goto(`${base}/g/fight/?room=${room}&role=host&sig=${await privateKeyToAccount(generatePrivateKey()).signMessage({ message: joinMessage(room, "host") })}`);
  await intruder.waitForFunction("window.__fc && window.__fc.CM", undefined, { timeout: 90_000 });
  await intruder.waitForTimeout(4000);
  check(!(await intruder.evaluate("!!(window.__fc.NET && window.__fc.NET.active)")), "a stranger's signature does not get a seat in the room");
  await intruder.close();

  await host.goto(`${base}/g/fight/?room=${room}&role=host&sig=${sigHost}`);
  await host.waitForFunction("window.__fc && window.__fc.CM", undefined, { timeout: 90_000 });
  await host.waitForTimeout(3000);
  await guest.goto(`${base}/g/fight/?room=${room}&sig=${sigGuest}`);
  await guest.waitForFunction("window.__fc && window.__fc.NET && window.__fc.NET.active", undefined, { timeout: 90_000 });
  await host.waitForTimeout(6000);
  for (const p of [host, guest]) {
    await p.mouse.click(480, 300);
    await p.keyboard.press("f");
    await p.waitForTimeout(500);
  }
  await host.waitForFunction("__fc.CM.mode === 'match'", undefined, { timeout: 30_000 });
  const keys = ["a", "d", "w", "f", "g", "e"];
  const r1 = rng(seed), r2 = rng(seed + 1000);
  const held = [new Set<string>(), new Set<string>()];
  const t0 = Date.now();
  const limit = ending === "to the end" ? 240_000 : 28_000;
  let over = false;
  while (!over && Date.now() - t0 < limit) {
    for (const [i, p, r] of [[0, host, r1], [1, guest, r2]] as const) {
      for (const k of keys) {
        const want = r() < 0.35;
        if (want && !held[i].has(k)) { held[i].add(k); await p.keyboard.down(k); }
        else if (!want && held[i].has(k)) { held[i].delete(k); await p.keyboard.up(k); }
      }
    }
    await host.waitForTimeout(130);
    over = (await host.evaluate("__fc.CM.phase")) === "over" && (await guest.evaluate("__fc.CM.phase")) === "over";
  }
  const score = String(await host.evaluate("__fc.CM.score.join('-')"));
  console.log(`  played ${Math.round((Date.now() - t0) / 1000)} s, host sees ${score}`);
  const leaver: Page = ending === "to the end" ? guest : host;
  await leaver.close();

  const proposed = await until("the result to be proposed on the chain", async () => (await matchOf(id)).status >= 2, 240_000);
  check(proposed, "the server replayed the record and submitted the result to FightEscrow");
  const m = await matchOf(id);
  const [h, g] = score.split("-").map(Number);
  const wantOutcome = ending === "to the end" ? (h > g ? 1 : 2) : 2; // the guest wins when the host walks out of a started match
  check(m.outcome === wantOutcome, `the chain holds outcome ${m.outcome} (${["", "host wins", "guest wins", "void"][m.outcome]}), expected ${wantOutcome}`);
  if (ending === "to the end") check(Number(m.p1Score) === h && Number(m.p2Score) === g, `with the score the clients saw (${m.p1Score}-${m.p2Score})`);
  const settled = await until("the challenge window to end and the server to finalize", async () => (await matchOf(id)).status === 4, 120_000);
  check(settled, "the server finalized it after the challenge window");

  const winner = wantOutcome === 1 ? alice : bob, loser = wantOutcome === 1 ? bob : alice;
  const pot = STAKE * 2n, rake = (pot * RAKE_BPS) / 10_000n;
  check((await claimable(winner.address)) === pot - rake, `the winner has ${(pot - rake) / 1_000_000n} tokens to claim`);
  check((await claimable(TREASURY)) - treasuryBefore === rake, "the treasury has the rake");
  await send(winner, fightEscrow, fightEscrowAbi, "claim", []);
  const gain = (await balance(winner.address)) - (winner === alice ? aliceBefore : bobBefore);
  const loss = (loser === alice ? aliceBefore : bobBefore) - (await balance(loser.address));
  check(gain === pot - rake - STAKE && loss === STAKE, `winner nets +${gain / 1_000_000n}, loser nets -${loss / 1_000_000n} (stake ${STAKE / 1_000_000n}, rake ${rake / 1_000_000n})`);
  await host.close().catch(() => {});
  await guest.close().catch(() => {});
  // the room is closed for good once the match has settled
  const late = await mk();
  await late.goto(`${base}/g/fight/?room=${room}&sig=${sigGuest}`);
  await late.waitForFunction("window.__fc && window.__fc.CM", undefined, { timeout: 90_000 });
  await late.waitForTimeout(3000);
  check(!(await late.evaluate("!!(window.__fc.NET && window.__fc.NET.active)")), "a settled match's room does not admit anyone again");
  await late.close();
}

try {
  await play("a match played to the end", 5, "to the end");
  await play("the host walks out of a started match", 21, "host walks out");
} finally {
  await browser.close();
  await server.close();
  anvil?.kill();
  rmSync(dataDir, { recursive: true, force: true });
}
if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("\nstaked fight e2e passed");
process.exit(0);
