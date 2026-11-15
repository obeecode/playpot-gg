import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeFunctionData, parseAbi, type Address, type Hex } from "viem";
import { checkSponsorable, createAa, RateLimiter, WALLET_FACTORIES } from "./aa.ts";
import { PasskeyRegistry } from "./passkeys.ts";

const TOKEN: Address = "0x1111111111111111111111111111111111111111";
const ESCROW: Address = "0x2222222222222222222222222222222222222222";
const OTHER: Address = "0x9999999999999999999999999999999999999999";
const WALLET: Address = "0x00000000000000000000000000000000000000a1";
const ALLOWED = [TOKEN, ESCROW];

const walletAbi = parseAbi(["function execute(address target, uint256 value, bytes data)", "function executeBatch((address target, uint256 value, bytes data)[] calls)", "function addOwnerAddress(address owner)"]);
const batch = (calls: Array<{ target: Address; value?: bigint; data?: Hex }>): Hex =>
  encodeFunctionData({ abi: walletAbi, functionName: "executeBatch", args: [calls.map((c) => ({ target: c.target, value: c.value ?? 0n, data: c.data ?? "0x" }))] });
const op = (callData: Hex, extra: Record<string, unknown> = {}) => ({ sender: WALLET, initCode: "0x", callData, ...extra });

// -------------------------------------------------------------------------------------------- what may be sponsored

test("a batch that approves tokens and calls the escrow is sponsored", () => {
  const v = checkSponsorable(op(batch([{ target: TOKEN }, { target: ESCROW }])), ALLOWED);
  assert.equal(v.ok, true);
});

test("a single execute call to a PlayPot contract is sponsored", () => {
  const callData = encodeFunctionData({ abi: walletAbi, functionName: "execute", args: [ESCROW, 0n, "0x"] });
  assert.equal(checkSponsorable(op(callData), ALLOWED).ok, true);
});

test("calls to any other contract are refused, even inside a batch", () => {
  const v = checkSponsorable(op(batch([{ target: TOKEN }, { target: OTHER }])), ALLOWED);
  assert.deepEqual(v, { ok: false, reason: "that contract is not sponsored" });
});

test("attaching ETH is refused", () => {
  const v = checkSponsorable(op(batch([{ target: ESCROW, value: 1n }])), ALLOWED);
  assert.deepEqual(v, { ok: false, reason: "no ETH may be attached" });
});

test("wallet administration (adding an owner) is refused", () => {
  const callData = encodeFunctionData({ abi: walletAbi, functionName: "addOwnerAddress", args: [OTHER] });
  assert.equal(checkSponsorable(op(callData), ALLOWED).ok, false);
});

test("only the known wallet factories may deploy a wallet through a sponsored operation", () => {
  const ok = checkSponsorable(op(batch([{ target: ESCROW }]), { initCode: WALLET_FACTORIES[0] + "deadbeef" }), ALLOWED);
  assert.equal(ok.ok, true);
  const bad = checkSponsorable(op(batch([{ target: ESCROW }]), { initCode: OTHER + "deadbeef" }), ALLOWED);
  assert.deepEqual(bad, { ok: false, reason: "unknown wallet factory" });
});

test("malformed operations are refused", () => {
  for (const bad of [null, "x", {}, { sender: "nope", callData: "0x" }, { sender: WALLET, callData: "zz" }, { sender: WALLET, callData: "0x" }]) {
    assert.equal(checkSponsorable(bad, ALLOWED).ok, false);
  }
  const many = batch(Array.from({ length: 9 }, () => ({ target: TOKEN })));
  assert.equal(checkSponsorable(op(many), ALLOWED).ok, false, "too many calls in one operation");
});

// ------------------------------------------------------------------------------------------------------ the relay

