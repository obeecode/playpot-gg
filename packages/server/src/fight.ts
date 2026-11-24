// "Fight" test game: serves the fork-core client from folders on the host machine and relays its rollback netcode between
// two players. The game's files are never part of this repository: FIGHT_DIR points at a gameplay-core checkout and FIGHT_REF at
// the folder holding TEMP_REF__site and TEMP_REF__assets. The relay is blind: it forwards text frames between the two players of
// a room and keeps nothing after the room closes.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, extname, join, resolve, sep } from "node:path";
import type { Duplex } from "node:stream";
import type { Address, LocalAccount } from "viem";
import { WebSocketServer, type WebSocket } from "ws";
import { FightLog, GUEST, HOST, recoverJoin, signVerdict, type FightLogFile, type FightReplay, type FightVerdict } from "./fightLog.ts";

export const FIGHT_PREFIX = "/g/fight";
export const FIGHT_WS_PATH = `${FIGHT_PREFIX}/ws`;

export interface FightOptions {
  gameDir: string; // a gameplay-core checkout (the folder that holds fork-core/)
  refDir: string; // holds TEMP_REF__site and TEMP_REF__assets
  mainFile?: string; // the build to serve, relative to fork-core/src; default main.ws1.js (the build with online play)
  maxMessageBytes?: number;
  keepAliveMs?: number;
  statsMs?: number; // how often a room's timing summary is logged (default 5000)
  log?: (line: string) => void;
  referee?: LocalAccount; // with this, every room is recorded in a hash chain that the referee signs when the match ends
  logDir?: string; // where finished records are written (the record is also served at /g/fight/log/<id>)
  requireAuth?: boolean; // players must join with a wallet signature (see joinMessage in fightLog.ts); otherwise it is optional
  now?: () => number;
  verify?: boolean; // replay each finished record headless and sign a verdict (default: on when a referee is set and the referee script exists)
  replay?: (file: FightLogFile) => Promise<FightReplay>; // tests inject one
  replayTimeoutMs?: number;
}

const REFEREE_SCRIPT = fileURLToPath(new URL("../../../scripts/fight-referee.cjs", import.meta.url));

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".ogg": "audio/ogg",
  ".atlas": "text/plain; charset=utf-8",
  ".skel": "application/octet-stream",
};

/** Each original chunk script redirects to the official site when the page is not served from it. Removed in the served copy only. */
const GUARD = /(if\(!\('~'>[\s\S]{0,2500}?\}\}\);)\w+\(\);/;

const API_STUBS: Record<string, string> = { "/api/misc/vs": '{"s":[]}', "/api/account/login_auto": '{"status":"UK"}', "/api/auth/refresh": "{}" };

/** Where the game's files are, or why it cannot be served. */
export function checkFightFiles(o: FightOptions): string | undefined {
  const main = join(o.gameDir, "fork-core", "src", o.mainFile ?? "main.ws1.js");
  if (!existsSync(main)) return `game build not found: ${main}`;
  if (!existsSync(join(o.refDir, "TEMP_REF__site"))) return `TEMP_REF__site not found in ${o.refDir}`;
  if (!existsSync(join(o.refDir, "TEMP_REF__assets"))) return `TEMP_REF__assets not found in ${o.refDir}`;
  return undefined;
}

