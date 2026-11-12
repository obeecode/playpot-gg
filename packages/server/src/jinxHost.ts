import { mkdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type WebSocket from "ws";
import type { LocalAccount } from "viem";
import type { ClientMsg, JinxDomain, JinxMatchLog, ServerMsg } from "@playpot/game";
import type { Chain } from "./chain.ts";
import { JinxRoom, type JinxEvent, type JinxRoomOptions } from "./jinxRoom.ts";

type JinxClientMsg = Extract<ClientMsg, { type: `jinx-${string}` }>;

interface Entry {
  room: JinxRoom;
  sockets: Map<WebSocket, 0 | 1 | 2>;
  started: boolean;
  settled: boolean;
  settleTx?: `0x${string}`;
  settleMode?: string;
  timer?: NodeJS.Timeout;
  queue: Promise<unknown>;
}

export interface JinxHostOptions {
  chain: Chain;
  referee: LocalAccount;
  domain: JinxDomain;
  dataDir: string;
  resultWaitMs: number;
  clock: () => number;
  room?: JinxRoomOptions;
  send: (ws: WebSocket, m: ServerMsg) => void;
}

const logFile = (o: JinxHostOptions, id: string) =>
  join(o.dataDir, `jinx-${o.chain.chainId}-${o.chain.escrow.toLowerCase()}-${id}.json`);

/** Runs JINX matches for the WebSocket server: rooms, the clock, persistence and settlement. */
export class JinxHost {
  private rooms = new Map<string, Entry>();
  private o: JinxHostOptions;
  private ticking = false;

  constructor(o: JinxHostOptions) {
    this.o = o;
    mkdirSync(o.dataDir, { recursive: true });
  }

  private locked<T>(e: Entry, fn: () => Promise<T>): Promise<T> {
    const run = e.queue.then(fn, fn);
    e.queue = run.catch(() => undefined);
    return run;
  }

  private loading = new Map<string, Promise<Entry>>();

  /** One room per match, even when both players join at the same moment. */
  private ensure(id: string): Promise<Entry> {
    const existing = this.rooms.get(id);
    if (existing) return Promise.resolve(existing);
    let pending = this.loading.get(id);
    if (!pending) {
      pending = this.load(id).then(
        (e) => {
          this.rooms.set(id, e);
          this.loading.delete(id);
          return e;
        },
        (err) => {
          this.loading.delete(id);
          throw err;
        },
      );
      this.loading.set(id, pending);
    }
    return pending;
  }

  private async load(id: string): Promise<Entry> {
    const matchId = BigInt(id);
    const m = await this.o.chain.getMatch(matchId);
    if (m.status === 0) throw new Error("unknown match");
    if (m.referee.toLowerCase() !== this.o.referee.address.toLowerCase()) throw new Error("this server is not the referee for that match");
    if (m.bestOf !== 3 && m.bestOf !== 5) throw new Error("not a JINX match");
    const room = new JinxRoom(
      { matchId, chainId: this.o.chain.chainId, escrow: this.o.chain.escrow, key1: m.key1, key2: m.key2, referee: m.referee, bestOf: m.bestOf },
      this.o.referee,
      this.o.domain,
      this.o.room,
    );
    // A match that already left the Active state (settled, disputed) takes no more play.
    return { room, sockets: new Map(), started: false, settled: m.status >= 2, queue: Promise.resolve() };
  }

  private persist(e: Entry) {
    writeFileSync(logFile(this.o, e.room.info.matchId.toString()), JSON.stringify(e.room.log, null, 2));
  }

  /** The log of a match: live from memory, or the last saved copy. */
  logFor(id: string): JinxMatchLog | undefined {
    const e = this.rooms.get(id);
    if (e) return e.room.log;
    const path = logFile(this.o, id);
    return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as JinxMatchLog) : undefined;
  }

  private broadcast(e: Entry, events: JinxEvent[]) {
    const id = e.room.info.matchId.toString();
    const nowMs = this.o.clock();
    for (const event of events) {
      for (const [ws, side] of e.sockets) {
        if (event.type === "receipt" && event.private !== side) continue;
        this.o.send(ws, { type: "jinx-event", matchId: id, nowMs, event });
      }
      if (event.type === "end") e.timer = setTimeout(() => void this.settle(e), this.o.resultWaitMs);
    }
    if (events.some((ev) => ev.type === "turn" || ev.type === "end")) this.persist(e);
  }

  async handle(ws: WebSocket, msg: JinxClientMsg): Promise<void> {
    const e = await this.ensure(msg.matchId);
    return this.locked(e, async () => {
      const room = e.room;
      if (msg.type === "jinx-join") {
        const side = msg.side === 1 || msg.side === 2 ? msg.side : 0;
        e.sockets.set(ws, side);
        this.o.send(ws, {
          type: "jinx-state",
          matchId: msg.matchId,
          nowMs: this.o.clock(),
          log: room.log,
          snapshot: side ? room.snapshot(side) : undefined,
          started: e.started,
          settleTx: e.settleTx,
          settleMode: e.settleMode,
        });
        // The clock only starts once both players are in the room.
        const present = new Set(e.sockets.values());
        if (!e.started && !e.settled && present.has(1) && present.has(2)) {
          e.started = true;
          room.start(this.o.clock());
        }
        return;
      }
      const side = e.sockets.get(ws) || 0;
      if (msg.type === "jinx-commit") {
        if (!side) throw new Error("join with your side first");
        this.broadcast(e, await room.commit(side, msg.turn, msg.commitment, msg.sig, this.o.clock()));
      } else if (msg.type === "jinx-reveal") {
        if (!side) throw new Error("join with your side first");
        this.broadcast(e, await room.reveal(side, msg.turn, msg.cell, msg.salt, this.o.clock()));
      } else if (msg.type === "jinx-result-sig") {
        await room.acceptResultSig(msg.side, msg.result, msg.sig);
        this.persist(e);
        if (room.bothPlayersSigned) await this.doSettle(e);
      }
    });
  }

  /** Called often by the server loop. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const e of this.rooms.values()) {
        if (!e.started || e.room.ended || e.settled) continue;
        await this.locked(e, async () => this.broadcast(e, await e.room.tick(this.o.clock())));
      }
    } catch (err) {
      console.error("jinx tick failed:", (err as Error).message);
    } finally {
      this.ticking = false;
    }
  }

  /** Takes the room lock, for callers (the result timer) that are not already inside it. */
  private settle(e: Entry): Promise<void> {
    return this.locked(e, () => this.doSettle(e));
  }

  private async doSettle(e: Entry): Promise<void> {
    const room = e.room;
    if (e.settled || !room.ended) return;
    e.settled = true;
    clearTimeout(e.timer);
    const mode = room.bothPlayersSigned ? "instant" : "window";
    try {
      const tx = await this.o.chain.settle(room.info.matchId, room.result, room.finalHash!, room.sig1, room.sig2, room.refSig!);
      e.settleTx = tx;
      e.settleMode = mode;
      this.persist(e);
      for (const ws of e.sockets.keys()) {
        this.o.send(ws, { type: "jinx-settled", matchId: room.info.matchId.toString(), tx, mode });
      }
    } catch (err) {
      e.settled = false;
      for (const ws of e.sockets.keys()) this.o.send(ws, { type: "error", message: `settlement failed: ${(err as Error).message}` });
    }
  }

  drop(ws: WebSocket) {
    for (const e of this.rooms.values()) e.sockets.delete(ws);
  }

  close() {
    for (const e of this.rooms.values()) clearTimeout(e.timer);
  }
}
