import test from "node:test";
import assert from "node:assert/strict";
import { decodeFunctionData, type Address, type Hex, type PublicClient } from "viem";
import { addOwnerAddressCall, addOwnerPublicKeyCall, isOwnerAt, isProtected, ownerBytesOfAddress, readOwners, walletAbi } from "./recovery.ts";

const W: Address = "0x00000000000000000000000000000000000000a1";
const KEY = `0x${"ab".repeat(32)}${"cd".repeat(32)}` as Hex;

/** A chain client that answers the wallet's owner questions from a fixed list. */
function client(owners: Hex[] | null): PublicClient {
  return {
    getCode: async () => (owners ? "0x6080" : "0x"),
    readContract: async ({ functionName, args }: { functionName: string; args?: unknown[] }) => {
      if (!owners) throw new Error("no data");
      if (functionName === "ownerCount") return BigInt(owners.length);
      if (functionName === "nextOwnerIndex") return BigInt(owners.length);
      if (functionName === "ownerAtIndex") {
        const o = owners[Number(args![0])];
        if (!o) throw new Error("no owner");
        return o;
      }
      throw new Error(functionName);
    },
  } as unknown as PublicClient;
}

test("a wallet that is not deployed yet has no owners and is not protected", async () => {
  const s = await readOwners(client(null), W);
  assert.deepEqual(s, { deployed: false, count: 0, next: 0 });
  assert.equal(isProtected(s), false);
});

test("one owner is not enough; two are", async () => {
  const one = await readOwners(client([ownerBytesOfAddress(W)]), W);
  assert.deepEqual(one, { deployed: true, count: 1, next: 1 });
  assert.equal(isProtected(one), false);
  const two = await readOwners(client([ownerBytesOfAddress(W), KEY]), W);
  assert.equal(two.next, 2);
  assert.equal(isProtected(two), true);
});

test("an owner is found at its index, and only there", async () => {
  const c = client([ownerBytesOfAddress(W), KEY]);
  assert.equal(await isOwnerAt(c, { address: W, ownerIndex: 1 }, KEY), true);
  assert.equal(await isOwnerAt(c, { address: W, ownerIndex: 0 }, KEY), false, "right key, wrong place");
  assert.equal(await isOwnerAt(c, { address: W, ownerIndex: 5 }, KEY), false, "no owner there");
  assert.equal(await isOwnerAt(client(null), { address: W, ownerIndex: 0 }, KEY), false);
});

test("the calls that add a recovery owner are encoded the way the wallet expects", () => {
  const a = addOwnerAddressCall(W, "0x00000000000000000000000000000000000000b2");
  assert.equal(a.to, W);
  const da = decodeFunctionData({ abi: walletAbi, data: a.data });
  assert.equal(da.functionName, "addOwnerAddress");
  const p = addOwnerPublicKeyCall(W, KEY);
  const dp = decodeFunctionData({ abi: walletAbi, data: p.data });
  assert.equal(dp.functionName, "addOwnerPublicKey");
  assert.deepEqual(dp.args, [`0x${"ab".repeat(32)}`, `0x${"cd".repeat(32)}`]);
});