export function createFight(o: FightOptions) {
  const mainPath = join(o.gameDir, "fork-core", "src", o.mainFile ?? "main.ws1.js");
  const roots = [join(o.refDir, "TEMP_REF__site"), join(o.refDir, "TEMP_REF__assets")];
  const maxPayload = o.maxMessageBytes ?? 1024 * 1024;
  const now = o.now ?? Date.now;
  /** Finished match records, newest last, by id. */
  const finished = new Map<string, FightLogFile>();
  const verdicts = new Map<string, FightVerdict>();
  const FINISHED_KEPT = 200;

  /** A request path (after the prefix) to a file in the reference folders, which carry a TEMP_REF__ label on every file name. */
  function findFile(rel: string): string | null {
    const parts = rel.split("/").filter((p) => p !== "");
    if (parts.some((p) => p === ".." || p.includes("\\") || p.includes("\0"))) return null;
    const dir = parts.slice(0, -1);
    let leaf = parts[parts.length - 1] ?? "";
    if (leaf.startsWith("TEMP_REF__")) leaf = leaf.slice(10);
    for (const root of roots) {
      for (const name of ["TEMP_REF__" + leaf, "TEMP_REF__" + leaf.replace(/^\.+/, "")]) {
        const p = join(root, ...dir, name);
        if (!(p === root || p.startsWith(root + sep))) continue;
        if (existsSync(p) && statSync(p).isFile()) return p;
      }
    }
    return null;
  }

  function send(res: ServerResponse, status: number, body: string | Buffer, type: string, cache = false) {
    const b = Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8");
    res.writeHead(status, { "content-type": type, "content-length": b.length, "cache-control": cache ? "public, max-age=3600" : "no-store" });
    res.end(b);
  }

  /** The fork's main script, pointed at this server and this path instead of the original backend. */
  function forkMain(origin: string, wsOrigin: string): string {
    return readFileSync(mainPath, "utf8")
      .split("https://be.counterpicklabs.com").join(origin + FIGHT_PREFIX)
      .split("wss://be.counterpicklabs.com").join(wsOrigin + FIGHT_PREFIX)
      .split('location.host + "/ws?room="').join(`location.host + "${FIGHT_WS_PATH}?room="`)
      .split('(base || location.origin) + "/?room="').join(`(base || location.origin) + "${FIGHT_PREFIX}/?room="`);
  }

  /** Handles GET requests under /g/fight. Returns false when the path is not ours. */
  function http(req: IncomingMessage, res: ServerResponse, pathname: string, search = ""): boolean {
    if (pathname === FIGHT_PREFIX) {
      res.writeHead(302, { location: FIGHT_PREFIX + "/" + search });
      res.end();
      return true;
    }
    if (!pathname.startsWith(FIGHT_PREFIX + "/")) return false;
    let rel: string;
    try {
      rel = decodeURIComponent(pathname.slice(FIGHT_PREFIX.length));
    } catch {
      send(res, 400, "{}", MIME[".json"]);
      return true;
    }
    if (rel.startsWith("/api/")) {
      const body = API_STUBS[rel];
      send(res, body !== undefined ? 200 : 404, body ?? "{}", MIME[".json"]);
      return true;
    }
    if (rel.startsWith("/log/")) {
      const f = finished.get(rel.slice("/log/".length));
      send(res, f ? 200 : 404, f ? JSON.stringify(f) : '{"error":"no such record"}', MIME[".json"]);
      return true;
    }
    if (rel.startsWith("/result/")) {
      const v = verdicts.get(rel.slice("/result/".length));
      send(res, v ? 200 : 404, v ? JSON.stringify(v) : '{"error":"no verdict yet"}', MIME[".json"]);
      return true;
    }
    if (rel.startsWith("/wds/")) {
      send(res, 404, "{}", MIME[".json"]);
      return true;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      send(res, 405, "{}", MIME[".json"]);
      return true;
    }
    if (rel === "/") rel = "/index.html";
    const file = findFile(rel);
    if (!file) {
      send(res, 404, '{"error":"not found"}', MIME[".json"]);
      return true;
    }
    const type = MIME[extname(file).toLowerCase()] ?? "application/octet-stream";
    const proto = String(req.headers["x-forwarded-proto"] ?? "http").split(",")[0].trim();
    const host = req.headers.host ?? "localhost";
    if (/^\/main\.[0-9a-f]+\.js$/.test(rel)) {
      send(res, 200, forkMain(`${proto}://${host}`, `${proto === "https" ? "wss" : "ws"}://${host}`), type);
    } else if (/^\/\d+\.[0-9a-f]+\.js$/.test(rel)) {
      let t = readFileSync(file, "utf8");
      if (GUARD.test(t)) t = t.replace(GUARD, "$1");
      else if (rel.startsWith("/455.") && t.includes("a10r();")) t = t.replace("a10r();", "");
      send(res, 200, t, type);
    } else if (rel === "/index.html") {
      let t = readFileSync(file, "utf8");
      t = t.replace(/<script[^>]*src="https:\/\/[^"]*"[^>]*>\s*<\/script>/g, "");
      t = t.replace(/<script[^>]*>[^<]*cloudflareinsights[^<]*<\/script>/g, "");
      // the cleaned build reads its backend address from the page; older builds are rewritten in forkMain instead
      const base = `${proto}://${host}${FIGHT_PREFIX}`;
      const wsBase = `${proto === "https" ? "wss" : "ws"}://${host}${FIGHT_PREFIX}`;
      t = t.replace("<head>", `<head><script>window.GAME_API_BASE=${JSON.stringify(base)};window.GAME_WS_BASE=${JSON.stringify(wsBase)};</script>`);
      send(res, 200, t, type);
    } else {
      send(res, 200, readFileSync(file), type, true);
    }
    return true;
  }

  // ---- relay ----
  const wss = new WebSocketServer({ noServer: true, maxPayload });
  interface Room {
    host?: WebSocket;
    guest?: WebSocket;
    addr: { host?: Address; guest?: Address };
    log?: FightLog;
    stats?: ReturnType<typeof setInterval>;
  }
  const rooms = new Map<string, Room>();
  const log = o.log ?? ((l: string) => console.log(l));
  /** Timing per player: how many messages arrived, the longest silence between two of them, and the last ping round trip. */
  const timing = new WeakMap<WebSocket, { n: number; last: number; maxGap: number; rtt: number; pingAt: number }>();
  const alive = new WeakMap<WebSocket, boolean>();
  const timer = setInterval(() => {
    for (const ws of wss.clients) {
      if (alive.get(ws) === false) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      try {
        ws.ping();
      } catch {
        /* closing */
      }
    }
  }, o.keepAliveMs ?? 20_000);
  timer.unref();

  /** Runs the headless referee over a record in a separate process and returns what it found. */
  function runReplay(file: FightLogFile): Promise<FightReplay> {
    const dir = mkdtempSync(join(tmpdir(), "fight-replay-"));
    const rec = join(dir, "record.json");
    const out = join(dir, "result.json");
    writeFileSync(rec, JSON.stringify(file));
    return new Promise((resolve, reject) => {
      execFile(process.execPath, [REFEREE_SCRIPT, rec, "--out", out], { env: { ...process.env, FIGHT_DIR: o.gameDir, FIGHT_REF: o.refDir, FIGHT_QUIET: "1" }, timeout: o.replayTimeoutMs ?? 600_000, maxBuffer: 1 << 24 }, (err) => {
        try {
          if (!existsSync(out)) throw err ?? new Error("the referee wrote no result");
          resolve(JSON.parse(readFileSync(out, "utf8")) as FightReplay); // exit code 1 just means "not clean": the result file says why
        } catch (e) {
          reject(e);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      });
    });
  }

  /** Replays a finished record and signs the verdict. */
  async function judge(file: FightLogFile) {
    const referee = o.referee;
    if (!referee) return;
    try {
      const replay = await (o.replay ?? runReplay)(file);
      const verdict = await signVerdict(referee, file.head.room, file.head.head, replay);
      verdicts.set(file.head.room, verdict);
      while (verdicts.size > FINISHED_KEPT) verdicts.delete(verdicts.keys().next().value as string);
      if (o.logDir) writeFileSync(join(o.logDir, `${file.head.room}.verdict.json`), JSON.stringify(verdict));
      log(`[fight] verdict ${file.head.room}: ${verdict.clean ? `clean, ${["no winner", "host", "guest"][verdict.winner]} wins ${verdict.hostScore}-${verdict.guestScore}` : "NOT clean, no winner named"} (${replay.stampsChecked} state hashes checked, ${replay.stampMismatches} mismatches)`);
    } catch (e) {
      log(`[fight] could not replay ${file.head.room}: ${(e as Error).message.slice(0, 160)}`);
    }
  }

  /** Signs and stores the match record, if there is one. */
  function closeRecord(r: Room, reason: string) {
    const record = r.log;
    r.log = undefined;
    if (!record || !o.referee || record.entries.length === 0) return;
    const referee = o.referee;
    void record.finalize(referee, reason, now()).then((file) => {
      finished.set(record.room, file);
      while (finished.size > FINISHED_KEPT) finished.delete(finished.keys().next().value as string);
      if (o.logDir) {
        try {
          mkdirSync(o.logDir, { recursive: true });
          writeFileSync(join(o.logDir, `${record.room}.json`), JSON.stringify(file));
        } catch (e) {
          log(`[fight] could not write the record for ${record.room}: ${(e as Error).message}`);
        }
      }
      log(`[fight] record ${record.room}: ${file.head.count} messages over ${Math.round(file.head.durationMs / 1000)} s, ${reason}`);
      if (o.verify ?? (existsSync(REFEREE_SCRIPT) && existsSync(mainPath))) void judge(file);
    });
  }

  function admit(ws: WebSocket, code: string, role: "host" | "guest", addr?: Address) {
    alive.set(ws, true);
    const t = { n: 0, last: 0, maxGap: 0, rtt: -1, pingAt: 0 };
    timing.set(ws, t);
    ws.on("pong", () => {
      alive.set(ws, true);
      if (t.pingAt) t.rtt = Date.now() - t.pingAt;
    });
    const peer = () => {
      const r = rooms.get(code);
      return r ? (role === "host" ? r.guest : r.host) : undefined;
    };
    let room = rooms.get(code);
    if (role === "guest" && !room?.host) {
      ws.send("snohost");
      ws.close(4002);
      return;
    }
    if (!room) {
      room = { addr: {} };
      rooms.set(code, room);
    }
    if (room[role]) {
      ws.send("sfull");
      ws.close(4001);
      return;
    }
    room[role] = ws;
    room.addr[role] = addr;
    const mine = room;
    ws.on("message", (raw, isBinary) => {
      if (isBinary || rooms.get(code) !== mine) return;
      const arrived = Date.now();
      if (t.last) t.maxGap = Math.max(t.maxGap, arrived - t.last);
      t.last = arrived;
      t.n++;
      const text = raw.toString();
      mine.log?.append(role === "host" ? HOST : GUEST, text, now()); // recorded before it is forwarded, on the server's clock
      peer()?.send(text);
    });
    ws.on("close", () => {
      const r = rooms.get(code);
      if (!r || r[role] !== ws) return;
      r[role] = undefined;
      closeRecord(r, `${role} left`);
      const other = role === "host" ? r.guest : r.host;
      if (other && other.readyState === other.OPEN) other.send("sleft");
      if (!r.host && !r.guest) {
        clearInterval(r.stats);
        rooms.delete(code);
      } else if (role === "host") {
        clearInterval(r.stats);
        rooms.delete(code);
        other?.close(1000);
      }
    });
    if (room.host && room.guest) {
      room.host.send("sready");
      room.guest.send("sready");
      const pair = room;
      if (o.referee) pair.log = new FightLog(`${code}-${now()}`, now(), pair.addr.host ?? null, pair.addr.guest ?? null);
      // While two players are in a room, log how the connection behaves every few seconds. A long gap or a slow ping here
      // is what a freeze looks like from the server's side, and it shows whose link it is.
      pair.stats = setInterval(() => {
        const line: string[] = [];
        for (const side of ["host", "guest"] as const) {
          const w = pair[side];
          const x = w && timing.get(w);
          if (!w || !x) continue;
          const secs = (o.statsMs ?? 5000) / 1000;
          line.push(`${side} ${(x.n / secs).toFixed(0)} msg/s, longest silence ${x.maxGap} ms, ping ${x.rtt < 0 ? "?" : x.rtt + " ms"}`);
          x.n = 0;
          x.maxGap = 0;
          x.pingAt = Date.now();
          try {
            w.ping();
          } catch {
            /* closing */
          }
        }
        if (line.length) log(`[fight] room ${code}: ${line.join(" | ")}`);
      }, o.statsMs ?? 5000);
      pair.stats.unref();
    }
  }

  /** Handles a WebSocket upgrade for /g/fight/ws. Returns false when the path is not ours. */
  function upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const u = new URL(req.url ?? "/", "http://x");
    if (u.pathname !== FIGHT_WS_PATH) return false;
    const code = (u.searchParams.get("room") ?? "").toUpperCase();
    const role = u.searchParams.get("role");
    if (!/^[A-Z0-9]{4,12}$/.test(code) || (role !== "host" && role !== "guest")) {
      socket.destroy();
      return true;
    }
    const sig = u.searchParams.get("sig");
    const claimed = u.searchParams.get("addr");
    const refuse = () => {
      socket.write("HTTP/1.1 401 Unauthorized\r\ncontent-length: 0\r\n\r\n");
      socket.destroy();
    };
    void (async () => {
      let who: Address | undefined;
      if (sig && /^0x[0-9a-fA-F]{130}$/.test(sig)) who = await recoverJoin(code, role, sig as `0x${string}`);
      if (who && claimed && who.toLowerCase() !== claimed.toLowerCase()) who = undefined;
      if ((o.requireAuth || sig) && !who) return refuse();
      wss.handleUpgrade(req, socket, head, (ws) => admit(ws, code, role, who));
    })();
    return true;
  }

  return {
    http,
    upgrade,
    rooms: () => rooms.size,
    close() {
      clearInterval(timer);
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      for (const r of rooms.values()) clearInterval(r.stats);
      rooms.clear();
    },
  };
}

export type Fight = ReturnType<typeof createFight>;

/** Reads FIGHT_DIR, FIGHT_REF and FIGHT_MAIN. Returns undefined (with a reason) when the game is not configured. */
export function fightFromEnv(env: Record<string, string | undefined> = process.env): { options?: FightOptions; problem?: string } {
  if (!env.FIGHT_DIR && !env.FIGHT_REF) return {};
  if (!env.FIGHT_DIR || !env.FIGHT_REF) return { problem: "set both FIGHT_DIR (a gameplay-core checkout) and FIGHT_REF (the folder with TEMP_REF__site and TEMP_REF__assets)" };
  const options: FightOptions = { gameDir: resolve(env.FIGHT_DIR), refDir: resolve(env.FIGHT_REF), mainFile: env.FIGHT_MAIN ? basename(env.FIGHT_MAIN) : undefined };
  const problem = checkFightFiles(options);
  return problem ? { problem } : { options };
}

