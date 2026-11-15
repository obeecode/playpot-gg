// Drives the real web client with a REAL passkey (Chrome's virtual authenticator) and the real server relay, against a fake
// bundler and gas sponsor. A full JINX match is played and paid through the passkey wallet, which holds no ETH. The fake
// bundler checks what a real one would not tell us: that every operation carries a valid passkey signature over the right
// hash, that gas was sponsored, and that the wallet deploys itself through the known factory on its first operation.
// What it cannot check: the wallet contract itself and a real bundler, which need a live network.
// Usage: (cd contracts && forge build) && node scripts/ui-test-passkey.ts
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type BrowserContext, type CDPSession, type Page } from "playwright-core";
import { WebAuthnP256 } from "ox";
import { createPublicClient, decodeAbiParameters, hexToString, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { startServer } from "../packages/server/src/main.ts";
import { deployContracts, deployJinxV2 } from "./lib.ts";
import { startFakeAa } from "./fakeAa.ts";

const webAuthnAuth = [
  {
    components: [
      { name: "authenticatorData", type: "bytes" },
      { name: "clientDataJSON", type: "bytes" },
      { name: "challengeIndex", type: "uint256" },
      { name: "typeIndex", type: "uint256" },
      { name: "r", type: "uint256" },
      { name: "s", type: "uint256" },
    ],
    type: "tuple",
  },
] as const;

const ANVIL_PORT = 18550;
const RPC = `http://127.0.0.1:${ANVIL_PORT}`;
const DEPLOYER = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;
const REFEREE = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;
const SHOTS = process.env.SHOTS_DIR ?? join(tmpdir(), "playpot-shots");
mkdirSync(SHOTS, { recursive: true });

const built = spawnSync("npm", ["run", "build:web"], { stdio: "ignore", shell: true });
if (built.status !== 0) throw new Error("web build failed");

const anvil = spawn(process.env.ANVIL ?? "anvil", ["--port", String(ANVIL_PORT), "--silent", "--base-fee", "0", "--gas-price", "0"], { stdio: "ignore" });
let code = 0;
let closeFake: (() => void) | undefined;
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
  const chainId = await pub.getChainId();
  const referee = privateKeyToAccount(REFEREE).address;
  const treasury = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;
  const { token, escrow } = await deployContracts({ rpc: RPC, deployerPk: DEPLOYER, referee, treasury });
  const jinxEscrow = await deployJinxV2({ rpc: RPC, deployerPk: DEPLOYER, refereePk: REFEREE, treasury, token });

  // ---- the shared fake bundler + gas sponsor; here it checks the passkey's WebAuthn signature over each operation
  let ownerKey = "" as Hex; // the passkey's public key, learned from the page after sign-up
  const fake = await startFakeAa({
    rpc,
    chainId,
    ownerCheck: ({ userOpHash, ownerIndex, signatureData }) => {
      const [auth] = decodeAbiParameters(webAuthnAuth, signatureData);
      return (
        ownerIndex === 0n &&
        WebAuthnP256.verify({
          challenge: userOpHash,
          metadata: { authenticatorData: auth.authenticatorData, clientDataJSON: hexToString(auth.clientDataJSON), challengeIndex: Number(auth.challengeIndex), typeIndex: Number(auth.typeIndex), userVerificationRequired: true },
          publicKey: { prefix: 4, x: BigInt(`0x${ownerKey.slice(2, 66)}`), y: BigInt(`0x${ownerKey.slice(66)}`) },
          signature: { r: auth.r, s: auth.s },
        })
      );
    },
  });
  closeFake = fake.close;
  const state = fake.state;
  const bundlerUrl = fake.url;

  server = await startServer({
    rpcUrl: RPC,
    escrow,
    jinxEscrow,
    refereePk: REFEREE,
    port: 0,
    dataDir: mkdtempSync(join(tmpdir(), "playpot-passkey-ui-")),
    resultWaitMs: 4000,
    webDir: "packages/web/dist",
    proxyRpc: true,
    bundlerUrl,
    paymasterUrl: bundlerUrl,
    jinxRoom: { startDelayMs: 400, turnGapMs: 300, gameGapMs: 500, revealMs: 4000 },
  });
  const webUrl = `http://localhost:${server.port}`; // WebAuthn needs a real host name, not an IP address

  browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--no-sandbox"] });
  const waitText = (p: Page, sel: string, re: RegExp, timeout = 30_000) =>
    p.waitForFunction(([s, r]) => new RegExp(r).test(document.querySelector(s as string)?.textContent ?? ""), [sel, re.source], { timeout });
  const msgDone = async (p: Page, label: string) => {
    try {
      await waitText(p, "#msg", new RegExp(`${label}: done`));
    } catch (e) {
      throw new Error(`${label} did not finish. The page says: ${await p.textContent("#msg").catch(() => "(nothing)")}. ${(e as Error).message}`);
    }
  };

  /** A browser context with a virtual authenticator, and the on-chain reads a local chain cannot answer. */
  const openContext = async (): Promise<{ ctx: BrowserContext; page: Page; cdp: CDPSession; authenticatorId: string }> => {
    const ctx = await browser!.newContext({ viewport: { width: 900, height: 1300 } });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => console.log("[pageerror]", e.message));
    if (process.env.DEBUG) {
      page.on("response", async (r) => {
        if (/\/(paymaster|bundler)$/.test(r.url())) console.log("[relay]", r.request().postData()?.slice(0, 700), "=>", (await r.text().catch(() => "")).slice(0, 300));
      });
    }
    const cdp = await ctx.newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
      options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
    });
    await fake.stubChainReads(ctx, webUrl);
    return { ctx, page, cdp, authenticatorId };
  };

  // ---- alice creates a passkey wallet
  const A = await openContext();
  const alice = A.page;
  await alice.goto(`${webUrl}/`);
  await alice.waitForSelector("#pkcreate");
  check(await alice.locator("#pksign").count(), "both passkey buttons show, because this server relays passkey wallets");
  await alice.click("#pkcreate");
  await waitText(alice, "#addr", /passkey wallet/);
  const addrA = ((await alice.textContent("#addr")) ?? "").match(/0x[0-9a-fA-F]{40}/)![0];
  const rec = JSON.parse((await alice.evaluate(() => localStorage.getItem("playpot:passkey"))) as string) as { id: string; publicKey: Hex };
  ownerKey = rec.publicKey;
  check(rec.publicKey.length === 130, "a passkey was created on the page, with a P-256 public key");
  const dir = await fetch(`${webUrl}/passkey/${encodeURIComponent(rec.id)}`);
  check(dir.ok && ((await dir.json()) as { publicKey: string }).publicKey === rec.publicKey.toLowerCase(), "its public key is in the server's directory");
  check(((await rpc("eth_getBalance", [addrA, "latest"])) as string) === "0x0", "the wallet holds no ETH");

  await alice.click('[data-act="game"][data-game="jinx"]');
  await alice.waitForSelector('[data-act="game"][data-game="jinx"].primary');
  await waitText(alice, "#start", /Covered for you/);
  check(true, "the checklist says gas is covered");

  await alice.click('[data-act="mint"]');
  await msgDone(alice, "Mint 1000 test tokens");
  await waitText(alice, "#tokens", /^1000/);
  check(state.ops.length === 1 && state.ops[0].withInitCode, "the first operation deploys the wallet through the known factory");
  check(state.ops.every((o) => o.signatureValid), "its passkey signature verifies over the operation's hash");
  check(state.ops.every((o) => o.sponsored) && state.paymasterCalls.length >= 2, "gas was sponsored through the relay");

  await alice.fill("#stake", "10");
  await alice.selectOption("#bestof", "3");
  await alice.click('[data-act="create"]');
  await msgDone(alice, "Create offer");
  const last = state.ops[state.ops.length - 1];
  check(last.calls === 2 && !last.withInitCode && last.signatureValid, "approve and create-offer went out as one signed operation, with no deployment this time");
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
  check(true, "bob challenged, and both boards are open");

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
  check(true, "a full match was played from a passkey wallet and paid out instantly");

  await waitText(alice, "#claimable", /^18\.3/);
  await alice.click('[data-act="claim"]');
  await msgDone(alice, "Claim");
  await waitText(alice, "#tokens", /^1008\.3/);
  check(state.ops.every((o) => o.signatureValid && o.sponsored), "every operation had a valid passkey signature and sponsored gas");
  check(((await rpc("eth_getBalance", [addrA, "latest"])) as string) === "0x0", "alice claimed her winnings and never held any ETH");

  // ---- a reload remembers the passkey on this device
  await alice.reload();
  await waitText(alice, "#addr", new RegExp(`${addrA}.*passkey wallet`, "i"));
  check(true, "after a reload she is signed back in without a prompt");

  // ---- the same passkey on a new device: sign in finds the wallet again through the directory
  const credentials = ((await A.cdp.send("WebAuthn.getCredentials", { authenticatorId: A.authenticatorId })) as { credentials: unknown[] }).credentials;
  check(credentials.length === 1, "the passkey is a discoverable credential the browser can offer on another device");
  const B = await openContext();
  await B.cdp.send("WebAuthn.addCredential", { authenticatorId: B.authenticatorId, credential: credentials[0] as never });
  await B.page.goto(`${webUrl}/`);
  await B.page.evaluate(() => localStorage.clear());
  await B.page.goto(`${webUrl}/`);
  await B.page.waitForSelector("#pksign");
  await B.page.click("#pksign");
  await waitText(B.page, "#addr", new RegExp(`${addrA}.*passkey wallet`, "i"));
  check(true, "on a fresh device, 'Sign in with passkey' finds the same wallet address");
  await alice.screenshot({ path: join(SHOTS, "passkey-1-wallet.png") });

  console.log(`\nPASSKEY WALLET UI TEST PASSED (screenshots in ${SHOTS})`);
} catch (e) {
  console.error("\nPASSKEY WALLET UI TEST FAILED:", e);
  code = 1;
} finally {
  await browser?.close();
  await server?.close();
  closeFake?.();
  anvil.kill();
  process.exit(code);
}