function relay(opts: { paymaster?: boolean; context?: unknown; perSender?: number } = {}) {
  const sent: Array<{ url: string; body: { method: string; params?: unknown[] } }> = [];
  const fetchFn = (async (url: string, init: { body: string }) => {
    sent.push({ url, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0xok" }), { status: 200 });
  }) as unknown as typeof fetch;
  const aa = createAa({
    bundlerUrl: "https://bundler.example/KEY",
    paymasterUrl: opts.paymaster === false ? undefined : "https://paymaster.example/KEY",
    paymasterContext: opts.context,
    allowedTargets: ALLOWED,
    sponsoredPerSenderPerHour: opts.perSender,
    fetchFn,
  });
  return { aa, sent };
}
const rpc = (method: string, params: unknown[] = []) => JSON.stringify({ jsonrpc: "2.0", id: 7, method, params });

test("bundler calls are relayed, other methods are not", async () => {
  const { aa, sent } = relay();
  const ok = await aa.bundler(rpc("eth_estimateUserOperationGas", [{}, "0xep"]), "1.1.1.1");
  assert.equal(JSON.parse(ok.body).result, "0xok");
  assert.equal(sent[0].url, "https://bundler.example/KEY");
  for (const method of ["eth_sendTransaction", "eth_accounts", "debug_traceCall", "pm_getPaymasterData"]) {
    const r = JSON.parse((await aa.bundler(rpc(method), "1.1.1.1")).body);
    assert.equal(r.error.code, -32601, method);
  }
  assert.equal(sent.length, 1, "nothing else reached the provider");
});

test("batches of requests and junk are refused", async () => {
  const { aa, sent } = relay();
  assert.equal(JSON.parse((await aa.bundler(`[${rpc("eth_chainId")}]`, "1.1.1.1")).body).error.code, -32600);
  assert.equal(JSON.parse((await aa.bundler("not json", "1.1.1.1")).body).error.code, -32700);
  assert.equal(sent.length, 0);
});

test("the sponsor only sees operations that call PlayPot contracts", async () => {
  const { aa, sent } = relay();
  const good = await aa.paymaster(rpc("pm_getPaymasterData", [op(batch([{ target: ESCROW }])), "0xep", "0x14a34", {}]), "2.2.2.2");
  assert.equal(JSON.parse(good.body).result, "0xok");
  const bad = await aa.paymaster(rpc("pm_getPaymasterData", [op(batch([{ target: OTHER }])), "0xep", "0x14a34", {}]), "2.2.2.2");
  assert.match(JSON.parse(bad.body).error.message, /not sponsored/);
  assert.equal(sent.length, 1, "the refused operation never reached the provider");
  assert.equal(sent[0].url, "https://paymaster.example/KEY");
});

test("the sponsorship context comes from the operator, whatever the browser sent", async () => {
  const { aa, sent } = relay({ context: { sponsorshipPolicyId: "sp_ours" } });
  await aa.paymaster(rpc("pm_getPaymasterStubData", [op(batch([{ target: ESCROW }])), "0xep", "0x14a34", { sponsorshipPolicyId: "sp_attacker" }]), "3.3.3.3");
  assert.deepEqual(sent[0].body.params?.[3], { sponsorshipPolicyId: "sp_ours" });
});

test("a wallet is limited in how many sponsored actions it can take per hour", async () => {
  const { aa, sent } = relay({ perSender: 3 });
  const call = () => aa.paymaster(rpc("pm_getPaymasterData", [op(batch([{ target: ESCROW }])), "0xep", "0x14a34", {}]), "4.4.4.4");
  for (let i = 0; i < 3; i++) assert.equal(JSON.parse((await call()).body).result, "0xok");
  assert.match(JSON.parse((await call()).body).error.message, /hourly limit/);
  assert.equal(sent.length, 3);
});

test("without a sponsor configured, passkey wallets still work but gas is not paid for", async () => {
  const { aa } = relay({ paymaster: false });
  assert.equal(aa.enabled, true);
  assert.equal(aa.sponsored, false);
  assert.equal((await aa.paymaster(rpc("pm_getPaymasterData"), "5.5.5.5")).status, 503);
});

test("with no bundler configured, nothing is relayed", async () => {
  const aa = createAa({ allowedTargets: ALLOWED });
  assert.equal(aa.enabled, false);
  assert.equal((await aa.bundler(rpc("eth_chainId"), "6.6.6.6")).status, 503);
});

test("an unreachable provider is reported as an error, not a crash", async () => {
  const aa = createAa({ bundlerUrl: "https://bundler.example", allowedTargets: ALLOWED, fetchFn: (async () => Promise.reject(new Error("ECONNRESET"))) as unknown as typeof fetch });
  const r = JSON.parse((await aa.bundler(rpc("eth_chainId"), "7.7.7.7")).body);
  assert.match(r.error.message, /upstream failed/);
});

test("the rate limiter forgets old hits", () => {
  let t = 0;
  const rl = new RateLimiter(2, 1000, () => t);
  assert.ok(rl.allow("a") && rl.allow("a"));
  assert.equal(rl.allow("a"), false);
  assert.ok(rl.allow("b"), "keys are independent");
  t = 1500;
  assert.ok(rl.allow("a"), "the window moved on");
});

// ---------------------------------------------------------------------------------------- the passkey directory

const ID = "AbCdEfGhIjKlMnOpQrStUv";
const KEY = "0x" + "ab".repeat(64);

test("the first registration of a passkey wins and cannot be replaced", () => {
  const dir = mkdtempSync(join(tmpdir(), "playpot-pk-"));
  const reg = new PasskeyRegistry(dir);
  assert.equal(reg.register(ID, KEY), "created");
  assert.equal(reg.register(ID, KEY), "same");
  assert.equal(reg.register(ID, "0x" + "cd".repeat(64)), "conflict");
  assert.equal(reg.get(ID), KEY);
});

test("malformed registrations are refused", () => {
  const reg = new PasskeyRegistry(mkdtempSync(join(tmpdir(), "playpot-pk-")));
  for (const [id, key] of [["short", KEY], [ID, "0x1234"], [ID, "nothex"], [123, KEY], [ID, null], ["../../etc/passwd/xxxxxxxxxxxx", KEY]]) {
    assert.equal(reg.register(id, key), "invalid");
  }
  assert.equal(reg.size, 0);
  assert.equal(reg.get("../x"), undefined);
});

test("the directory survives a restart and skips damaged lines", () => {
  const dir = mkdtempSync(join(tmpdir(), "playpot-pk-"));
  new PasskeyRegistry(dir).register(ID, KEY);
  writeFileSync(join(dir, "passkeys.jsonl"), '{"id":"' + ID + '","publicKey":"' + KEY + '"}\nnot json\n{"id":"bad"}\n', "utf8");
  const again = new PasskeyRegistry(dir);
  assert.equal(again.get(ID), KEY);
  assert.equal(again.size, 1);
});

test("when the provider answers with an HTTP error, the browser gets that message (with the API key removed)", async () => {
  const warned: string[] = [];
  const realWarn = console.warn;
  console.warn = (m: unknown) => void warned.push(String(m));
  try {
    const aa = createAa({
      bundlerUrl: "https://bundler.example/v2/84532/rpc?apikey=SECRET123",
      allowedTargets: ALLOWED,
      fetchFn: (async () => new Response('{"message":"invalid apikey=SECRET123 for this network"}', { status: 401 })) as unknown as typeof fetch,
    });
    const r = await aa.bundler(rpc("eth_estimateUserOperationGas", [{}, "0xep"]), "8.8.8.8");
    assert.equal(r.status, 200, "a JSON-RPC error the browser can read, not a bare failed request");
    const msg = JSON.parse(r.body).error.message as string;
    assert.match(msg, /answered 401/);
    assert.equal(msg.includes("SECRET123"), false);
    assert.equal(warned.join("\n").includes("SECRET123"), false, "the key is not in the server log either");
    assert.match(warned.join("\n"), /eth_estimateUserOperationGas answered 401/);
  } finally {
    console.warn = realWarn;
  }
});
