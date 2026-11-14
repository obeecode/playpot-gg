import type { Address } from "viem";
import { testTokenAbi } from "@playpot/game";
import type { Chain } from "./chain.ts";

const MULTICALL3: Address = "0xcA11bde05977b3631167028862bE2a173976CA11";
const multicallAbi = [
  {
    type: "function",
    name: "getEthBalance",
    stateMutability: "view",
    inputs: [{ name: "addr", type: "address" }],
    outputs: [{ name: "balance", type: "uint256" }],
  },
] as const;

const SHARED_TTL_MS = 3000; // offers and matches: one read serves every client
const ACCOUNT_TTL_MS = 5000;
const MATCH_TTL_MS = 2000;
const MIN_REUSE_MS = 1000; // even a "fresh" request reuses anything younger than this, so it cannot be used to hammer the RPC
const WINDOW_IDS = 30n;

interface Cached<T> {
  at: number;
  data: Promise<T>;
}

/**
 * Cached chain reads. The shared lobby snapshot and each match's status are read once for everyone. A player's own
 * balances are one batched call, and clients only ask for them when something changed (after their own transaction,
 * on load, when the tab regains focus, and occasionally), so RPC use follows activity, not open tabs.
 */
export class Snapshots {
  private chain: Chain;
  private token: Address;
  private shared?: Cached<unknown>;
  private perAddr = new Map<string, Cached<unknown>>();
  private perMatch = new Map<string, Cached<unknown>>();
  private noMulticall = false;

  constructor(chain: Chain, token: Address) {
    this.chain = chain;
    this.token = token;
  }

  private cached<T>(slot: Cached<unknown> | undefined, ttl: number, fresh: boolean, load: () => Promise<T>, set: (c: Cached<T>) => void): Promise<T> {
    const age = slot ? Date.now() - slot.at : Infinity;
    if (slot && age < (fresh ? MIN_REUSE_MS : ttl)) return slot.data as Promise<T>;
    const c = { at: Date.now(), data: load() };
    c.data.catch(() => set({ at: 0, data: c.data })); // do not cache failures
    set(c);
    return c.data;
  }

  private read(functionName: string, args: unknown[] = []) {
    const { pub, escrow } = this.chain;
    return pub.readContract({ address: escrow, abi: this.chain.abi, functionName, args } as never) as Promise<never>;
  }

  /** One batched eth_call when Multicall3 exists (every public chain), otherwise one call each (local chains). */
  private async batch(calls: Array<{ address: Address; abi: unknown; functionName: string; args: unknown[] }>): Promise<unknown[]> {
    const { pub } = this.chain;
    try {
      if (this.noMulticall) throw new Error("no multicall");
      return (await pub.multicall({ multicallAddress: MULTICALL3, contracts: calls as never, allowFailure: false })) as unknown[];
    } catch {
      this.noMulticall = true;
      return Promise.all(
        calls.map((c) =>
          c.functionName === "getEthBalance"
            ? pub.getBalance({ address: c.args[0] as Address })
            : pub.readContract({ address: c.address, abi: c.abi, functionName: c.functionName, args: c.args } as never),
        ),
      );
    }
  }

  private async loadShared() {
    const { pub, escrow } = this.chain;
    const [block, bond, nextId] = await Promise.all([
      pub.getBlock(),
      this.read("disputeBond") as Promise<bigint>,
      this.read("nextId") as Promise<bigint>,
    ]);
    const from = nextId > WINDOW_IDS ? nextId - WINDOW_IDS : 1n;
    const ids: bigint[] = [];
    for (let i = from; i < nextId; i++) ids.push(i);
    const calls = ids.flatMap((id) => [
      { address: escrow, abi: this.chain.abi, functionName: "offers", args: [id] },
      { address: escrow, abi: this.chain.abi, functionName: "getMatch", args: [id] },
    ]);
    const out = ids.length ? await this.batch(calls) : [];
    const rows = ids.map((id, i) => {
      const o = out[2 * i] as readonly unknown[];
      const jinx = o.length === 6; // JINX offers carry bestOf before the open flag
      return {
        id,
        offer: {
          creator: o[0],
          sessionKey: o[1],
          stake: o[2],
          expiry: o[3],
          bestOf: jinx ? o[4] : undefined,
          open: jinx ? o[5] : o[4],
        },
        match: out[2 * i + 1],
      };
    });
    return { now: block.timestamp, bond, nextId, rows };
  }

  getShared(fresh = false) {
    return this.cached(this.shared, SHARED_TTL_MS, fresh, () => this.loadShared(), (c) => (this.shared = c));
  }

  getAccount(addr: Address, fresh = false) {
    const key = addr.toLowerCase();
    if (this.perAddr.size > 2000) this.perAddr.clear();
    return this.cached(
      this.perAddr.get(key),
      ACCOUNT_TTL_MS,
      fresh,
      async () => {
        const { escrow } = this.chain;
        const [eth, tokens, allowance, claimable] = (await this.batch([
          { address: MULTICALL3, abi: multicallAbi, functionName: "getEthBalance", args: [addr] },
          { address: this.token, abi: testTokenAbi, functionName: "balanceOf", args: [addr] },
          { address: this.token, abi: testTokenAbi, functionName: "allowance", args: [addr, escrow] },
          { address: escrow, abi: this.chain.abi, functionName: "claimable", args: [addr] },
        ])) as [bigint, bigint, bigint, bigint];
        return { eth, tokens, allowance, claimable };
      },
      (c) => this.perAddr.set(key, c),
    );
  }

  getMatch(id: bigint, fresh = false) {
    const key = id.toString();
    if (this.perMatch.size > 2000) this.perMatch.clear();
    return this.cached(this.perMatch.get(key), MATCH_TTL_MS, fresh, () => this.read("getMatch", [id]), (c) => this.perMatch.set(key, c));
  }
}
