import type { Address } from "viem";
import { potEscrowAbi, testTokenAbi } from "@playpot/game";
import type { Chain } from "./chain.ts";

const MULTICALL3: Address = "0xcA11bde05977b3631167028862bE2a173976CA11";
const TTL_MS = 1500;
const WINDOW_IDS = 30n;

interface Cached<T> {
  at: number;
  data: Promise<T>;
}

/** Cached chain reads shared by every client, so the number of RPC calls does not grow with users. */
export class Snapshots {
  private chain: Chain;
  private token: Address;
  private shared?: Cached<unknown>;
  private perAddr = new Map<string, Cached<unknown>>();
  private noMulticall = false;

  constructor(chain: Chain, token: Address) {
    this.chain = chain;
    this.token = token;
  }

  private cached<T>(slot: Cached<unknown> | undefined, load: () => Promise<T>, set: (c: Cached<T>) => void): Promise<T> {
    if (slot && Date.now() - slot.at < TTL_MS) return slot.data as Promise<T>;
    const c = { at: Date.now(), data: load() };
    c.data.catch(() => set({ at: 0, data: c.data })); // do not cache failures
    set(c);
    return c.data;
  }

  private read(functionName: string, args: unknown[] = []) {
    const { pub, escrow } = this.chain;
    return pub.readContract({ address: escrow, abi: potEscrowAbi, functionName, args } as never) as Promise<never>;
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
      { address: escrow, abi: potEscrowAbi, functionName: "offers", args: [id] },
      { address: escrow, abi: potEscrowAbi, functionName: "getMatch", args: [id] },
    ]);
    let out: unknown[] = [];
    if (ids.length) {
      try {
        if (this.noMulticall) throw new Error("no multicall");
        out = (await pub.multicall({ multicallAddress: MULTICALL3, contracts: calls as never, allowFailure: false })) as unknown[];
      } catch {
        this.noMulticall = true; // local chains have no Multicall3
        out = await Promise.all(
          calls.map((c) => pub.readContract({ address: c.address, abi: c.abi, functionName: c.functionName, args: c.args } as never)),
        );
      }
    }
    const rows = ids.map((id, i) => {
      const o = out[2 * i] as readonly [Address, Address, bigint, bigint, boolean];
      return {
        id,
        offer: { creator: o[0], sessionKey: o[1], stake: o[2], expiry: o[3], open: o[4] },
        match: out[2 * i + 1],
      };
    });
    return { now: block.timestamp, bond, nextId, rows };
  }

  getShared() {
    return this.cached(this.shared, () => this.loadShared(), (c) => (this.shared = c));
  }

  getAccount(addr: Address) {
    const key = addr.toLowerCase();
    if (this.perAddr.size > 2000) this.perAddr.clear();
    return this.cached(
      this.perAddr.get(key),
      async () => {
        const { pub, escrow } = this.chain;
        const [eth, tokens, allowance, claimable] = await Promise.all([
          pub.getBalance({ address: addr }),
          pub.readContract({ address: this.token, abi: testTokenAbi, functionName: "balanceOf", args: [addr] }),
          pub.readContract({ address: this.token, abi: testTokenAbi, functionName: "allowance", args: [addr, escrow] }),
          this.read("claimable", [addr]) as Promise<bigint>,
        ]);
        return { eth, tokens, allowance, claimable };
      },
      (c) => this.perAddr.set(key, c),
    );
  }

  getMatch(id: bigint) {
    return this.read("getMatch", [id]);
  }
}
