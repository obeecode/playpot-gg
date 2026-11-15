import test from "node:test";
import assert from "node:assert/strict";
import { decodeFunctionData, parseAbi, type Address } from "viem";
import { call, sendBatch, type Eip1193 } from "./wallet.ts";

const ME: Address = "0x00000000000000000000000000000000000000a1";
const TOKEN: Address = "0x00000000000000000000000000000000000000b2";
const abi = parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]);

/** A wallet that confirms after `pendingPolls` polls. */
function fakeWallet(opts: { pendingPolls?: number; final?: unknown; idShape?: "string" | "object" } = {}) {
  const seen: Array<{ method: string; params: unknown }> = [];
  let polls = 0;
  const provider: Eip1193 = {
    async request({ method, params }) {
      seen.push({ method, params });
      if (method === "wallet_sendCalls") return opts.idShape === "object" ? { id: "0xabc" } : "0xabc";
      if (method === "wallet_getCallsStatus") {
        polls++;
        if (polls <= (opts.pendingPolls ?? 0)) return { status: 100, receipts: [] };
        return (
          opts.final ?? {
            status: 200,
            receipts: [
              { status: "0x1", transactionHash: "0x11", logs: [{ address: TOKEN, topics: ["0xaa"], data: "0x" }] },
              { status: "0x1", transactionHash: "0x22", logs: [{ address: TOKEN, topics: ["0xbb"], data: "0x" }] },
            ],
          }
        );
      }
      throw new Error(`unexpected ${method}`);
    },
  };
  return { provider, seen };
}

test("calls are encoded and sent as one batch, and the logs of every call come back", async () => {
  const { provider, seen } = fakeWallet({ pendingPolls: 2 });
  const res = await sendBatch(provider, ME, 84532, [call(TOKEN, abi, "approve", [ME, 5n]), call(TOKEN, abi, "approve", [ME, 6n])], { pollMs: 1 });
  assert.equal(res.logs.length, 2);
  assert.deepEqual(res.txHashes, ["0x11", "0x22"]);
  const sent = seen.find((s) => s.method === "wallet_sendCalls")!;
  const p = (sent.params as Array<{ calls: Array<{ to: string; data: `0x${string}`; value: string }>; chainId: string; from: string }>)[0];
  assert.equal(p.chainId, "0x14a34");
  assert.equal(p.from, ME);
  assert.equal(p.calls.length, 2);
  assert.equal(decodeFunctionData({ abi, data: p.calls[1].data }).args?.[1], 6n);
  assert.equal(seen.filter((s) => s.method === "wallet_getCallsStatus").length, 3, "polled until confirmed");
});

test("the gas sponsor is passed to the wallet only when one is set", async () => {
  const withSponsor = fakeWallet();
  await sendBatch(withSponsor.provider, ME, 84532, [call(TOKEN, abi, "approve", [ME, 1n])], { pollMs: 1, paymasterUrl: "https://paymaster.example/rpc" });
  const a = (withSponsor.seen[0].params as Array<{ capabilities?: { paymasterService: { url: string } } }>)[0];
  assert.equal(a.capabilities?.paymasterService.url, "https://paymaster.example/rpc");

  const without = fakeWallet();
  await sendBatch(without.provider, ME, 84532, [call(TOKEN, abi, "approve", [ME, 1n])], { pollMs: 1 });
  assert.equal((without.seen[0].params as Array<{ capabilities?: unknown }>)[0].capabilities, undefined);
});

test("both id shapes and both status styles are understood", async () => {
  const obj = fakeWallet({ idShape: "object", final: { status: "CONFIRMED", receipts: [{ status: "0x1", logs: [] }] } });
  const res = await sendBatch(obj.provider, ME, 84532, [call(TOKEN, abi, "approve", [ME, 1n])], { pollMs: 1 });
  assert.equal(res.id, "0xabc");
});

test("a failed or reverted batch is an error", async () => {
  const failed = fakeWallet({ final: { status: 500, receipts: [] } });
  await assert.rejects(sendBatch(failed.provider, ME, 84532, [call(TOKEN, abi, "approve", [ME, 1n])], { pollMs: 1 }), /failed/);
  const reverted = fakeWallet({ final: { status: 200, receipts: [{ status: "0x0", logs: [] }] } });
  await assert.rejects(sendBatch(reverted.provider, ME, 84532, [call(TOKEN, abi, "approve", [ME, 1n])], { pollMs: 1 }), /failed/);
});

