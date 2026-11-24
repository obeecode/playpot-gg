import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { WebSocket } from "ws";
import { createFight, FIGHT_PREFIX, type Fight } from "./fight.ts";
import { joinMessage, type FightReplay } from "./fightLog.ts";
import {
  MIN_PLAYED_FRAMES, OUTCOME_P1, OUTCOME_P2, OUTCOME_VOID, decideOutcome, fightDomain, fightResultDigest, matchOfRoom, roomForMatch,
  type FightStakes, type StakedMatch,
} from "./fightSettle.ts";

const replay = (o: Partial<FightReplay> = {}): FightReplay => ({ finished: true, winner: "guest", score: [1, 2], rounds: 3, stampsChecked: 74, stampMismatches: 0, desync: false, confirmedFrame: 900, ...o });

describe("the interim rules for deciding an outcome", () => {
  it("a finished, clean match goes to whoever won it", () => {
    assert.deepEqual(decideOutcome(replay({ winner: "host", score: [2, 0] }), "guest left"), { outcome: OUTCOME_P1, reason: "completed" });
    assert.deepEqual(decideOutcome(replay(), "host left"), { outcome: OUTCOME_P2, reason: "completed" });
  });
  it("a replay that disagrees with a reported state hash refunds both players", () => {
    for (const bad of [{ stampMismatches: 2 }, { desync: true }, { stampMismatches: 1, finished: false, winner: null }] as Partial<FightReplay>[]) {
      const d = decideOutcome(replay(bad), "guest left");
      assert.equal(d.outcome, OUTCOME_VOID, JSON.stringify(bad));
      assert.match(d.reason, /reported state hash/);
    }
  });
  it("a player who leaves a match that has really started forfeits it", () => {
    const unfinished = { finished: false, winner: null } as Partial<FightReplay>;
    assert.equal(decideOutcome(replay({ ...unfinished, rounds: 2, score: [0, 0], confirmedFrame: 10 }), "guest left").outcome, OUTCOME_P1); // a round was finished
    assert.equal(decideOutcome(replay({ ...unfinished, rounds: 1, score: [1, 0], confirmedFrame: 50 }), "host left").outcome, OUTCOME_P2); // a point was scored
    assert.equal(decideOutcome(replay({ ...unfinished, rounds: 1, score: [0, 0], confirmedFrame: MIN_PLAYED_FRAMES }), "host left").outcome, OUTCOME_P2); // ten seconds of fighting
    assert.match(decideOutcome(replay({ ...unfinished, rounds: 2 }), "guest left").reason, /forfeit/);
  });
  it("a player who leaves before the match got going only voids it", () => {
    const early = replay({ finished: false, winner: null, rounds: 1, score: [0, 0], confirmedFrame: MIN_PLAYED_FRAMES - 1, stampsChecked: 0 });
    assert.equal(decideOutcome(early, "guest left").outcome, OUTCOME_VOID);
    assert.equal(decideOutcome(early, "host left").outcome, OUTCOME_VOID);
  });
  it("an unfinished match that was not left by anyone, or an unknown reason, is refunded", () => {
    assert.equal(decideOutcome(replay({ finished: false, winner: null, rounds: 2 }), "closed").outcome, OUTCOME_VOID);
    assert.equal(decideOutcome(replay({ finished: true, winner: "host", stampsChecked: 0 }), "closed").outcome, OUTCOME_VOID); // nothing was checked
  });
  it("a finished match is judged as completed even if a player left right after", () => {
    assert.equal(decideOutcome(replay({ winner: "host" }), "host left").outcome, OUTCOME_P1);
  });
});

