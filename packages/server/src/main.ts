import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, normalize, resolve, sep } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { privateKeyToAccount } from "viem/accounts";
import { eip712Domain, jinxDomain, jinxEscrowV2Abi, type ClientMsg, type MatchLog, type ServerMsg } from "@playpot/game";
import type { Address, Hex } from "viem";
import { isAddress } from "viem";
import { Chain } from "./chain.ts";
import { Snapshots } from "./state.ts";
import { Room } from "./room.ts";
import { JinxHost } from "./jinxHost.ts";
import { createAa } from "./aa.ts";
import { PasskeyRegistry } from "./passkeys.ts";
import { EmailAuth, brevoMailer, type Mailer } from "./email.ts";
import type { JinxRoomOptions } from "./jinxRoom.ts";

export interface ServerConfig {
  rpcUrl: string;
  publicRpcUrl?: string;
  escrow: Address;
  refereePk: Hex;
  relayerPk?: Hex;
  port: number;
  dataDir: string;
  resultWaitMs: number;
  jinxEscrow?: Address; // also run JINX matches for this escrow
  jinxRoom?: JinxRoomOptions;
  clock?: () => number; // tests inject a fake clock
  webDir?: string; // serve the built web client from this folder
  bundlerUrl?: string; // enables passkey wallets: the ERC-4337 bundler endpoint the server relays to (keep the API key here, not in the browser)
  paymasterUrl?: string; // also sponsors gas, so passkey players need no ETH; for providers that serve both, the same URL as the bundler
  paymasterContext?: unknown; // for example { sponsorshipPolicyId: "sp_..." }, added by the server to every sponsor request
  brevoApiKey?: string; // with emailFrom, switches on email sign-in (codes are sent through Brevo)
  emailFrom?: string; // a sender address verified in Brevo, for example no-reply@playpot.gg
  emailFromName?: string;
  mailer?: Mailer; // tests inject one
  requireRecovery?: boolean; // default true: gas is not sponsored for staking from a wallet that has no recovery method
  walletProtected?: (wallet: Address) => Promise<boolean>; // tests inject one; the default reads the wallet's owner count from the chain
  proxyRpc?: boolean; // expose a restricted /rpc proxy so browsers need no direct chain access (local chains)
}

