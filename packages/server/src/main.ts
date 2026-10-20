import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { privateKeyToAccount } from "viem/accounts";
import { eip712Domain, type ClientMsg, type MatchLog, type ServerMsg } from "@playpot/game";
import type { Address, Hex } from "viem";
import { Chain } from "./chain.ts";
import { Room } from "./room.ts";

export interface ServerConfig {
  rpcUrl: string;
  escrow: Address;
  refereePk: Hex;
  relayerPk?: Hex;
  port: number;
  dataDir: string;
  resultWaitMs: number;
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
        return json(200, { chainId: chain.chainId, escrow: cfg.escrow, token: tokenAddr, referee: referee.address, rpcUrl: cfg.rpcUrl });
      }
      const m = url.pathname.match(/^\/log\/(\d+)$/);
      if (m) return json(200, (await getRoom(m[1])).log);
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
    escrow: need("ESCROW") as Address,
    refereePk: need("REFEREE_PK") as Hex,
    relayerPk: process.env.RELAYER_PK as Hex | undefined,
    port: Number(process.env.PORT ?? 8787),
    dataDir: process.env.DATA_DIR ?? "data",
    resultWaitMs: Number(process.env.RESULT_WAIT_MS ?? 15000),
  });
  console.log(`referee ${s.referee} listening on :${s.port}`);
}
