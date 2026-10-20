// Drives the real web client in headless Chromium: Alice creates an offer, Bob challenges, they play, payout, claim.
// Usage: (cd contracts && forge build) && node scripts/ui-test.ts   (set CHROMIUM=/path/to/chrome if needed)
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { chromium, type Page } from "playwright-core";
import { createServer } from "vite";
import { createPublicClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { startServer } from "../packages/server/src/main.ts";
import { deployContracts } from "./lib.ts";

const ANVIL_PORT = 18546;
const RPC = `http://127.0.0.1:${ANVIL_PORT}`;
const DEPLOYER = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;
const REFEREE = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;
const SHOTS = process.env.SHOTS_DIR ?? join(tmpdir(), "playpot-shots");
mkdirSync(SHOTS, { recursive: true });

const anvil = spawn(process.env.ANVIL ?? "anvil", ["--port", String(ANVIL_PORT), "--silent"], { stdio: "ignore" });
let code = 0;
let vite: Awaited<ReturnType<typeof createServer>> | undefined;
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
  const { escrow } = await deployContracts({
    rpc: RPC,
    deployerPk: DEPLOYER,
    referee: privateKeyToAccount(REFEREE).address,
    treasury: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  });
  server = await startServer({
    rpcUrl: RPC,
    escrow,
    refereePk: REFEREE,
    port: 0,
    dataDir: mkdtempSync(join(tmpdir(), "playpot-ui-")),
    resultWaitMs: 4000,
  });
  vite = await createServer({ root: "packages/web", logLevel: "error", server: { port: 0, host: "127.0.0.1" } });
  await vite.listen();
  const webUrl = vite.resolvedUrls!.local[0].replace(/\/$/, "");
  const serverUrl = `http://127.0.0.1:${server.port}`;
  console.log(`web ${webUrl}  referee ${serverUrl}`);

  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
    args: ["--no-sandbox"],
  });
  const open = async (name: string): Promise<Page> => {
    const ctx = await browser!.newContext({ viewport: { width: 900, height: 900 } });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => console.log(`[${name} pageerror]`, e.message));
    await page.goto(`${webUrl}/?burner=${name}&server=${encodeURIComponent(serverUrl)}`);
    await page.waitForSelector("#addr");
    return page;
  };
  const text = async (p: Page, sel: string) => ((await p.textContent(sel)) ?? "").trim();
  const waitText = (p: Page, sel: string, re: RegExp, timeout = 20000) =>
    p.waitForFunction(([s, r]) => new RegExp(r).test(document.querySelector(s as string)?.textContent ?? ""), [sel, re.source], { timeout });
  const msgDone = (p: Page, label: string) => waitText(p, "#msg", new RegExp(`${label}: done`));

  const alice = await open("alice");
  const bob = await open("bob");

  for (const [n, p] of [["alice", alice], ["bob", bob]] as const) {
    await p.click('[data-act="fund"]');
    await msgDone(p, "Dev fund");
    await p.click('[data-act="mint"]');
    await msgDone(p, "Mint 1000 test tokens");
    await waitText(p, "#tokens", /1000/);
    console.log(`${n}: funded`);
  }

  await alice.fill("#stake", "10");
  await alice.click('[data-act="create"]');
  await msgDone(alice, "Create offer");
  await waitText(alice, "#tokens", /^990/);
  console.log("alice: offer created (10 tPUSD locked)");

  await bob.waitForSelector('[data-act="challenge"]:not([disabled])', { timeout: 15000 });
  await bob.click('[data-act="challenge"]');
  await bob.waitForSelector("#match", { timeout: 20000 });
  await waitText(bob, "#chain-status", /active/);
  console.log("bob: challenged, match open");

  await alice.waitForSelector('[data-act="open"]', { timeout: 15000 });
  await alice.click('[data-act="open"]');
  await alice.waitForSelector("#match");

  await alice.screenshot({ path: join(SHOTS, "1-alice-board-start.png") });

  const play = async (p: Page, cell: number) => {
    const sel = `[data-cell="${cell}"].mine:not([disabled])`;
    await p.waitForSelector(sel, { timeout: 15000 });
    await p.click(sel);
  };
  await play(alice, 0);
  await play(bob, 3);
  await play(alice, 1);
  await play(bob, 4);
  await bob.screenshot({ path: join(SHOTS, "2-bob-midgame.png") });
  await play(alice, 2);
  console.log("moves played");

  for (const p of [alice, bob]) await waitText(p, "#turn", /Player 1 \(X\) wins/);
  await waitText(alice, "#turn", /you won/);
  for (const p of [alice, bob]) {
    await waitText(p, "#verify", /log verified/);
    await waitText(p, "#settled", /instant settlement/);
  }
  console.log("both clients verified the log and settlement was instant");
  await alice.screenshot({ path: join(SHOTS, "3-alice-won.png") });

  // Replay scrubber shows earlier positions
  await alice.fill("#step", "2");
  await alice.waitForFunction(() => document.querySelectorAll(".cell").length === 9);
  const cells = await alice.$$eval(".cell", (els) => els.map((e) => e.textContent?.trim() ?? ""));
  assert.deepEqual(cells, ["X", "", "", "O", "", "", "", "", ""], "scrubbing to move 2 shows X@0 and O@3 only");
  console.log("replay scrubber works");

  await waitText(alice, "#claimable", /^19\.4/);
  await alice.click('[data-act="claim"]');
  await msgDone(alice, "Claim");
  await waitText(alice, "#tokens", /^1009\.4/);
  console.log("alice claimed 19.4 tPUSD (20 pot - 3% rake)");
  await alice.screenshot({ path: join(SHOTS, "4-alice-claimed.png") });
  console.log(`\nUI TEST PASSED (screenshots in ${SHOTS})`);
} catch (e) {
  console.error("\nUI TEST FAILED:", e);
  code = 1;
} finally {
  await browser?.close();
  await vite?.close();
  await server?.close();
  anvil.kill();
  process.exit(code);
}
