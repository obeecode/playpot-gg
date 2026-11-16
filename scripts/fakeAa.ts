// A fake ERC-4337 bundler and gas sponsor, for browser tests. It checks what a real one would not tell us (that every
// operation is signed by the right owner over the right hash, that gas was sponsored, that the wallet deploys through the
// known factory on its first operation) and then executes the calls as the wallet on a local chain, so the tests can play
// real games through it. It cannot check the wallet contract or a real bundler: those need a live network.
import { createServer } from "node:http";
import { decodeAbiParameters, decodeFunctionData, encodeAbiParameters, getAddress, hexToString, keccak256, pad, parseAbi, recoverAddress, toFunctionSelector, type Address, type Hex } from "viem";
import { entryPoint06Address, getUserOperationHash } from "viem/account-abstraction";
import { WebAuthnP256 } from "ox";
import type { BrowserContext } from "playwright-core";

export const FACTORY = "0xba5ed110efdba3d005bfc882d75358acbbb85842";
const walletAbi = parseAbi(["function execute(address target, uint256 value, bytes data)", "function executeBatch((address target, uint256 value, bytes data)[] calls)"]);
const factoryAbi = parseAbi(["function createAccount(bytes[] owners, uint256 nonce)"]);
const ownerAbi = parseAbi(["function addOwnerAddress(address owner)", "function addOwnerPublicKey(bytes32 x, bytes32 y)"]);
const SEL = {
  ownerCount: toFunctionSelector("ownerCount()"),
  nextOwnerIndex: toFunctionSelector("nextOwnerIndex()"),
  ownerAtIndex: toFunctionSelector("ownerAtIndex(uint256)"),
};
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
const sigWrapper = [{ components: [{ name: "ownerIndex", type: "uint256" }, { name: "signatureData", type: "bytes" }], type: "tuple" }] as const;

export interface FakeOp {
  sender: string;
  calls: number;
  withInitCode: boolean;
  sponsored: boolean;
  signatureValid: boolean;
}

export interface OwnerCheck {
  userOpHash: Hex;
  ownerIndex: bigint;
  signatureData: Hex; // the owner's signature, as the wallet contract receives it
  sender: Address;
  ownerBytes?: Hex; // the owner at that index: a 32-byte padded address, or a 64-byte passkey public key
}

/**
 * What the wallet contract does with a signature: check it against the owner at that index. An address owner signs the
 * hash directly; a passkey owner signs through WebAuthn.
 */
export async function verifyOwnerSignature(c: OwnerCheck): Promise<boolean> {
  if (!c.ownerBytes) return false;
  if (c.ownerBytes.length === 2 + 64) {
    if (c.signatureData.length !== 2 + 65 * 2) return false;
    return (await recoverAddress({ hash: c.userOpHash, signature: c.signatureData })) === getAddress(`0x${c.ownerBytes.slice(-40)}`);
  }
  if (c.ownerBytes.length !== 2 + 128) return false;
  const [auth] = decodeAbiParameters(webAuthnAuth, c.signatureData);
  return WebAuthnP256.verify({
    challenge: c.userOpHash,
    metadata: { authenticatorData: auth.authenticatorData, clientDataJSON: hexToString(auth.clientDataJSON), challengeIndex: Number(auth.challengeIndex), typeIndex: Number(auth.typeIndex), userVerificationRequired: true },
    publicKey: { prefix: 4, x: BigInt(`0x${c.ownerBytes.slice(2, 66)}`), y: BigInt(`0x${c.ownerBytes.slice(66)}`) },
    signature: { r: auth.r, s: auth.s },
  });
}

type Rpc = (method: string, params: unknown[]) => Promise<unknown>;