describe("rooms and signatures", () => {
  it("names a staked match's room from its id and reads it back", () => {
    assert.equal(roomForMatch(42n), "M0000042");
    assert.equal(matchOfRoom("M0000042"), 42n);
    assert.equal(matchOfRoom("M42"), undefined);
    assert.equal(matchOfRoom("ABCDEF"), undefined);
    assert.equal(matchOfRoom("M00000420"), undefined);
    assert.ok(/^[A-Z0-9]{4,12}$/.test(roomForMatch(9_999_999n)));
  });
  it("hashes the typed result the way the contract does (domain, field names and order)", () => {
    const domain = fightDomain(84532, "0x0000000000000000000000000000000000000001");
    const a = fightResultDigest(domain, { matchId: 1n, outcome: OUTCOME_P1, record: `0x${"ab".repeat(32)}`, p1Score: 2, p2Score: 1 });
    const b = fightResultDigest(domain, { matchId: 1n, outcome: OUTCOME_P2, record: `0x${"ab".repeat(32)}`, p1Score: 2, p2Score: 1 });
    assert.notEqual(a, b);
    assert.notEqual(a, fightResultDigest(fightDomain(1, "0x0000000000000000000000000000000000000001"), { matchId: 1n, outcome: OUTCOME_P1, record: `0x${"ab".repeat(32)}`, p1Score: 2, p2Score: 1 }));
  });
});

// ---- the relay with a fake chain ----

const referee = privateKeyToAccount(generatePrivateKey());
const k1 = privateKeyToAccount(generatePrivateKey());
const k2 = privateKeyToAccount(generatePrivateKey());
const stranger = privateKeyToAccount(generatePrivateKey());
const matches = new Map<bigint, StakedMatch>();
const settled: Array<{ matchId: bigint; outcome: number; record: string; p1Score: number; p2Score: number }> = [];
let failSettle = false;
const stakes: FightStakes = {
  match: async (id) => matches.get(id),
  settle: async (a) => {
    if (failSettle) throw new Error("the node is down");
    settled.push(a);
    return { tx: `0x${"11".repeat(32)}` };
  },
};
let nextReplay: FightReplay = replay();
let root: string, server: Server, fight: Fight, base: string;
const logged: string[] = [];

