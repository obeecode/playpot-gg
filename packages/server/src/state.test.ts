import test from "node:test";
import assert from "node:assert/strict";
import type { Address } from "viem";
import { Snapshots } from "./state.ts";

const ME = "0x00000000000000000000000000000000000000aa" as Address;
const TOKEN = "0x00000000000000000000000000000000000000bb" as Address;

/** A chain stand-in that counts every RPC request the snapshots make. */
function fakeChain(opts: { multicall: boolean; nextId?: bigint } = { multicall: true }) {
  const calls = { getBlock: 0, readContract: 0, multicall: 0, getBalance: 0 };
  const offer = ["0x01", "0x02", 100n, 999n, true] as const;
  const pub = {
    getBlock: async () => (calls.getBlock++, { timestamp: 1000n }),
    getBalance: async () => (calls.getBalance++, 7n),
    readContract: async (a: { functionName: string }) => {
      calls.readContract++;
      if (a.functionName === "nextId") return opts.nextId ?? 4n;
      if (a.functionName === "disputeBond") return 5n;
      if (a.functionName === "offers") return offer;
      return { status: 1 };
    },
    multicall: async (a: { contracts: Array<{ functionName: string }> }) => {
      calls.multicall++;
      if (!opts.multicall) throw new Error("no multicall3 on this chain");
      return a.contracts.map((c) => (c.functionName === "offers" ? offer : c.functionName === "getMatch" ? { status: 1 } : 1n));
    },
  };
  const chain = { pub, escrow: "0x00000000000000000000000000000000000000cc", abi: [] };
  return { snaps: new Snapshots(chain as never, TOKEN), calls };
}

let clock = 1_000_000;
const realNow = Date.now;
test.before(() => {
  Date.now = () => clock;
});
test.after(() => {
  Date.now = realNow;
});

test("fifty clients polling the lobby cost one read, not fifty", async () => {
  const { snaps, calls } = fakeChain();
  clock += 10_000;
  await Promise.all(Array.from({ length: 50 }, () => snaps.getShared()));
  assert.deepEqual(calls, { getBlock: 1, readContract: 2, multicall: 1, getBalance: 0 });
  clock += 1000; // still inside the cache window
  await snaps.getShared();
  assert.equal(calls.getBlock, 1);
  clock += 5000; // expired: one more read
  await snaps.getShared();
  assert.equal(calls.getBlock, 2);
});

test("a player's four balances are one batched call", async () => {
  const { snaps, calls } = fakeChain();
  clock += 10_000;
  const acct = await snaps.getAccount(ME);
  assert.deepEqual(acct, { eth: 1n, tokens: 1n, allowance: 1n, claimable: 1n });
  assert.deepEqual(calls, { getBlock: 0, readContract: 0, multicall: 1, getBalance: 0 });
  await snaps.getAccount(ME); // cached
  assert.equal(calls.multicall, 1);
});

test("on a chain without Multicall3 it falls back to single calls, and stops retrying the batch", async () => {
  const { snaps, calls } = fakeChain({ multicall: false });
  clock += 10_000;
  await snaps.getAccount(ME);
  assert.equal(calls.multicall, 1);
  assert.equal(calls.getBalance, 1);
  assert.equal(calls.readContract, 3);
  clock += 10_000;
  await snaps.getAccount(ME);
  assert.equal(calls.multicall, 1, "does not try the batch again");
});

test("'fresh' requests are honoured but cannot be used to hammer the node", async () => {
  const { snaps, calls } = fakeChain();
  clock += 10_000;
  await snaps.getShared();
  await Promise.all(Array.from({ length: 30 }, () => snaps.getShared(true))); // same instant: reused
  assert.equal(calls.getBlock, 1);
  clock += 1500; // older than the minimum reuse window, newer than the normal TTL
  await snaps.getShared(true);
  assert.equal(calls.getBlock, 2, "a fresh request after a second does re-read");
});

test("match status is cached per match and shared by both players", async () => {
  const { snaps, calls } = fakeChain();
  clock += 10_000;
  await Promise.all([snaps.getMatch(7n), snaps.getMatch(7n), snaps.getMatch(7n)]);
  assert.equal(calls.readContract, 1);
  await snaps.getMatch(8n);
  assert.equal(calls.readContract, 2);
});

test("failed reads are not cached", async () => {
  let fail = true;
  const chain = {
    pub: {
      getBlock: async () => {
        if (fail) throw new Error("rpc down");
        return { timestamp: 1n };
      },
      readContract: async () => 0n,
      multicall: async () => [],
    },
    escrow: "0x00000000000000000000000000000000000000cc",
    abi: [],
  };
  const snaps = new Snapshots(chain as never, TOKEN);
  clock += 10_000;
  await assert.rejects(snaps.getShared());
  fail = false;
  clock += 1;
  await snaps.getShared(true); // recovers on the next request
});
