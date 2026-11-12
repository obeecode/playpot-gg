// Drives the real web client in headless Chromium through a full JINX best-of-3: create offer, challenge, play both
// games with commit/reveal, verified log, instant payout and claim.
// Usage: (cd contracts && forge build) && node scripts/ui-test-jinx.ts   (set CHROMIUM=/path/to/chrome if needed)
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import { createPublicClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { startServer } from "../packages/server/src/main.ts";
import { deployContracts, deployJinx } from "./lib.ts";

const ANVIL_PORT = 18548;
const RPC = `http://127.0.0.1:${ANVIL_PORT}`;
const DEPLOYER = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;
const REFEREE = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;
const SHOTS = process.env.SHOTS_DIR ?? join(tmpdir(), "playpot-shots");
mkdirSync(SHOTS, { recursive: true });

const built = spawnSync("npm", ["run", "build:web"], { stdio: "ignore", shell: true });
if (built.status !== 0) throw new Error("web build failed");

const anvil = spawn(process.env.ANVIL ?? "anvil", ["--port", String(ANVIL_PORT), "--silent"], { stdio: "ignore" });
let code = 0;
let server: Awaited<ReturnType<typeof startServer>> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  const pub = createPublicClient({ transport: http(RPC) });
  for (let i = 0; ; i++) {
    try {
      await pub.getChainId();
      break;
    } catch {
      if (i > 50) throw new Error("anvil did not start");
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  const referee = privateKeyToAccount(REFEREE).address;
  const treasury = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;
  const { token, escrow } = await deployContracts({ rpc: RPC, deployerPk: DEPLOYER, referee, treasury });
  const jinxEscrow = await deployJinx({ rpc: RPC, deployerPk: DEPLOYER, referee, treasury, token });
  server = await startServer({
    rpcUrl: RPC,
    escrow,
    jinxEscrow,
    refereePk: REFEREE,
    port: 0,
    dataDir: mkdtempSync(join(tmpdir(), "playpot-jinx-ui-")),
    resultWaitMs: 4000,
    webDir: "packages/web/dist",
    proxyRpc: true,
    jinxRoom: { startDelayMs: 400, turnGapMs: 300, gameGapMs: 500, revealMs: 4000 },
  });
  const webUrl = `http://127.0.0.1:${server.port}`;
  console.log(`web ${webUrl}`);

  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
    args: ["--no-sandbox"],
  });
  const open = async (name: string): Promise<Page> => {
    const ctx = await browser!.newContext({ viewport: { width: 900, height: 1100 } });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => console.log(`[${name} pageerror]`, e.message));
    await page.goto(`${webUrl}/?burner=${name}`);
    await page.waitForSelector("#addr");
    return page;
  };
  const waitText = (p: Page, sel: string, re: RegExp, timeout = 30_000) =>
    p.waitForFunction(([s, r]) => new RegExp(r).test(document.querySelector(s as string)?.textContent ?? ""), [sel, re.source], { timeout });
  const msgDone = (p: Page, label: string) => waitText(p, "#msg", new RegExp(`${label}: done`));

  const alice = await open("alice");
  const bob = await open("bob");
  for (const [n, p] of [["alice", alice], ["bob", bob]] as const) {
    await p.click('[data-act="fund"]');
    await msgDone(p, "Dev fund");
    await p.click('[data-act="game"][data-game="jinx"]');
    await p.waitForSelector('[data-act="game"][data-game="jinx"].primary');
    await p.click('[data-act="mint"]');
    await msgDone(p, "Mint 1000 test tokens");
    await waitText(p, "#tokens", /1000/);
    console.log(`${n}: funded, on the JINX tab`);
  }

  await alice.fill("#stake", "10");
  await alice.selectOption("#bestof", "3");
  await alice.click('[data-act="create"]');
  await msgDone(alice, "Create offer");
  console.log("alice: JINX offer created (best of 3)");

  await bob.waitForSelector('[data-act="challenge"]:not([disabled])', { timeout: 30_000 });
  await waitText(bob, "#offers", /Bo3/);
  await bob.click('[data-act="challenge"]');
  await bob.waitForSelector("#jboard", { timeout: 30_000 });
  console.log("bob: challenged, JINX board open");
  await alice.waitForSelector('[data-act="open"]', { timeout: 30_000 });
  await alice.click('[data-act="open"]');
  await alice.waitForSelector("#jboard");
  await waitText(alice, "#jstatus", /Tap a square/);
  await waitText(bob, "#jstatus", /Tap a square/);
  await alice.screenshot({ path: join(SHOTS, "jinx-1-start.png") });

  const tap = async (p: Page, cell: number) => {
    const sel = `.jcell[data-cell="${cell}"]:not([disabled])`;
    await p.waitForSelector(sel, { timeout: 30_000 });
    await p.click(sel);
  };
  // Alice takes the top row, Bob scatters, in each of two games.
  const aliceCells = [0, 1, 2, 0, 1, 2];
  const bobCells = [24, 20, 14, 24, 20, 14];
  for (let t = 0; t < 6; t++) {
    await Promise.all([tap(alice, aliceCells[t]), tap(bob, bobCells[t])]);
    if (t === 0) {
      await waitText(alice, "#jstatus", /Pick again|took/);
      await alice.screenshot({ path: join(SHOTS, "jinx-2-after-first-turn.png") });
    }
    console.log(`turn ${t} played`);
  }

  await waitText(alice, "#jstatus", /You win the match/);
  await waitText(bob, "#jstatus", /They win the match/);
  for (const p of [alice, bob]) {
    await waitText(p, "#verify", /log verified/);
    await waitText(p, "#settled", /instant settlement/);
  }
  console.log("both clients verified the log and settlement was instant");
  const score = await alice.textContent("#jscore-a");
  if (score?.trim() !== "2") throw new Error(`expected alice to have 2 wins, got ${score}`);
  await alice.screenshot({ path: join(SHOTS, "jinx-3-won.png") });

  await waitText(alice, "#claimable", /^19\.4/);
  await alice.click('[data-act="claim"]');
  await msgDone(alice, "Claim");
  await waitText(alice, "#tokens", /^1009\.4/);
  console.log("alice claimed 19.4 tPUSD");
  console.log(`\nJINX UI TEST PASSED (screenshots in ${SHOTS})`);
} catch (e) {
  console.error("\nJINX UI TEST FAILED:", e);
  code = 1;
} finally {
  await browser?.close();
  await server?.close();
  anvil.kill();
  process.exit(code);
}
