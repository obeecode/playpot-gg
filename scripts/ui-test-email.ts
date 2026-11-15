// Drives email sign-in in the real web client: code by email (captured instead of sent), a passphrase that encrypts the
// wallet key in the browser, the server holding only ciphertext, and the same wallet found again on a "new device".
// Operations go through the shared fake bundler, which checks they are signed by the email wallet's owner key.
// Usage: (cd contracts && forge build) && node scripts/ui-test-email.ts
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import { createPublicClient, http, recoverAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { startServer } from "../packages/server/src/main.ts";
import { deployContracts, deployJinxV2 } from "./lib.ts";
import { startFakeAa } from "./fakeAa.ts";

const ANVIL_PORT = 18551;
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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

try {
  const pub = createPublicClient({ transport: http(RPC) });
  for (let i = 0; ; i++) {
    try {
      await pub.getChainId();
      break;
    } catch {
      if (i > 50) throw new Error("anvil did not start");
      await sleep(100);
    }
  }
  const chainId = await pub.getChainId();
  const referee = privateKeyToAccount(REFEREE).address;
  const treasury = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;
  const { token, escrow } = await deployContracts({ rpc: RPC, deployerPk: DEPLOYER, referee, treasury });
  const jinxEscrow = await deployJinxV2({ rpc: RPC, deployerPk: DEPLOYER, refereePk: REFEREE, treasury, token });

  // The fake bundler accepts an operation only if the email wallet's own key signed it: recover the signer and compare.
  let ownerAddress = "" as Address;
  const fake = await startFakeAa({
    rpc,
    chainId,
    ownerCheck: async ({ userOpHash, ownerIndex, signatureData }) => ownerIndex === 0n && signatureData.length === 2 + 65 * 2 && (await recoverAddress({ hash: userOpHash, signature: signatureData })) === ownerAddress,
  });
  closeFake = fake.close;

  const mails: Array<{ to: string; code: string }> = [];
  const dataDir = mkdtempSync(join(tmpdir(), "playpot-email-ui-"));
  server = await startServer({
    rpcUrl: RPC,
    escrow,
    jinxEscrow,
    refereePk: REFEREE,
    port: 0,
    dataDir,
    resultWaitMs: 4000,
    webDir: "packages/web/dist",
    proxyRpc: true,
    bundlerUrl: fake.url,
    paymasterUrl: fake.url,
    mailer: { sendCode: async (to, c) => void mails.push({ to, code: c }) },
  });
  const webUrl = `http://localhost:${server.port}`;
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--no-sandbox"] });
  const waitText = (p: Page, sel: string, re: RegExp, timeout = 30_000) =>
    p.waitForFunction(([s, r]) => new RegExp(r).test(document.querySelector(s as string)?.textContent ?? ""), [sel, re.source], { timeout });

  const newDevice = async (): Promise<{ ctx: BrowserContext; page: Page }> => {
    const ctx = await browser!.newContext({ viewport: { width: 900, height: 1300 } });
    await fake.stubChainReads(ctx, webUrl);
    const page = await ctx.newPage();
    page.on("pageerror", (e) => console.log("[pageerror]", e.message));
    await page.goto(`${webUrl}/`);
    return { ctx, page };
  };
  const sendCode = async (p: Page, email: string) => {
    await p.fill("#em-email", email);
    await p.click("#emailsend");
    await p.waitForSelector("#em-code");
  };
  const typeCode = async (p: Page, c: string) => {
    await p.fill("#em-code", c);
    await p.click("#emailverify");
  };

  // ---- a new player signs up by email
  const A = await newDevice();
  const alice = A.page;
  await alice.waitForSelector("#emailopen");
  check(true, "the 'Sign in with email' button shows, because the server can send codes");
  await alice.click("#emailopen");
  const firstSent = Date.now();
  await sendCode(alice, "Alice@Example.com");
  check(mails.length === 1 && mails[0].to === "alice@example.com", "a code was 'emailed' to the normalised address");

  await typeCode(alice, "000000");
  await waitText(alice, "#emailerror", /wrong or has expired/);
  check(true, "a wrong code is refused with a plain message");
  await typeCode(alice, mails[0].code);
  await alice.waitForSelector("#em-pass2");
  check(true, "the right code leads to creating a wallet passphrase");

  await alice.fill("#em-pass", "short");
  await alice.fill("#em-pass2", "short");
  await alice.click("#emailfinish");
  await waitText(alice, "#emailerror", /at least 10 characters/);
  await alice.fill("#em-pass", "blue lamp river stone");
  await alice.fill("#em-pass2", "blue lamp river STONE");
  await alice.click("#emailfinish");
  await waitText(alice, "#emailerror", /do not match/);
  check(true, "a weak passphrase and a mismatch are both turned away");
  await alice.fill("#em-pass2", "blue lamp river stone");
  await alice.click("#emailfinish");
  await waitText(alice, "#addr", /email wallet/);
  const addrA = ((await alice.textContent("#addr")) ?? "").match(/0x[0-9a-fA-F]{40}/)![0];
  check(true, "with a good passphrase the email wallet is created and signed in");

  const blob = JSON.parse((await alice.evaluate(() => localStorage.getItem("playpot:vault"))) as string) as { address: Address; ct: string };
  ownerAddress = blob.address;
  const sessionPk = (await alice.evaluate(() => sessionStorage.getItem("playpot:emailkey"))) as Hex;
  check(privateKeyToAccount(sessionPk).address === ownerAddress, "the wallet's owner key was made in the browser");

  // what the server keeps: ciphertext and keyed hashes, never the address, the key or the passphrase
  const stored = readdirSync(dataDir)
    .filter((f) => f.endsWith(".jsonl") || f.endsWith(".key"))
    .filter((f) => f !== "email-pepper.key")
    .map((f) => readFileSync(join(dataDir, f), "utf8"))
    .join("\n");
  check(stored.includes(blob.ct), "the server stored the encrypted key");
  check(!stored.toLowerCase().includes("alice") && !stored.includes("example.com"), "the server stored no email address");
  check(!stored.includes(sessionPk.slice(2)) && !stored.includes("blue lamp river stone"), "the server never saw the key or the passphrase");

  // ---- the wallet works: a sponsored operation signed by the owner key
  await alice.click('[data-act="game"][data-game="jinx"]');
  await alice.waitForSelector('[data-act="game"][data-game="jinx"].primary');
  await alice.click('[data-act="mint"]');
  await waitText(alice, "#tokens", /^1000/);
  const op = fake.state.ops[0];
  check(op && op.signatureValid, "the operation's signature recovers to the email wallet's owner key");
  check(op.sponsored && op.withInitCode, "it was sponsored, and deployed the wallet through the known factory");
  check(((await rpc("eth_getBalance", [addrA, "latest"])) as string) === "0x0", "the wallet holds no ETH");

  // ---- a reload in the same tab does not ask again
  await alice.reload();
  await waitText(alice, "#addr", new RegExp(`${addrA}.*email wallet`, "i"));
  check(true, "a reload signs back in without asking for the passphrase");

  // ---- a new device: email code, then the passphrase
  const wait = Math.max(0, firstSent + 21_000 - Date.now());
  if (wait) await sleep(wait); // one code every 20 seconds per address
  const B = await newDevice();
  const bob = B.page;
  await bob.waitForSelector("#emailopen");
  await bob.click("#emailopen");
  await sendCode(bob, "alice@example.com");
  await typeCode(bob, mails[mails.length - 1].code);
  await bob.waitForSelector("#em-pass");
  check((await bob.locator("#em-pass2").count()) === 0, "this email already has a wallet, so it asks for the passphrase, not a new one");
  await bob.fill("#em-pass", "blue lamp river STONE");
  await bob.click("#emailfinish");
  await waitText(bob, "#emailerror", /did not open/);
  check(true, "a wrong passphrase does not open the wallet");
  await bob.fill("#em-pass", "blue lamp river stone");
  await bob.click("#emailfinish");
  await waitText(bob, "#addr", new RegExp(`${addrA}.*email wallet`, "i"));
  check(true, "on a new device the same wallet address comes back");

  // ---- the first device later: the passphrase alone is enough, no new code
  await alice.evaluate(() => sessionStorage.clear());
  await alice.reload();
  await alice.waitForSelector("#emailopen");
  check(((await alice.textContent("#emailopen")) ?? "").includes("Unlock"), "this device offers to unlock the saved wallet");
  await alice.click("#emailopen");
  await alice.waitForSelector("#em-pass");
  const mailsBefore = mails.length;
  await alice.fill("#em-pass", "blue lamp river stone");
  await alice.click("#emailfinish");
  await waitText(alice, "#addr", new RegExp(`${addrA}.*email wallet`, "i"));
  check(mails.length === mailsBefore, "unlocking on a known device needs only the passphrase, with no new email");
  await alice.screenshot({ path: join(SHOTS, "email-1-wallet.png") });

  console.log(`\nEMAIL WALLET UI TEST PASSED (screenshots in ${SHOTS})`);
} catch (e) {
  console.error("\nEMAIL WALLET UI TEST FAILED:", e);
  code = 1;
} finally {
  await browser?.close();
  await server?.close();
  closeFake?.();
  anvil.kill();
  process.exit(code);
}
