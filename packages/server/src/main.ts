import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, normalize, resolve, sep } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { privateKeyToAccount } from "viem/accounts";
import { eip712Domain, type ClientMsg, type MatchLog, type ServerMsg } from "@playpot/game";
import type { Address, Hex } from "viem";
import { Chain } from "./chain.ts";
import { Room } from "./room.ts";

export interface ServerConfig {
  rpcUrl: string;
  publicRpcUrl?: string;
  escrow: Address;
  refereePk: Hex;
  relayerPk?: Hex;
  port: number;
  dataDir: string;
  resultWaitMs: number;
  webDir?: string; // serve the built web client from this folder
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

  const rooms = new Map<string, Room>();
  const subs = new Map<string, Set<WebSocket>>();
  const timers = new Map<string, NodeJS.Timeout>();
  const logPath = (id: string) => join(cfg.dataDir, `${chain.chainId}-${cfg.escrow.toLowerCase()}-${id}.json`);
  const persist = (room: Room) => writeFileSync(logPath(room.info.matchId.toString()), JSON.stringify(room.log, null, 2));
  const send = (ws: WebSocket, m: ServerMsg) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(m));
  const broadcast = (id: string, m: ServerMsg) => subs.get(id)?.forEach((ws) => send(ws, m));
  const statusOf = (r: Room) => (r.settled ? "settled" : r.ended ? "ended" : "active") as "active" | "ended" | "settled";

  async function getRoom(id: string): Promise<Room> {
    const existing = rooms.get(id);
    if (existing) return existing;
    const matchId = BigInt(id);
    const m = await chain.getMatch(matchId);
    if (m.status === 0) throw new Error("unknown match");
    if (m.referee.toLowerCase() !== referee.address.toLowerCase()) throw new Error("this server is not the referee for that match");
    const info = { matchId, chainId: chain.chainId, escrow: cfg.escrow, key1: m.key1, key2: m.key2, referee: m.referee };
    const path = logPath(id);
    const saved = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as MatchLog) : undefined;
    const room = new Room(info, referee, domain, saved);
    if (m.status >= 2) room.settled = true;
    rooms.set(id, room);
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
        return json(200, { chainId: chain.chainId, escrow: cfg.escrow, token: tokenAddr, referee: referee.address, rpcUrl });
      }
      if (url.pathname === "/rpc" && cfg.proxyRpc && req.method === "POST") {
        const body = JSON.parse(await readBody(req));
        const calls = Array.isArray(body) ? body : [body];
        if (!calls.every(rpcAllowed)) return json(403, { error: "rpc method not allowed" });
        const upstream = await fetch(cfg.rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        res.writeHead(upstream.status, { "content-type": "application/json" });
        return void res.end(await upstream.text());
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
      onMessage(ws, msg).catch((e: Error) => send(ws, { type: "error", message: e.message }));
    });
    ws.on("close", () => subs.forEach((s) => s.delete(ws)));
  });

  await new Promise<void>((r) => http.listen(cfg.port, r));
  const port = (http.address() as { port: number }).port;
  return {
    port,
    referee: referee.address,
    close: async () => {
      timers.forEach(clearTimeout);
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
