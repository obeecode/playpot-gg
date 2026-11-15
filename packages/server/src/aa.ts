// Account-abstraction relay for passkey wallets. The player's browser only ever talks to this server; the server talks to
// the bundler and gas sponsor (paymaster) providers. So a provider that is blocked where the player lives does not matter,
// and the providers' API keys never reach the browser. The server also decides what it is willing to sponsor.
import { decodeFunctionData, getAddress, isAddress, parseAbi, type Address, type Hex } from "viem";

/** The Coinbase Smart Wallet factories (v1.1 and v1). A first transaction may deploy the wallet through one of them. */
export const WALLET_FACTORIES: readonly string[] = ["0xba5ed110efdba3d005bfc882d75358acbbb85842", "0x0ba5ed0c6aa8c49038f819e587e2633c4a9f428a"];

const walletAbi = parseAbi(["function execute(address target, uint256 value, bytes data)", "function executeBatch((address target, uint256 value, bytes data)[] calls)"]);

export const BUNDLER_METHODS = new Set([
  "eth_sendUserOperation",
  "eth_estimateUserOperationGas",
  "eth_getUserOperationReceipt",
  "eth_getUserOperationByHash",
  "eth_supportedEntryPoints",
  "eth_chainId",
  "pimlico_getUserOperationGasPrice",
  "pimlico_getUserOperationStatus",
  "rundler_maxPriorityFeePerGas",
]);
export const PAYMASTER_METHODS = new Set(["pm_getPaymasterStubData", "pm_getPaymasterData"]);

const MAX_CALLS_PER_OP = 8;

export type Sponsorable = { ok: true; sender: Address } | { ok: false; reason: string };

/**
 * Decides whether an operation may be paid for. It must come from a wallet address, may deploy that wallet through a
 * known factory, and may only call the PlayPot contracts (the token and the escrows), with no ETH attached. Anything
 * else (adding an owner, calling another contract, sending value) is refused, so a sponsor policy cannot be drained
 * by someone using our relay for their own purposes.
 */
export function checkSponsorable(userOp: unknown, allowedTargets: readonly Address[]): Sponsorable {
  const op = userOp as { sender?: unknown; initCode?: unknown; factory?: unknown; callData?: unknown } | null;
  if (!op || typeof op !== "object") return { ok: false, reason: "malformed operation" };
  if (typeof op.sender !== "string" || !isAddress(op.sender)) return { ok: false, reason: "bad sender" };
  const initCode = typeof op.initCode === "string" ? op.initCode.toLowerCase() : "0x";
  if (initCode.length > 2 && !WALLET_FACTORIES.some((f) => initCode.startsWith(f))) return { ok: false, reason: "unknown wallet factory" };
  if (typeof op.factory === "string" && op.factory !== "0x" && !WALLET_FACTORIES.includes(op.factory.toLowerCase())) return { ok: false, reason: "unknown wallet factory" };
  if (typeof op.callData !== "string" || !/^0x[0-9a-fA-F]*$/.test(op.callData)) return { ok: false, reason: "bad call data" };

  let calls: Array<{ target: Address; value: bigint }>;
  try {
    const d = decodeFunctionData({ abi: walletAbi, data: op.callData as Hex });
    calls = d.functionName === "execute" ? [{ target: d.args[0], value: d.args[1] }] : d.args[0].map((c) => ({ target: c.target, value: c.value }));
  } catch {
    return { ok: false, reason: "only plain calls from the wallet are sponsored" };
  }
  if (calls.length === 0 || calls.length > MAX_CALLS_PER_OP) return { ok: false, reason: "unsupported number of calls" };
  const allowed = new Set(allowedTargets.map((a) => a.toLowerCase()));
  for (const c of calls) {
    if (!allowed.has(c.target.toLowerCase())) return { ok: false, reason: "that contract is not sponsored" };
    if (c.value !== 0n) return { ok: false, reason: "no ETH may be attached" };
  }
  return { ok: true, sender: getAddress(op.sender) };
}

/** A sliding-window counter per key. */
export class RateLimiter {
  private hits = new Map<string, number[]>();
  private max: number;
  private windowMs: number;
  private now: () => number;
  constructor(max: number, windowMs: number, now: () => number = Date.now) {
    this.max = max;
    this.windowMs = windowMs;
    this.now = now;
  }
  /** Records a hit and says whether it is within the limit. */
  allow(key: string): boolean {
    const t = this.now();
    const recent = (this.hits.get(key) ?? []).filter((x) => t - x < this.windowMs);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(t);
    this.hits.set(key, recent);
    if (this.hits.size > 50_000) this.hits.clear(); // bounded memory
    return true;
  }
}

export interface AaOptions {
  bundlerUrl?: string; // the bundler (and, for providers that serve both, the paymaster) endpoint, including any API key
  paymasterUrl?: string; // the gas sponsor endpoint; leave out to make players pay their own gas
  paymasterContext?: unknown; // for example { sponsorshipPolicyId: "..." }; set by us, never by the browser
  allowedTargets: readonly Address[];
  sponsoredPerSenderPerHour?: number;
  callsPerIpPerHour?: number;
  fetchFn?: typeof fetch;
  now?: () => number;
}

