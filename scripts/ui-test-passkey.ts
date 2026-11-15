// Drives the real web client with a REAL passkey (Chrome's virtual authenticator) and the real server relay, against a fake
// bundler and gas sponsor. A full JINX match is played and paid through the passkey wallet, which holds no ETH. The fake
// bundler checks what a real one would not tell us: that every operation carries a valid passkey signature over the right
// hash, that gas was sponsored, and that the wallet deploys itself through the known factory on its first operation.
// What it cannot check: the wallet contract itself and a real bundler, which need a live network.
// Usage: (cd contracts && forge build) && node scripts/ui-test-passkey.ts
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type BrowserContext, type CDPSession, type Page } from "playwright-core";
import { WebAuthnP256 } from "ox";
import {
  createPublicClient,
  decodeAbiParameters,
  decodeFunctionData,
  encodeAbiParameters,
  hexToString,
  http,
  keccak256,
  pad,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import { entryPoint06Address, getUserOperationHash } from "viem/account-abstraction";
import { privateKeyToAccount } from "viem/accounts";
import { startServer } from "../packages/server/src/main.ts";
import { deployContracts, deployJinxV2 } from "./lib.ts";

const ANVIL_PORT = 18550;
const RPC = `http://127.0.0.1:${ANVIL_PORT}`;
const DEPLOYER = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;
const REFEREE = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;
const FACTORY = "0xba5ed110efdba3d005bfc882d75358acbbb85842";
const SHOTS = process.env.SHOTS_DIR ?? join(tmpdir(), "playpot-shots");
mkdirSync(SHOTS, { recursive: true });

const built = spawnSync("npm", ["run", "build:web"], { stdio: "ignore", shell: true });
if (built.status !== 0) throw new Error("web build failed");

const anvil = spawn(process.env.ANVIL ?? "anvil", ["--port", String(ANVIL_PORT), "--silent", "--base-fee", "0", "--gas-price", "0"], { stdio: "ignore" });
let code = 0;
let server: Awaited<ReturnType<typeof startServer>> | undefined;
let bundlerHttp: ReturnType<typeof createServer> | undefined;
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

const walletAbi = parseAbi(["function execute(address target, uint256 value, bytes data)", "function executeBatch((address target, uint256 value, bytes data)[] calls)"]);
const sigWrapper = [{ components: [{ name: "ownerIndex", type: "uint256" }, { name: "signatureData", type: "bytes" }], type: "tuple" }] as const;
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

  // ---- a fake bundler + gas sponsor: checks what it is sent, then executes the calls as the wallet (no ETH needed)
  const state = {
    ownerKey: "" as Hex, // the passkey's public key, learned from the page after sign-up
    nonces: new Map<string, bigint>(),
    deployed: new Set<string>(),
    ops: [] as Array<{ sender: string; calls: number; withInitCode: boolean; sponsored: boolean; signatureValid: boolean }>,
    results: new Map<string, unknown>(),
    paymasterCalls: [] as string[],
  };
  const sendOp = async (op: Record<string, Hex>) => {
    const sender = op.sender.toLowerCase();
    const userOpHash = getUserOperationHash({
      chainId,
      entryPointAddress: entryPoint06Address,
      entryPointVersion: "0.6",
      userOperation: {
        sender: op.sender as Address,
        nonce: BigInt(op.nonce),
        initCode: op.initCode,
        callData: op.callData,
        callGasLimit: BigInt(op.callGasLimit),
        verificationGasLimit: BigInt(op.verificationGasLimit),
        preVerificationGas: BigInt(op.preVerificationGas),
        maxFeePerGas: BigInt(op.maxFeePerGas),
        maxPriorityFeePerGas: BigInt(op.maxPriorityFeePerGas),
        paymasterAndData: op.paymasterAndData,
        signature: op.signature,
      },
    });
    // The wallet checks the passkey's signature over the operation hash itself. Do the same check.
    const [{ ownerIndex, signatureData }] = decodeAbiParameters(sigWrapper, op.signature);
    const [auth] = decodeAbiParameters(webAuthnAuth, signatureData);
    const challenge = userOpHash;
    const clientDataJSON = hexToString(auth.clientDataJSON);
    const signatureValid =
      ownerIndex === 0n &&
      WebAuthnP256.verify({
        challenge,
        metadata: { authenticatorData: auth.authenticatorData, clientDataJSON, challengeIndex: Number(auth.challengeIndex), typeIndex: Number(auth.typeIndex), userVerificationRequired: true },
        publicKey: { prefix: 4, x: BigInt(`0x${state.ownerKey.slice(2, 66)}`), y: BigInt(`0x${state.ownerKey.slice(66)}`) },
        signature: { r: auth.r, s: auth.s },
      });
    const d = decodeFunctionData({ abi: walletAbi, data: op.callData });
    const calls = d.functionName === "execute" ? [{ target: d.args[0], value: d.args[1], data: d.args[2] }] : d.args[0];
    state.ops.push({ sender, calls: calls.length, withInitCode: op.initCode.length > 2, sponsored: op.paymasterAndData.length > 2, signatureValid });
    if (!signatureValid) {
      if (process.env.DEBUG) console.log("[fake bundler] signature check failed", { ownerIndex, challenge, clientDataJSON, flags: auth.authenticatorData.slice(2 + 64, 2 + 66), typeIndex: auth.typeIndex, challengeIndex: auth.challengeIndex, userOpHash });
      throw new Error("bad passkey signature");
    }

    await rpc("anvil_impersonateAccount", [op.sender]);
    const logs: unknown[] = [];
    let last: unknown;
    let success = true;
    for (const c of calls) {
      const hash = (await rpc("eth_sendTransaction", [{ from: op.sender, to: c.target, data: c.data, value: "0x0", gas: "0x2dc6c0", gasPrice: "0x0" }])) as string;
      let r: { status: string; logs: unknown[] } | undefined;
      while (!r) r = ((await rpc("eth_getTransactionReceipt", [hash])) as typeof r | null) ?? undefined;
      logs.push(...r.logs);
      last = r;
      if (r.status !== "0x1") success = false;
    }
    state.nonces.set(sender, (state.nonces.get(sender) ?? 0n) + 1n);
    state.deployed.add(sender);
    state.results.set(userOpHash, { userOpHash, entryPoint: entryPoint06Address, sender: op.sender, nonce: op.nonce, actualGasCost: "0x0", actualGasUsed: "0x0", success, logs, receipt: last });
    return userOpHash;
  };
  const dummyPaymaster = `0x${"11".repeat(20)}${"00".repeat(64)}` as Hex;
  bundlerHttp = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const call = JSON.parse(body) as { id: number; method: string; params: unknown[] };
    const reply = (result: unknown) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: call.id, result }));
    const fail = (code: number, message: string) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: call.id, error: { code, message } }));
    try {
      switch (call.method) {
        case "eth_chainId":
          return reply(`0x${chainId.toString(16)}`);
        case "eth_supportedEntryPoints":
          return reply([entryPoint06Address]);
        case "eth_estimateUserOperationGas":
          return reply({ preVerificationGas: "0x10000", verificationGasLimit: "0xf4240", callGasLimit: "0x30d40" });
        case "pm_getPaymasterStubData":
        case "pm_getPaymasterData":
          state.paymasterCalls.push(call.method);
          return reply({ paymasterAndData: dummyPaymaster });
        case "eth_sendUserOperation":
          return reply(await sendOp(call.params[0] as Record<string, Hex>));
        case "eth_getUserOperationReceipt":
          return reply(state.results.get(call.params[0] as string) ?? null);
        default:
          return fail(-32601, `the fake bundler does not do ${call.method}`); // includes pimlico_getUserOperationGasPrice: the app falls back
      }
    } catch (e) {
      return fail(-32000, (e as Error).message);
    }
  });
  await new Promise<void>((r) => bundlerHttp!.listen(0, "127.0.0.1", r));
  const bundlerUrl = `http://127.0.0.1:${(bundlerHttp.address() as { port: number }).port}/`;

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
    // The wallet factory and EntryPoint are not on a local chain: answer the three reads the app makes about them.
    await ctx.route("**/rpc", async (route) => {
      const body = JSON.parse(route.request().postData()!) as { id: number; method: string; params: Array<{ to?: string; data?: string } | string> }[] | { id: number; method: string; params: Array<{ to?: string; data?: string } | string> };
      const arr = Array.isArray(body) ? body : [body];
      const out = await Promise.all(
        arr.map(async (c) => {
          const tx = c.params?.[0] as { to?: string; data?: string } | undefined;
          if (c.method === "eth_call" && tx?.to?.toLowerCase() === FACTORY) return { jsonrpc: "2.0", id: c.id, result: pad(`0x${keccak256(tx.data as Hex).slice(-40)}`) }; // a wallet address that depends on the owner key
          if (c.method === "eth_call" && tx?.to?.toLowerCase() === entryPoint06Address.toLowerCase()) {
            const sender = `0x${tx.data!.slice(34, 74)}`; // getNonce(sender, key)
            return { jsonrpc: "2.0", id: c.id, result: pad(`0x${(state.nonces.get(sender) ?? 0n).toString(16)}`, { size: 32 }) };
          }
          if (c.method === "eth_getCode" && state.deployed.has(String(c.params[0]).toLowerCase())) return { jsonrpc: "2.0", id: c.id, result: "0x60" };
          const r = await fetch(`${webUrl}/rpc`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(c) });
          return r.json();
        }),
      );
      await route.fulfill({ contentType: "application/json", body: JSON.stringify(Array.isArray(body) ? out : out[0]) });
    });
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
  state.ownerKey = rec.publicKey;
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
  bundlerHttp?.close();
  anvil.kill();
  process.exit(code);
}
