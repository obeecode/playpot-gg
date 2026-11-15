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