export interface RelayResult {
  status: number;
  body: string;
}

interface RpcCall {
  jsonrpc?: string;
  id?: unknown;
  method?: unknown;
  params?: unknown[];
}

const rpcError = (id: unknown, code: number, message: string): RelayResult => ({
  status: 200,
  body: JSON.stringify({ jsonrpc: "2.0", id: id ?? null, error: { code, message } }),
});

export function createAa(o: AaOptions) {
  const fetchFn = o.fetchFn ?? fetch;
  const now = o.now ?? Date.now;
  const bySender = new RateLimiter(o.sponsoredPerSenderPerHour ?? 120, 3_600_000, now);
  const byIp = new RateLimiter(o.callsPerIpPerHour ?? 3_000, 3_600_000, now);

  /** Provider URLs carry API keys: never let one reach a log or an error message. */
  const redact = (t: string) => t.replace(/(api[-_]?key|apikey|key|token)=[^&\s"']+/gi, "$1=…");

  async function forward(url: string, call: RpcCall): Promise<RelayResult> {
    try {
      const res = await fetchFn(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(call), signal: AbortSignal.timeout(30_000) });
      const text = await res.text();
      if (!res.ok) {
        // Say what the provider said, in a form the browser can show, instead of a bare "HTTP request failed".
        const detail = redact(text.slice(0, 200));
        console.warn(`relay: ${String(call.method)} answered ${res.status}: ${detail}`);
        return rpcError(call.id, -32000, `the bundler service answered ${res.status}: ${detail}`);
      }
      if (text.includes('"error"')) {
        try {
          const msg = (JSON.parse(text) as { error?: { message?: string } }).error?.message;
          if (msg) console.warn(`relay: ${String(call.method)} was refused: ${redact(msg.slice(0, 200))}`);
        } catch {
          /* not JSON: pass it on as it is */
        }
      }
      return { status: res.status, body: text };
    } catch (e) {
      console.warn(`relay: ${String(call.method)} failed: ${redact((e as Error).message.slice(0, 160))}`);
      return rpcError(call.id, -32000, `relay upstream failed: ${redact((e as Error).message.slice(0, 120))}`);
    }
  }

  function parse(bodyText: string): RpcCall | RelayResult {
    let body: unknown;
    try {
      body = JSON.parse(bodyText);
    } catch {
      return rpcError(null, -32700, "parse error");
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) return rpcError(null, -32600, "send one request at a time");
    return body as RpcCall;
  }
  const isResult = (x: RpcCall | RelayResult): x is RelayResult => "status" in x && "body" in x;

  return {
    enabled: !!o.bundlerUrl,
    sponsored: !!o.bundlerUrl && !!o.paymasterUrl,

    /** Bundler calls: send, estimate and look up operations. */
    async bundler(bodyText: string, ip: string): Promise<RelayResult> {
      if (!o.bundlerUrl) return { status: 503, body: JSON.stringify({ error: "passkey wallets are not enabled on this server" }) };
      const call = parse(bodyText);
      if (isResult(call)) return call;
      if (typeof call.method !== "string" || !BUNDLER_METHODS.has(call.method)) return rpcError(call.id, -32601, "method not allowed");
      if (!byIp.allow(ip)) return rpcError(call.id, -32005, "rate limit reached, try again later");
      return forward(o.bundlerUrl, call);
    },

    /** Gas sponsor calls: only for operations that call PlayPot's own contracts. */
    async paymaster(bodyText: string, ip: string): Promise<RelayResult> {
      if (!o.bundlerUrl || !o.paymasterUrl) return { status: 503, body: JSON.stringify({ error: "gas sponsoring is not enabled on this server" }) };
      const call = parse(bodyText);
      if (isResult(call)) return call;
      if (typeof call.method !== "string" || !PAYMASTER_METHODS.has(call.method)) return rpcError(call.id, -32601, "method not allowed");
      if (!byIp.allow(ip)) return rpcError(call.id, -32005, "rate limit reached, try again later");
      const params = Array.isArray(call.params) ? call.params.slice() : [];
      const verdict = checkSponsorable(params[0], o.allowedTargets);
      if (!verdict.ok) return rpcError(call.id, -32602, `not sponsored: ${verdict.reason}`);
      // Only the data call spends the sponsor's money; the stub call just sizes the operation.
      if (call.method === "pm_getPaymasterData" && !bySender.allow(verdict.sender)) return rpcError(call.id, -32005, "this wallet has reached the hourly limit for sponsored actions");
      if (o.paymasterContext !== undefined) {
        while (params.length < 4) params.push(undefined);
        params[3] = o.paymasterContext; // the context comes from the operator, never from the browser
      }
      return forward(o.paymasterUrl, { ...call, params });
    },
  };
}
