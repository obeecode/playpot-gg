// Drives the real web client with a fake smart wallet that speaks EIP-5792 (it stands in for any batching wallet): the player holds NO ETH, every action is one batched
// call (approve + offer in a single confirmation) with a gas sponsor attached, and a full JINX match is played and paid.
// The real passkey wallet is covered by ui-test-passkey.ts; this one isolates the batching and sponsorship behaviour. Usage: (cd contracts && forge build) && node scripts/ui-test-smart.ts
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import { createPublicClient, http, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { startServer } from "../packages/server/src/main.ts";
import { deployContracts, deployJinxV2 } from "./lib.ts";

const ANVIL_PORT = 18549;
const RPC = `http://127.0.0.1:${ANVIL_PORT}`;
const DEPLOYER = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;
const REFEREE = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;
const SPONSOR = "https://paymaster.test/rpc";
const SHOTS = process.env.SHOTS_DIR ?? join(tmpdir(), "playpot-shots");
mkdirSync(SHOTS, { recursive: true });

const built = spawnSync("npm", ["run", "build:web"], { stdio: "ignore", shell: true });
if (built.status !== 0) throw new Error("web build failed");

// Zero fees, so an account with no ETH can transact: that is what a gas sponsor makes possible on a real chain.
const anvil = spawn(process.env.ANVIL ?? "anvil", ["--port", String(ANVIL_PORT), "--silent", "--base-fee", "0", "--gas-price", "0"], { stdio: "ignore" });
let code = 0;
let server: Awaited<ReturnType<typeof startServer>> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;

const rpc = async (method: string, params: unknown[]) => {
  const res = (await (await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json()) as { result?: unknown; error?: { message: string } };
  if (res.error) throw new Error(`${method}: ${res.error.message}`);
  return res.result;
};
const check = (cond: unknown, what: string) => {
  if (!cond) throw new Error(`FAILED: ${what}`);
  console.log(`ok: ${what}`);
};

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
  const jinxEscrow = await deployJinxV2({ rpc: RPC, deployerPk: DEPLOYER, refereePk: REFEREE, treasury, token });
  server = await startServer({
    rpcUrl: RPC,
    escrow,
    jinxEscrow,
    refereePk: REFEREE,
    port: 0,
    dataDir: mkdtempSync(join(tmpdir(), "playpot-smart-ui-")),
    resultWaitMs: 4000,
    webDir: "packages/web/dist",
    proxyRpc: true,
    bundlerUrl: "https://bundler.test/rpc", // these two only switch sponsoring on: the fake wallet never calls them
    paymasterUrl: SPONSOR,
    jinxRoom: { startDelayMs: 400, turnGapMs: 300, gameGapMs: 500, revealMs: 4000 },
  });
  const webUrl = `http://127.0.0.1:${server.port}`;

  // ---- the fake smart wallet: an account with no ETH whose batches are executed one call after another
  const SMART: Address = privateKeyToAccount(generatePrivateKey()).address;
  await rpc("anvil_impersonateAccount", [SMART]);
  const sentBatches: Array<{ calls: unknown[]; capabilities?: { paymasterService?: { url: string } }; from: string }> = [];
  const results = new Map<string, { status: number; receipts: unknown[] }>();
  const smartRpc = async (method: string, params: unknown[]): Promise<unknown> => {
    if (method === "eth_requestAccounts" || method === "eth_accounts") return [SMART];
    if (method === "wallet_switchEthereumChain") return null;
    if (method === "wallet_sendCalls") {
      const p = params[0] as (typeof sentBatches)[number] & { calls: Array<{ to: string; data: string; value: string }> };
      sentBatches.push(p);
      const receipts: unknown[] = [];
      let ok = true;
      for (const c of p.calls) {
        const hash = (await rpc("eth_sendTransaction", [{ from: SMART, to: c.to, data: c.data, value: c.value, gas: "0x2dc6c0", gasPrice: "0x0" }])) as string;
        let r: { status: string; logs: unknown[] } | undefined;
        while (!r) r = ((await rpc("eth_getTransactionReceipt", [hash])) as typeof r | null) ?? undefined;
        receipts.push({ status: r.status, transactionHash: hash, logs: r.logs });
        if (r.status !== "0x1") {
          ok = false;
          break;
        }
      }
      const id = `0x${Buffer.from(generatePrivateKey().slice(2, 18), "hex").toString("hex")}${results.size}`;
      results.set(id, { status: ok ? 200 : 500, receipts });
      return id;
    }
    if (method === "wallet_getCallsStatus") return results.get(params[0] as string) ?? { status: 100, receipts: [] };
    throw new Error(`the fake wallet does not do ${method}`);
  };

  browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--no-sandbox"] });
  const waitText = (p: Page, sel: string, re: RegExp, timeout = 30_000) =>
    p.waitForFunction(([s, r]) => new RegExp(r).test(document.querySelector(s as string)?.textContent ?? ""), [sel, re.source], { timeout });
  const msgDone = (p: Page, label: string) => waitText(p, "#msg", new RegExp(`${label}: done`));

  const openAlice = async (): Promise<Page> => {
    const ctx = await browser!.newContext({ viewport: { width: 900, height: 1300 } });
    await ctx.exposeFunction("__smartRpc", smartRpc);
    await ctx.addInitScript(() => {
      (window as unknown as { __playpotSmartProvider: unknown }).__playpotSmartProvider = {
        request: ({ method, params }: { method: string; params: unknown[] }) => (window as unknown as { __smartRpc: (m: string, p: unknown[]) => Promise<unknown> }).__smartRpc(method, params),
      };
    });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => console.log("[alice pageerror]", e.message));
    await page.goto(`${webUrl}/`);
    return page;
  };

  // ---- alice signs in with the (fake) passkey wallet
  const alice = await openAlice();
  await alice.waitForSelector("#pkcreate");
  await alice.click("#pkcreate");
  await waitText(alice, "#addr", new RegExp(`${SMART}.*passkey wallet`, "i"));
  check(true, "alice signs in with a passkey wallet and sees its address");
  await alice.click('[data-act="game"][data-game="jinx"]');
  await alice.waitForSelector('[data-act="game"][data-game="jinx"].primary');
  await waitText(alice, "#start", /Covered for you/);
  check(true, "the checklist says gas is covered, because a gas sponsor is configured");
  check(((await rpc("eth_getBalance", [SMART, "latest"])) as string) === "0x0", "her wallet holds no ETH at all");

  await alice.click('[data-act="mint"]');
  await msgDone(alice, "Mint 1000 test tokens");
  await waitText(alice, "#tokens", /^1000/);
  check(sentBatches.length === 1 && sentBatches[0].calls.length === 1, "minting is one batched call");
  check(sentBatches.every((b) => b.capabilities?.paymasterService?.url === `${webUrl}/paymaster`), "every batch says gas is sponsored, through this site's own relay");

  // ---- create an offer: approve + createOffer in ONE confirmation
  await alice.fill("#stake", "10");
  await alice.selectOption("#bestof", "3");
  await alice.click('[data-act="create"]');
  await msgDone(alice, "Create offer");
  const create = sentBatches[sentBatches.length - 1];
  check(create.calls.length === 2, "approve and create-offer went out as a single two-call batch");
  console.log("alice: offer created");

  // ---- bob is an ordinary burner wallet and takes the challenge
  const bobCtx = await browser.newContext({ viewport: { width: 900, height: 1300 } });
  const bob = await bobCtx.newPage();
  bob.on("pageerror", (e) => console.log("[bob pageerror]", e.message));
  await bob.goto(`${webUrl}/?burner=bob`);
  await bob.waitForSelector("#addr");
  await bob.click('[data-act="fund"]');
  await msgDone(bob, "Dev fund");
  await bob.click('[data-act="game"][data-game="jinx"]');
  await bob.waitForSelector('[data-act="game"][data-game="jinx"].primary');
  await bob.click('[data-act="mint"]');
  await msgDone(bob, "Mint 1000 test tokens");
  await bob.waitForSelector('[data-act="challenge"]:not([disabled])', { timeout: 30_000 });
  await bob.click('[data-act="challenge"]');
  await bob.waitForSelector("#jboard", { timeout: 30_000 });
  await alice.waitForSelector('[data-act="open"]', { timeout: 30_000 });
  await alice.click('[data-act="open"]');
  await alice.waitForSelector("#jboard");
  await waitText(alice, "#jstatus", /Tap a square/);
  await waitText(bob, "#jstatus", /Tap a square/);
  check(true, "bob challenged and both boards are open");
  await alice.screenshot({ path: join(SHOTS, "smart-1-board.png") });

  const tap = async (p: Page, cell: number) => {
    const sel = `.jcell[data-cell="${cell}"]:not([disabled])`;
    await p.waitForSelector(sel, { timeout: 30_000 });
    await p.click(sel);
  };
  const aliceCells = [0, 1, 2, 0, 1, 2];
  const bobCells = [24, 20, 14, 24, 20, 14];
  for (let t = 0; t < 6; t++) await Promise.all([tap(alice, aliceCells[t]), tap(bob, bobCells[t])]);
  await waitText(alice, "#jstatus", /You win the match/);
  for (const p of [alice, bob]) {
    await waitText(p, "#verify", /log verified/);
    await waitText(p, "#settled", /instant settlement/);
  }
  check(true, "a full match was played with a passkey wallet, verified and paid out instantly");

  // ---- claim winnings: one batched call, still no ETH
  await waitText(alice, "#claimable", /^18\.3/);
  await alice.click('[data-act="claim"]');
  await msgDone(alice, "Claim");
  await waitText(alice, "#tokens", /^1008\.3/);
  check(true, "alice claimed 18.3 tPUSD through the passkey wallet");
  check(((await rpc("eth_getBalance", [SMART, "latest"])) as string) === "0x0", "she never held or spent any ETH");

  // ---- the wallet remembers her: a reload signs back in without a popup
  await alice.reload();
  await waitText(alice, "#addr", new RegExp(`${SMART}.*passkey wallet`, "i"));
  check(true, "after a reload she is signed back in automatically");
  console.log(`\nSMART WALLET UI TEST PASSED (screenshots in ${SHOTS})`);
} catch (e) {
  console.error("\nSMART WALLET UI TEST FAILED:", e);
  code = 1;
} finally {
  await browser?.close();
  await server?.close();
  anvil.kill();
  process.exit(code);
}
