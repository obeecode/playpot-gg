// Smart-wallet plumbing: batched calls (EIP-5792) with an optional gas sponsor (a paymaster).
// Kept free of DOM and app state so it can be tested with a fake provider.
import { encodeFunctionData, toHex, type Abi, type Address, type Hex } from "viem";

export interface Eip1193 {
  request(args: { method: string; params?: unknown }): Promise<unknown>;
}

export interface Call {
  to: Address;
  data: Hex;
  value?: bigint;
}

export interface BatchLog {
  address: Address;
  topics: Hex[];
  data: Hex;
}

export interface BatchResult {
  id: string;
  logs: BatchLog[]; // every log of every call, in order
  txHashes: Hex[];
}

export const call = (to: Address, abi: unknown, functionName: string, args: unknown[]): Call => ({
  to,
  data: encodeFunctionData({ abi: abi as Abi, functionName, args } as never),
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Status of a batch as reported by wallets: a number (EIP-5792 v2) or a word (v1). */
function classify(status: unknown): "pending" | "done" | "failed" {
  if (typeof status === "number") return status >= 400 ? "failed" : status >= 200 ? "done" : "pending";
  const s = String(status ?? "").toUpperCase();
  if (s === "CONFIRMED" || s === "SUCCESS") return "done";
  if (s === "FAILED" || s === "REVERTED") return "failed";
  return "pending";
}

interface RawReceipt {
  status?: string | number;
  logs?: BatchLog[];
  transactionHash?: Hex;
}

export interface BatchOptions {
  paymasterUrl?: string; // tells the wallet a gas sponsor is available, so the player needs no ETH
  pollMs?: number;
  timeoutMs?: number;
}

/**
 * Sends the calls as one batch (one confirmation for the player, atomic) and waits until it is on-chain.
 * Throws if the wallet refuses, the batch fails, or it takes longer than the timeout.
 */
export async function sendBatch(provider: Eip1193, from: Address, chainId: number, calls: Call[], opts: BatchOptions = {}): Promise<BatchResult> {
  const params = {
    version: "1.0",
    from,
    chainId: toHex(chainId),
    calls: calls.map((c) => ({ to: c.to, data: c.data, value: toHex(c.value ?? 0n) })),
    ...(opts.paymasterUrl ? { capabilities: { paymasterService: { url: opts.paymasterUrl } } } : {}),
  };
  const sent = (await provider.request({ method: "wallet_sendCalls", params: [params] })) as string | { id: string };
  const id = typeof sent === "string" ? sent : sent.id;

  const pollMs = opts.pollMs ?? 1500;
  const deadline = Date.now() + (opts.timeoutMs ?? 120_000);
  for (;;) {
    const st = (await provider.request({ method: "wallet_getCallsStatus", params: [id] })) as { status?: unknown; receipts?: RawReceipt[] } | null;
    const kind = classify(st?.status);
    const receipts = st?.receipts ?? [];
    if (kind === "failed" || receipts.some((r) => r.status === "0x0" || r.status === 0)) throw new Error("the batch failed on-chain");
    if (kind === "done") {
      return {
        id,
        logs: receipts.flatMap((r) => r.logs ?? []),
        txHashes: receipts.map((r) => r.transactionHash).filter((h): h is Hex => !!h),
      };
    }
    if (Date.now() > deadline) throw new Error("timed out waiting for the batch to confirm");
    await sleep(pollMs);
  }
}