export async function startFakeAa(o: { rpc: Rpc; chainId: number; ownerCheck?: (c: OwnerCheck) => boolean | Promise<boolean> }) {
  const ownerCheck = o.ownerCheck ?? verifyOwnerSignature;
  const state = {
    owners: new Map<string, Hex[]>(), // wallet -> its owners, as the wallet contract would keep them
    adminCalls: [] as string[],
    nonces: new Map<string, bigint>(),
    deployed: new Set<string>(),
    ops: [] as FakeOp[],
    results: new Map<string, unknown>(),
    paymasterCalls: [] as string[],
  };

  const sendOp = async (op: Record<string, Hex>) => {
    const sender = op.sender.toLowerCase();
    const userOpHash = getUserOperationHash({
      chainId: o.chainId,
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
    // A first operation deploys the wallet through the factory, which sets its first owner(s).
    if (op.initCode.length > 2) {
      const created = decodeFunctionData({ abi: factoryAbi, data: `0x${op.initCode.slice(42)}` as Hex });
      state.owners.set(sender, [...created.args[0]] as Hex[]);
    }
    const [{ ownerIndex, signatureData }] = decodeAbiParameters(sigWrapper, op.signature);
    const signatureValid = await ownerCheck({ userOpHash, ownerIndex, signatureData, sender: op.sender as Address, ownerBytes: state.owners.get(sender)?.[Number(ownerIndex)] });
    const d = decodeFunctionData({ abi: walletAbi, data: op.callData });
    const calls = d.functionName === "execute" ? [{ target: d.args[0], value: d.args[1], data: d.args[2] }] : d.args[0];
    state.ops.push({ sender, calls: calls.length, withInitCode: op.initCode.length > 2, sponsored: op.paymasterAndData.length > 2, signatureValid });
    if (!signatureValid) throw new Error("bad owner signature");

    await o.rpc("anvil_impersonateAccount", [op.sender]);
    const logs: unknown[] = [];
    let last: unknown;
    let success = true;
    for (const c of calls) {
      if (c.target.toLowerCase() === sender) {
        // a call from the wallet to itself: adding an owner changes the wallet's owner list
        const a = decodeFunctionData({ abi: ownerAbi, data: c.data });
        const list = state.owners.get(sender) ?? [];
        list.push(a.functionName === "addOwnerAddress" ? pad(a.args[0], { size: 32 }) : (`0x${a.args[0].slice(2)}${a.args[1].slice(2)}` as Hex));
        state.owners.set(sender, list);
        state.adminCalls.push(a.functionName);
        continue;
      }
      const hash = (await o.rpc("eth_sendTransaction", [{ from: op.sender, to: c.target, data: c.data, value: "0x0", gas: "0x2dc6c0", gasPrice: "0x0" }])) as string;
      let r: { status: string; logs: unknown[] } | undefined;
      while (!r) r = ((await o.rpc("eth_getTransactionReceipt", [hash])) as typeof r | null) ?? undefined;
      logs.push(...r.logs);
      last = r;
      if (r.status !== "0x1") success = false;
    }
    if (!last) {
      // an operation that only administers the wallet still lands in a bundle transaction on a real chain
      const hash = (await o.rpc("eth_sendTransaction", [{ from: op.sender, to: op.sender, value: "0x0", gas: "0x5208", gasPrice: "0x0" }])) as string;
      let r: { status: string; logs: unknown[] } | undefined;
      while (!r) r = ((await o.rpc("eth_getTransactionReceipt", [hash])) as typeof r | null) ?? undefined;
      last = r;
    }
    state.nonces.set(sender, (state.nonces.get(sender) ?? 0n) + 1n);
    state.deployed.add(sender);
    state.results.set(userOpHash, { userOpHash, entryPoint: entryPoint06Address, sender: op.sender, nonce: op.nonce, actualGasCost: "0x0", actualGasUsed: "0x0", success, logs, receipt: last });
    return userOpHash;
  };

  const dummyPaymaster = `0x${"11".repeat(20)}${"00".repeat(64)}` as Hex;
  const http = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const call = JSON.parse(body) as { id: number; method: string; params: unknown[] };
    const reply = (result: unknown) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: call.id, result }));
    const fail = (code: number, message: string) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: call.id, error: { code, message } }));
    try {
      switch (call.method) {
        case "eth_chainId":
          return reply(`0x${o.chainId.toString(16)}`);
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
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(http.address() as { port: number }).port}/`;

  return {
    url,
    state,
    close: () => http.close(),
    /** The wallet factory and the EntryPoint are not on a local chain: answer the three reads the app makes about them. */
    async stubChainReads(ctx: BrowserContext, webUrl: string) {
      await ctx.route("**/rpc", async (route) => {
        type Call = { id: number; method: string; params: Array<{ to?: string; data?: string } | string> };
        const body = JSON.parse(route.request().postData()!) as Call[] | Call;
        const arr = Array.isArray(body) ? body : [body];
        const out = await Promise.all(
          arr.map(async (c) => {
            const tx = c.params?.[0] as { to?: string; data?: string } | undefined;
            if (c.method === "eth_call" && tx?.to?.toLowerCase() === FACTORY) return { jsonrpc: "2.0", id: c.id, result: pad(`0x${keccak256(tx.data as Hex).slice(-40)}`) }; // a wallet address that depends on the owner
            if (c.method === "eth_call" && tx?.to?.toLowerCase() === entryPoint06Address.toLowerCase()) {
              const sender = `0x${tx.data!.slice(34, 74)}`; // getNonce(sender, key)
              return { jsonrpc: "2.0", id: c.id, result: pad(`0x${(state.nonces.get(sender) ?? 0n).toString(16)}`, { size: 32 }) };
            }
            if (c.method === "eth_getCode" && state.deployed.has(String(c.params[0]).toLowerCase())) return { jsonrpc: "2.0", id: c.id, result: "0x60" };
            // the wallet's own owner questions, answered from the list the fake keeps
            const walletOwners = c.method === "eth_call" && tx?.to ? state.owners.get(tx.to.toLowerCase()) : undefined;
            if (walletOwners && tx?.data) {
              const sel = tx.data.slice(0, 10);
              if (sel === SEL.ownerCount || sel === SEL.nextOwnerIndex) return { jsonrpc: "2.0", id: c.id, result: pad(`0x${walletOwners.length.toString(16)}`, { size: 32 }) };
              if (sel === SEL.ownerAtIndex) {
                const at = walletOwners[Number(BigInt(`0x${tx.data.slice(10, 74)}`))];
                if (!at) return { jsonrpc: "2.0", id: c.id, error: { code: 3, message: "execution reverted" } };
                return { jsonrpc: "2.0", id: c.id, result: encodeAbiParameters([{ type: "bytes" }], [at]) };
              }
            }
            const r = await fetch(`${webUrl}/rpc`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(c) });
            return r.json();
          }),
        );
        await route.fulfill({ contentType: "application/json", body: JSON.stringify(Array.isArray(body) ? out : out[0]) });
      });
    },
  };
}