before(async () => {
  root = mkdtempSync(join(tmpdir(), "fightstake-"));
  const game = join(root, "game");
  const ref = join(root, "ref");
  mkdirSync(join(game, "fork-core", "src"), { recursive: true });
  mkdirSync(join(ref, "TEMP_REF__site"), { recursive: true });
  mkdirSync(join(ref, "TEMP_REF__assets"), { recursive: true });
  writeFileSync(join(game, "fork-core", "src", "main.ws1.js"), "x");
  fight = createFight({ gameDir: game, refDir: ref, referee, logDir: join(root, "logs"), keepAliveMs: 60_000, statsMs: 60_000, log: (l) => logged.push(l), verify: true, replay: async () => nextReplay, stakes });
  server = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    if (!fight.http(req, res, u.pathname, u.search)) res.writeHead(404).end();
  });
  server.on("upgrade", (req, socket, head) => {
    if (!fight.upgrade(req, socket, head)) socket.destroy();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(async () => {
  fight.close();
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(root, { recursive: true, force: true });
});

const addMatch = (id: bigint, status: StakedMatch["status"] = "active") => matches.set(id, { id, p1: stranger.address, p2: stranger.address, key1: k1.address, key2: k2.address, referee: referee.address, status, windowEnd: 0 });
const open = (room: string, role: "host" | "guest", sig?: string) =>
  new Promise<{ ws: WebSocket; got: string[]; status?: number }>((resolve) => {
    const ws = new WebSocket(`ws://${base}${FIGHT_PREFIX}/ws?room=${room}&role=${role}${sig ? `&sig=${sig}` : ""}`);
    const got: string[] = [];
    ws.on("message", (d) => got.push(d.toString()));
    ws.on("open", () => resolve({ ws, got }));
    ws.on("unexpected-response", (_q, res) => resolve({ ws, got, status: res.statusCode }));
    ws.on("error", () => resolve({ ws, got }));
  });
const until = async (f: () => boolean) => {
  for (let i = 0; i < 200 && !f(); i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(f(), "timed out");
};
const joinSig = (a: typeof k1, room: string, role: "host" | "guest") => a.signMessage({ message: joinMessage(room, role) });

describe("staked rooms", () => {
  it("admit only the match's two players, each proving their per-match key", async () => {
    addMatch(1n);
    const room = roomForMatch(1n);
    assert.equal((await open(room, "host")).status, 401); // no signature
    assert.equal((await open(room, "host", await joinSig(stranger, room, "host"))).status, 401); // someone else's key
    assert.equal((await open(room, "host", await joinSig(k2, room, "host"))).status, 401); // the guest's key as host
    assert.equal((await open(room, "guest", await joinSig(k1, room, "guest"))).status, 401); // the host's key as guest
    assert.equal((await open(room, "host", await joinSig(k1, room, "guest"))).status, 401); // a signature for the other role
    const h = await open(room, "host", await joinSig(k1, room, "host"));
    const g = await open(room, "guest", await joinSig(k2, room, "guest"));
    assert.equal(h.status, undefined);
    assert.equal(g.status, undefined);
    await until(() => g.got.includes("sready"));
    h.ws.close();
    g.ws.close();
  });
  it("refuse rooms for matches that do not exist or are no longer active", async () => {
    const room = roomForMatch(2n);
    assert.equal((await open(room, "host", await joinSig(k1, room, "host"))).status, 401); // no such match
    for (const status of ["proposed", "disputed", "settled"] as const) {
      addMatch(2n, status);
      assert.equal((await open(room, "host", await joinSig(k1, room, "host"))).status, 401, status);
    }
  });
  it("leave free-play rooms alone", async () => {
    const h = await open("FREE01", "host");
    assert.equal(h.status, undefined);
    h.ws.close();
  });
  it("settle a finished match on the chain with the replay's winner", async () => {
    addMatch(3n);
    const room = roomForMatch(3n);
    nextReplay = replay({ winner: "guest", score: [1, 2] });
    settled.length = 0;
    const h = await open(room, "host", await joinSig(k1, room, "host"));
    const g = await open(room, "guest", await joinSig(k2, room, "guest"));
    await until(() => g.got.includes("sready"));
    h.ws.send("r1:1|1|i2$|");
    await until(() => g.got.includes("r1:1|1|i2$|"));
    g.ws.close();
    await until(() => settled.length === 1);
    assert.equal(settled[0].matchId, 3n);
    assert.equal(settled[0].outcome, OUTCOME_P2);
    assert.deepEqual([settled[0].p1Score, settled[0].p2Score], [1, 2]);
    assert.match(settled[0].record, /^0x[0-9a-f]{64}$/);
    h.ws.close();
  });
  it("turn a mid-match leave into a forfeit, and an early leave into a refund", async () => {
    for (const [id, leaver, rep, expected] of [
      [4n, "guest", replay({ finished: false, winner: null, rounds: 2, score: [1, 0], stampsChecked: 20 }), OUTCOME_P1],
      [5n, "host", replay({ finished: false, winner: null, rounds: 2, score: [1, 0], stampsChecked: 20 }), OUTCOME_P2],
      [6n, "guest", replay({ finished: false, winner: null, rounds: 1, score: [0, 0], confirmedFrame: 30, stampsChecked: 0 }), OUTCOME_VOID],
    ] as const) {
      addMatch(id);
      const room = roomForMatch(id);
      nextReplay = rep;
      settled.length = 0;
      const h = await open(room, "host", await joinSig(k1, room, "host"));
      const g = await open(room, "guest", await joinSig(k2, room, "guest"));
      await until(() => g.got.includes("sready"));
      h.ws.send("r1:1|1|i2$|");
      await until(() => g.got.includes("r1:1|1|i2$|"));
      (leaver === "guest" ? g : h).ws.close();
      await until(() => settled.length === 1);
      assert.equal(settled[0].outcome, expected, `match ${id}`);
      h.ws.close();
      g.ws.close();
    }
  });
  it("record a failed settlement instead of crashing, and keep the details", async () => {
    addMatch(7n);
    const room = roomForMatch(7n);
    nextReplay = replay();
    failSettle = true;
    const h = await open(room, "host", await joinSig(k1, room, "host"));
    const g = await open(room, "guest", await joinSig(k2, room, "guest"));
    await until(() => g.got.includes("sready"));
    h.ws.send("r1:1|1|i2$|");
    await until(() => g.got.includes("r1:1|1|i2$|"));
    g.ws.close();
    await until(() => logged.some((l) => l.includes("could not settle match 7") && l.includes("the node is down")));
    failSettle = false;
    h.ws.close();
  });
});