export async function startServer(cfg: ServerConfig) {
  const referee = privateKeyToAccount(cfg.refereePk);
  const relayer = privateKeyToAccount(cfg.relayerPk ?? cfg.refereePk);
  const chain = new Chain(cfg.rpcUrl, cfg.escrow, relayer);
  await chain.init();
  const domain = eip712Domain(chain.chainId, cfg.escrow);
  const tokenAddr = await chain.token();
  mkdirSync(cfg.dataDir, { recursive: true });
  const snapshots = new Snapshots(chain, tokenAddr);

  const clock = cfg.clock ?? Date.now;
  let jinxChain: Chain | undefined;
  let jinxSnapshots: Snapshots | undefined;
  let jinxToken: Address | undefined;
  if (cfg.jinxEscrow) {
    // v2 is a superset of v1's functions, so one ABI serves both deployments.
    jinxChain = new Chain(cfg.rpcUrl, cfg.jinxEscrow, relayer, jinxEscrowV2Abi);
    await jinxChain.init();
    jinxToken = await jinxChain.token();
    jinxSnapshots = new Snapshots(jinxChain, jinxToken);
  }

  /** Stake limits, rake tiers and the referee's collateral, when the JINX escrow is v2 (a v1 escrow has none). */
  let limitsCache: { at: number; data: unknown } | undefined;
  async function jinxLimits() {
    if (!jinxChain) return undefined;
    if (limitsCache && Date.now() - limitsCache.at < 30_000) return limitsCache.data;
    const jc = jinxChain;
    const rd = (functionName: string, args: unknown[] = []) => jc.pub.readContract({ address: jc.escrow, abi: jinxEscrowV2Abi, functionName, args } as never) as Promise<never>;
    let data: unknown;
    try {
      const [minStake, maxStake, tiers, bond, floor] = (await Promise.all([rd("minStake"), rd("maxStake"), rd("rakeTiers"), rd("refereeBond", [referee.address]), rd("refereeBondFloor")])) as [bigint, bigint, [bigint[], number[]], bigint, bigint];
      data = {
        minStake: String(minStake),
        maxStake: String(maxStake),
        tiers: tiers[0].map((f, i) => ({ floor: String(f), bps: Number(tiers[1][i]) })),
        refereeBond: String(bond),
        refereeBondFloor: String(floor),
      };
    } catch {
      data = undefined;
    }
    limitsCache = { at: Date.now(), data };
    return data;
  }
  void jinxLimits().then((l) => {
    const lim = l as { refereeBond: string; refereeBondFloor: string } | undefined;
    if (lim && BigInt(lim.refereeBond) < BigInt(lim.refereeBondFloor)) {
      console.warn(`WARNING: the referee ${referee.address} has posted ${lim.refereeBond} collateral, below the ${lim.refereeBondFloor} floor. No JINX match can start until it calls depositRefereeBond.`);
    }
  });

  /** A wallet is protected once it has a second owner. Read from the wallet itself, and remembered for a few seconds. */
  const protectedCache = new Map<string, { at: number; ok: boolean }>();
  async function walletHasRecovery(wallet: Address): Promise<boolean> {
    const hit = protectedCache.get(wallet.toLowerCase());
    if (hit && Date.now() - hit.at < 5_000) return hit.ok;
    let ok = false;
    try {
      const n = (await chain.pub.readContract({ address: wallet, abi: [{ type: "function", name: "ownerCount", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }], functionName: "ownerCount" } as never)) as bigint;
      ok = n >= 2n;
    } catch {
      ok = false; // not deployed yet, or not a wallet
    }
    protectedCache.set(wallet.toLowerCase(), { at: Date.now(), ok });
    if (protectedCache.size > 20_000) protectedCache.clear();
    return ok;
  }

  // Passkey wallets: relay to the bundler and gas sponsor, and keep the public key directory.
  const aa = createAa({
    bundlerUrl: cfg.bundlerUrl,
    paymasterUrl: cfg.paymasterUrl,
    paymasterContext: cfg.paymasterContext,
    allowedTargets: [cfg.escrow, tokenAddr, ...(jinxChain ? [jinxChain.escrow, jinxToken!] : [])],
    stakeTargets: [cfg.escrow, ...(jinxChain ? [jinxChain.escrow] : [])],
    walletProtected: cfg.requireRecovery === false ? undefined : (cfg.walletProtected ?? walletHasRecovery),
  });
  const passkeys = new PasskeyRegistry(cfg.dataDir);
  const registrations = new Map<string, number>();
  const mailer = cfg.mailer ?? (cfg.brevoApiKey && cfg.emailFrom ? brevoMailer({ apiKey: cfg.brevoApiKey, fromEmail: cfg.emailFrom, fromName: cfg.emailFromName }) : undefined);
  const email = mailer ? new EmailAuth({ dataDir: cfg.dataDir, mailer }) : undefined;
  const bearer = (req: IncomingMessage) => /^Bearer ([0-9a-f]{64})$/.exec(String(req.headers.authorization ?? ""))?.[1];
  const clientIp = (req: IncomingMessage) => String(req.headers["cf-connecting-ip"] ?? String(req.headers["x-forwarded-for"] ?? "").split(",")[0] ?? "").trim() || (req.socket.remoteAddress ?? "?");

  const rooms = new Map<string, Room>();
  const subs = new Map<string, Set<WebSocket>>();
  const timers = new Map<string, NodeJS.Timeout>();
  const logPath = (id: string) => join(cfg.dataDir, `${chain.chainId}-${cfg.escrow.toLowerCase()}-${id}.json`);
  const persist = (room: Room) => writeFileSync(logPath(room.info.matchId.toString()), JSON.stringify(room.log, null, 2));
  const send = (ws: WebSocket, m: ServerMsg) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(m));
  const broadcast = (id: string, m: ServerMsg) => subs.get(id)?.forEach((ws) => send(ws, m));
  const jinxHost = jinxChain
    ? new JinxHost({
        chain: jinxChain,
        referee,
        domain: jinxDomain(chain.chainId, jinxChain.escrow),
        dataDir: cfg.dataDir,
        resultWaitMs: cfg.resultWaitMs,
        clock,
        room: cfg.jinxRoom,
        send: (ws, m) => send(ws, m),
      })
    : undefined;
  const statusOf = (r: Room) => (r.settled ? "settled" : r.ended ? "ended" : "active") as "active" | "ended" | "settled";

  const loadingRooms = new Map<string, Promise<Room>>();
  /** One room per match, even when both players join at the same moment. */
  function getRoom(id: string): Promise<Room> {
    const existing = rooms.get(id);
    if (existing) return Promise.resolve(existing);
    let pending = loadingRooms.get(id);
    if (!pending) {
      pending = loadRoom(id).then(
        (room) => {
          rooms.set(id, room);
          loadingRooms.delete(id);
          return room;
        },
        (err) => {
          loadingRooms.delete(id);
          throw err;
        },
      );
      loadingRooms.set(id, pending);
    }
    return pending;
  }

  async function loadRoom(id: string): Promise<Room> {
    const matchId = BigInt(id);
    const m = await chain.getMatch(matchId);
    if (m.status === 0) throw new Error("unknown match");
    if (m.referee.toLowerCase() !== referee.address.toLowerCase()) throw new Error("this server is not the referee for that match");
    const info = { matchId, chainId: chain.chainId, escrow: cfg.escrow, key1: m.key1, key2: m.key2, referee: m.referee };
    const path = logPath(id);
    const saved = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as MatchLog) : undefined;
    const room = new Room(info, referee, domain, saved);
    if (m.status >= 2) room.settled = true;
    return room;
  }

  async function settleRoom(room: Room) {
    const id = room.info.matchId.toString();
    if (room.settled) return;
    room.settled = true;
    clearTimeout(timers.get(id));
    const mode = room.bothPlayersSigned ? "instant" : "window";
    try {
      const { result, finalHash, refSig } = await room.signFinal();
      const tx = await chain.settle(room.info.matchId, result, finalHash, room.log.sig1, room.log.sig2, refSig);
      room.settleTx = tx;
      room.settleMode = mode;
      persist(room);
      broadcast(id, { type: "settled", matchId: id, tx, mode });
    } catch (e) {
      room.settled = false;
      broadcast(id, { type: "error", message: `settlement failed: ${(e as Error).message}` });
    }
  }

  async function onMessage(ws: WebSocket, msg: ClientMsg) {
    const room = await getRoom(msg.matchId);
    const id = msg.matchId;
    if (msg.type === "join") {
      if (!subs.has(id)) subs.set(id, new Set());
      subs.get(id)!.add(ws);
      send(ws, { type: "state", log: room.log, status: statusOf(room), settleTx: room.settleTx, settleMode: room.settleMode });
      return;
    }
    if (msg.type === "move") {
      const move = await room.acceptMove(msg.index, msg.cell, msg.sig, Date.now());
      persist(room);
      broadcast(id, { type: "event", matchId: id, move });
      if (room.ended) {
        const { result, finalHash, refSig } = await room.signFinal();
        persist(room);
        broadcast(id, { type: "end", matchId: id, result, finalHash, refSig });
        timers.set(id, setTimeout(() => void settleRoom(room), cfg.resultWaitMs));
      }
      return;
    }
    if (msg.type === "result-sig") {
      await room.acceptResultSig(msg.side, msg.result, msg.sig);
      persist(room);
      if (room.bothPlayersSigned) await settleRoom(room);
    }
  }

  const cors = (res: ServerResponse) => {
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-headers", "*");
  };
  const MIME: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript",
    ".css": "text/css",
    ".svg": "image/svg+xml",
    ".json": "application/json",
    ".png": "image/png",
    ".ico": "image/x-icon",
  };
  const serveStatic = (pathname: string, res: ServerResponse): boolean => {
    if (!cfg.webDir) return false;
    const root = resolve(cfg.webDir);
    let file: string;
    try {
      file = normalize(join(root, decodeURIComponent(pathname)));
    } catch {
      return false;
    }
    if (file !== root && !file.startsWith(root + sep)) return false;
    if (!existsSync(file) || !statSync(file).isFile()) file = join(root, "index.html");
    if (!existsSync(file)) return false;
    const ext = file.slice(file.lastIndexOf("."));
    res.writeHead(200, { "content-type": MIME[ext] ?? "application/octet-stream" });
    res.end(readFileSync(file));
    return true;
  };

  // Browsers on a local chain talk to it through this proxy. Wallet-style methods that act as the node's
  // unlocked accounts are blocked, and funding may not touch the referee/relayer account.
  const RPC_BLOCKED = new Set(["eth_sendTransaction", "eth_accounts", "eth_coinbase", "eth_sign", "eth_signTransaction"]);
  const protectedAddrs = new Set([referee.address.toLowerCase(), relayer.address.toLowerCase()]);
  const rpcAllowed = (c: { method?: unknown; params?: unknown[] }): boolean => {
    const m = typeof c?.method === "string" ? c.method : "";
    if (m === "anvil_setBalance") {
      const [target, value] = (c.params ?? []) as [string, string];
      return (
        typeof target === "string" &&
        !protectedAddrs.has(target.toLowerCase()) &&
        typeof value === "string" &&
        BigInt(value) <= 100n * 10n ** 18n
      );
    }
    return (m.startsWith("eth_") && !RPC_BLOCKED.has(m) && !m.startsWith("eth_signTypedData")) || m === "net_version" || m === "web3_clientVersion";
  };
  const readBody = (req: IncomingMessage): Promise<string> =>
    new Promise((ok, fail) => {
      let size = 0;
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => {
        size += c.length;
        if (size > 256_000) {
          fail(new Error("body too large"));
          req.destroy();
        } else chunks.push(c);
      });
      req.on("end", () => ok(Buffer.concat(chunks).toString()));
      req.on("error", fail);
    });

  const http = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    cors(res);
    if (req.method === "OPTIONS") return void res.writeHead(204).end();
    const url = new URL(req.url ?? "/", "http://x");
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    try {
      if (url.pathname === "/config") {
        const proto = String(req.headers["x-forwarded-proto"] ?? "http").split(",")[0];
        const rpcUrl = cfg.proxyRpc ? `${proto}://${req.headers.host}/rpc` : (cfg.publicRpcUrl ?? cfg.rpcUrl);
        return json(200, {
          chainId: chain.chainId,
          escrow: cfg.escrow,
          token: tokenAddr,
          referee: referee.address,
          rpcUrl,
          jinx: jinxChain ? { escrow: jinxChain.escrow, token: jinxToken, limits: await jinxLimits() } : undefined,
          aa: { enabled: aa.enabled, sponsored: aa.sponsored },
          email: { enabled: !!email },
        });
      }
      if (url.pathname.startsWith("/email/") || url.pathname === "/vault") {
        if (!email) return json(404, { error: "email sign-in is not switched on" });
        if (url.pathname === "/email/start" && req.method === "POST") {
          const body = JSON.parse(await readBody(req)) as { email?: unknown };
          const r = await email.start(body.email, clientIp(req));
          if (r === "sent") return json(200, { ok: true });
          if (r === "invalid") return json(400, { error: "that does not look like an email address" });
          if (r === "limited") return json(429, { error: "too many codes requested, try again in a little while" });
          return json(502, { error: "the code could not be sent, try again" });
        }
        if (url.pathname === "/email/verify" && req.method === "POST") {
          const body = JSON.parse(await readBody(req)) as { email?: unknown; code?: unknown };
          const r = email.verify(body.email, body.code);
          if (r.ok) return json(200, { token: r.token, hasVault: r.hasVault });
          return json(r.reason === "locked" ? 429 : 401, { error: r.reason === "locked" ? "too many wrong codes, ask for a new one" : "that code is wrong or has expired" });
        }
        if (url.pathname === "/vault" && req.method === "GET") {
          const v = email.vaultFor(bearer(req));
          if (v === "unauthorized") return json(401, { error: "sign in again with a new code" });
          return v ? json(200, v) : json(404, { error: "no wallet for this email yet" });
        }
        if (url.pathname === "/vault" && req.method === "PUT") {
          const body = JSON.parse(await readBody(req)) as { blob?: unknown };
          const r = email.putVault(bearer(req), body.blob);
          if (r === "ok") return json(200, { ok: true });
          return json(r === "unauthorized" ? 401 : r === "full" ? 409 : 400, { error: r === "unauthorized" ? "sign in again with a new code" : r === "full" ? "too many saved versions" : "bad wallet data" });
        }
      }
      if ((url.pathname === "/bundler" || url.pathname === "/paymaster") && req.method === "POST") {
        const out = await (url.pathname === "/bundler" ? aa.bundler : aa.paymaster)(await readBody(req), clientIp(req));
        res.writeHead(out.status, { "content-type": "application/json" });
        return void res.end(out.body);
      }
      if (url.pathname === "/passkey" && req.method === "POST") {
        const ip = clientIp(req);
        const n = (registrations.get(ip) ?? 0) + 1;
        registrations.set(ip, n);
        if (registrations.size > 20_000) registrations.clear();
        if (n > 60) return json(429, { error: "too many registrations from this address" });
        const body = JSON.parse(await readBody(req)) as { id?: unknown; publicKey?: unknown; wallet?: unknown };
        const result = passkeys.register(body.id, body.publicKey, body.wallet);
        if (result === "invalid") return json(400, { error: "bad passkey" });
        if (result === "conflict") return json(409, { error: "that passkey id is already registered with a different key" });
        if (result === "full") return json(507, { error: "directory full" });
        return json(200, { ok: true, existed: result === "same" });
      }
      if (url.pathname.startsWith("/passkey/") && req.method === "GET") {
        const found = passkeys.get(decodeURIComponent(url.pathname.slice("/passkey/".length)));
        return found ? json(200, found) : json(404, { error: "unknown passkey" });
      }
      if (url.pathname === "/rpc" && cfg.proxyRpc && req.method === "POST") {
        const body = JSON.parse(await readBody(req));
        const calls = Array.isArray(body) ? body : [body];
        if (!calls.every(rpcAllowed)) return json(403, { error: "rpc method not allowed" });
        const upstream = await fetch(cfg.rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        res.writeHead(upstream.status, { "content-type": "application/json" });
        return void res.end(await upstream.text());
      }
      if (url.pathname === "/state") {
        const addr = url.searchParams.get("addr");
        const matchId = url.searchParams.get("match");
        const snap = url.searchParams.get("game") === "jinx" ? jinxSnapshots : snapshots;
        if (!snap) return json(404, { error: "game not enabled" });
        // Clients ask for balances only when something changed (acct=0 skips them); fresh=1 skips the short cache.
        const wantAccount = url.searchParams.get("acct") !== "0";
        const fresh = url.searchParams.get("fresh") === "1";
        const [shared, account, view] = await Promise.all([
          snap.getShared(fresh),
          wantAccount && addr && isAddress(addr) ? snap.getAccount(addr, fresh) : undefined,
          matchId && /^\d+$/.test(matchId) ? snap.getMatch(BigInt(matchId), fresh) : undefined,
        ]);
        res.writeHead(200, { "content-type": "application/json" });
        return void res.end(JSON.stringify({ ...shared, account, view }, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
      }
      const jl = url.pathname.match(/^\/jinx-log\/(\d+)$/);
      if (jl && jinxHost) {
        const log = jinxHost.logFor(jl[1]);
        return log ? json(200, log) : json(404, { error: "no log for that match" });
      }
      const m = url.pathname.match(/^\/log\/(\d+)$/);
      if (m) return json(200, (await getRoom(m[1])).log);
      if (req.method === "GET" && serveStatic(url.pathname, res)) return;
      json(404, { error: "not found" });
    } catch (e) {
      json(404, { error: (e as Error).message });
    }
  });

  const wss = new WebSocketServer({ server: http });
  wss.on("connection", (ws) => {
    ws.on("message", (raw) => {
      let msg: ClientMsg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return send(ws, { type: "error", message: "bad json" });
      }
      if (msg.type.startsWith("jinx-")) {
        if (!jinxHost) return send(ws, { type: "error", message: "JINX is not enabled on this server" });
        jinxHost.handle(ws, msg as Extract<ClientMsg, { type: `jinx-${string}` }>).catch((e: Error) => send(ws, { type: "error", message: e.message }));
        return;
      }
      onMessage(ws, msg).catch((e: Error) => send(ws, { type: "error", message: e.message }));
    });
    ws.on("close", () => {
      subs.forEach((s) => s.delete(ws));
      jinxHost?.drop(ws);
    });
  });
  const jinxTimer = jinxHost ? setInterval(() => void jinxHost.tick(), 100) : undefined;

  await new Promise<void>((r) => http.listen(cfg.port, r));
  const port = (http.address() as { port: number }).port;
  return {
    port,
    referee: referee.address,
    close: async () => {
      timers.forEach(clearTimeout);
      clearInterval(jinxTimer);
      jinxHost?.close();
      wss.clients.forEach((c) => c.terminate());
      await new Promise<void>((r) => http.close(() => r()));
    },
  };
}

// CLI entry: node packages/server/src/main.ts
if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  const need = (k: string) => {
    const v = process.env[k];
    if (!v) throw new Error(`missing env ${k}`);
    return v;
  };
  const s = await startServer({
    rpcUrl: process.env.RPC_URL ?? "http://127.0.0.1:8545",
    publicRpcUrl: process.env.PUBLIC_RPC_URL,
    escrow: need("ESCROW") as Address,
    jinxEscrow: process.env.JINX_ESCROW as Address | undefined,
    refereePk: need("REFEREE_PK") as Hex,
    relayerPk: process.env.RELAYER_PK as Hex | undefined,
    port: Number(process.env.PORT ?? 8787),
    dataDir: process.env.DATA_DIR ?? "data",
    resultWaitMs: Number(process.env.RESULT_WAIT_MS ?? 15000),
    webDir: process.env.WEB_DIR,
    proxyRpc: process.env.PROXY_RPC === "1",
  });
  console.log(`referee ${s.referee} listening on :${s.port}`);
}