test("a wallet that never confirms times out, and a refusal is passed on", async () => {
  const never = fakeWallet({ pendingPolls: 1_000_000 });
  await assert.rejects(sendBatch(never.provider, ME, 84532, [call(TOKEN, abi, "approve", [ME, 1n])], { pollMs: 1, timeoutMs: 30 }), /timed out/);
  const refuses: Eip1193 = { request: async () => Promise.reject(new Error("User rejected the request")) };
  await assert.rejects(sendBatch(refuses, ME, 84532, [call(TOKEN, abi, "approve", [ME, 1n])]), /rejected/);
});

// ------------------------------------------------------------------------------------------- the passkey wallet adapter

import { rpIdFor, smartProvider, type BundlerLike } from "./passkey.ts";

class NotFound extends Error {
  override name = "UserOperationReceiptNotFoundError";
}

function fakeBundler(opts: { pending?: number; success?: boolean } = {}) {
  const sentOps: Array<{ calls: Array<{ to: Address; data: string; value: bigint }> }> = [];
  let polls = 0;
  const bundler: BundlerLike = {
    async sendUserOperation(args) {
      sentOps.push(args);
      return "0x1234";
    },
    async getUserOperationReceipt() {
      if (++polls <= (opts.pending ?? 0)) throw new NotFound("User Operation receipt with hash could not be found");
      return { success: opts.success ?? true, logs: [{ address: TOKEN, topics: ["0xaa"], data: "0x" }], receipt: { transactionHash: "0x99" } };
    },
  };
  return { bundler, sentOps };
}

test("a passkey wallet answers the account questions the app asks", async () => {
  const p = smartProvider(ME, fakeBundler().bundler);
  assert.deepEqual(await p.request({ method: "eth_requestAccounts" }), [ME]);
  assert.deepEqual(await p.request({ method: "eth_accounts" }), [ME]);
  assert.equal(await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x14a34" }] }), null);
  await assert.rejects(p.request({ method: "eth_sendTransaction", params: [{}] }), /does not do/);
});

test("a batch becomes one user operation, and its receipt reads back as a confirmed batch", async () => {
  const { bundler, sentOps } = fakeBundler({ pending: 2 });
  const res = await sendBatch(smartProvider(ME, bundler), ME, 84532, [call(TOKEN, abi, "approve", [ME, 5n]), call(TOKEN, abi, "approve", [ME, 6n])], { pollMs: 1 });
  assert.equal(sentOps.length, 1, "one operation, one passkey prompt");
  assert.equal(sentOps[0].calls.length, 2);
  assert.equal(sentOps[0].calls[0].to, TOKEN);
  assert.equal(sentOps[0].calls[0].value, 0n);
  assert.equal(res.id, "0x1234");
  assert.deepEqual(res.txHashes, ["0x99"]);
  assert.equal(res.logs.length, 1);
});

test("a user operation that reverts is reported as a failed batch", async () => {
  const { bundler } = fakeBundler({ success: false });
  await assert.rejects(sendBatch(smartProvider(ME, bundler), ME, 84532, [call(TOKEN, abi, "approve", [ME, 1n])], { pollMs: 1 }), /failed/);
});

test("other bundler errors are not mistaken for 'still pending'", async () => {
  const bundler: BundlerLike = {
    sendUserOperation: async () => "0x1",
    getUserOperationReceipt: async () => Promise.reject(new Error("the bundler is down")),
  };
  await assert.rejects(sendBatch(smartProvider(ME, bundler), ME, 84532, [call(TOKEN, abi, "approve", [ME, 1n])], { pollMs: 1 }), /bundler is down/);
});

test("passkeys are tied to playpot.gg for every subdomain, and to the host elsewhere", () => {
  assert.equal(rpIdFor("app.playpot.gg"), "playpot.gg");
  assert.equal(rpIdFor("playpot.gg"), "playpot.gg");
  assert.equal(rpIdFor("www.playpot.gg"), "playpot.gg");
  assert.equal(rpIdFor("localhost"), "localhost");
  assert.equal(rpIdFor("evilplaypot.gg"), "evilplaypot.gg", "a look-alike domain does not share the passkey");
});
