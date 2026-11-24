import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { WebSocket } from "ws";
import { createFight, FIGHT_PREFIX, type Fight } from "./fight.ts";
import { FightLog, GUEST, HOST, fightGenesis, joinMessage, verifyFightLog, type FightLogFile } from "./fightLog.ts";

const referee = privateKeyToAccount(generatePrivateKey());
const alice = privateKeyToAccount(generatePrivateKey());
const bob = privateKeyToAccount(generatePrivateKey());

const build = async () => {
  const log = new FightLog("R-1", 1_000, alice.address, bob.address);
  log.append(HOST, "r1:4|4|i5$|", 1_010);
  log.append(GUEST, "r1:3|3|i4$|", 1_016);
  log.append(HOST, "r1:5|5|i6$|", 1_033);
  return log.finalize(referee, "guest left", 4_000);
};
const clone = (f: FightLogFile): FightLogFile => JSON.parse(JSON.stringify(f));

describe("fight match record", () => {
  it("chains every message, stamps the server's time, and verifies against the referee's signature", async () => {
    const f = await build();
    assert.equal(f.head.count, 3);
    assert.deepEqual(f.entries.map((e) => e.at), [10, 16, 33]);
    assert.equal(f.head.durationMs, 3000);
    assert.equal(f.head.host, alice.address);
    const v = await verifyFightLog(f, referee.address);
    assert.deepEqual(v.errors, []);
    assert.ok(v.ok);
  });
  it("starts every record from a genesis tied to its id, so records cannot be swapped between matches", async () => {
    assert.notEqual(fightGenesis("R-1"), fightGenesis("R-2"));
    const f = clone(await build());
    f.head.room = "R-2";
    assert.equal((await verifyFightLog(f)).ok, false);
  });
  it("rejects an edited message, a removed one, a reordered pair, and a changed time", async () => {
    const base = await build();
    const edited = clone(base);
    edited.entries[1].payload = "r1:3|3|i4$|x";
    assert.equal((await verifyFightLog(edited)).ok, false);
    const removed = clone(base);
    removed.entries.splice(1, 1);
    assert.equal((await verifyFightLog(removed)).ok, false);
    const swapped = clone(base);
    [swapped.entries[0], swapped.entries[1]] = [swapped.entries[1], swapped.entries[0]];
    assert.equal((await verifyFightLog(swapped)).ok, false);
    const retimed = clone(base);
    retimed.entries[2].at += 1;
    assert.equal((await verifyFightLog(retimed)).ok, false);
  });
  it("rejects a message appended after signing and a signature from the wrong key", async () => {
    const base = await build();
    const extended = clone(base);
    extended.entries.push({ ...extended.entries[2], seq: 3 });
    assert.equal((await verifyFightLog(extended)).ok, false);
    const other = privateKeyToAccount(generatePrivateKey());
    const v = await verifyFightLog(base, other.address);
    assert.equal(v.ok, false);
    assert.ok(v.errors.some((e) => e.includes("expected referee")));
    const forged = clone(base);
    forged.head.reason = "host left";
    assert.equal((await verifyFightLog(forged, referee.address)).ok, false);
  });
  it("refuses to append once closed", async () => {
    const log = new FightLog("R-3", 0);
    await log.finalize(referee, "closed", 10);
    assert.throws(() => log.append(HOST, "x", 11), /closed/);
  });
});

let root: string, server: Server, fight: Fight, base: string, logDir: string;
before(async () => {
  root = mkdtempSync(join(tmpdir(), "fightlog-"));
  const game = join(root, "game");
  const ref = join(root, "ref");
  logDir = join(root, "logs");
  mkdirSync(join(game, "fork-core", "src"), { recursive: true });
  mkdirSync(join(ref, "TEMP_REF__site"), { recursive: true });
  mkdirSync(join(ref, "TEMP_REF__assets"), { recursive: true });
  writeFileSync(join(game, "fork-core", "src", "main.ws1.js"), "x");
  fight = createFight({ gameDir: game, refDir: ref, referee, logDir, keepAliveMs: 60_000, statsMs: 60_000, log: () => {} });
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

const open = (room: string, role: "host" | "guest", extra = "") =>
  new Promise<{ ws: WebSocket; got: string[]; status?: number }>((resolve) => {
    const ws = new WebSocket(`ws://${base}${FIGHT_PREFIX}/ws?room=${room}&role=${role}${extra}`);
    const got: string[] = [];
    ws.on("message", (d) => got.push(d.toString()));
    ws.on("open", () => resolve({ ws, got }));
    ws.on("unexpected-response", (_req, res) => resolve({ ws, got, status: res.statusCode }));
    ws.on("error", () => resolve({ ws, got }));
  });
const until = async (f: () => boolean) => {
  for (let i = 0; i < 150 && !f(); i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(f(), "timed out");
};
const records = () => (existsSync(logDir) ? readdirSync(logDir) : []);
const sign = (a: typeof alice, room: string, role: "host" | "guest") => a.signMessage({ message: joinMessage(room, role) });

describe("fight relay records", () => {
  it("records a played room, signs it when a player leaves, serves it, and writes it to disk", async () => {
    const sa = await sign(alice, "REC001", "host");
    const sb = await sign(bob, "REC001", "guest");
    const h = await open("REC001", "host", `&addr=${alice.address}&sig=${sa}`);
    const g = await open("REC001", "guest", `&addr=${bob.address}&sig=${sb}`);
    await until(() => h.got.includes("sready") && g.got.includes("sready"));
    h.ws.send("r1:1|1|i2$|");
    await until(() => g.got.includes("r1:1|1|i2$|"));
    g.ws.send("r1:2|2|i3$|");
    await until(() => h.got.includes("r1:2|2|i3$|"));
    h.ws.send("r1:2|2|i3$|2");
    await until(() => g.got.includes("r1:2|2|i3$|2"));
    g.ws.close();
    await until(() => records().length === 1);
    const file = JSON.parse(readFileSync(join(logDir, records()[0]), "utf8")) as FightLogFile;
    assert.deepEqual(await verifyFightLog(file, referee.address), { ok: true, errors: [] });
    assert.deepEqual(file.entries.map((e) => [e.side, e.payload]), [[HOST, "r1:1|1|i2$|"], [GUEST, "r1:2|2|i3$|"], [HOST, "r1:2|2|i3$|2"]]);
    assert.equal(file.head.host, alice.address);
    assert.equal(file.head.guest, bob.address);
    assert.equal(file.head.reason, "guest left");
    const served = (await (await fetch(`http://${base}${FIGHT_PREFIX}/log/${file.head.room}`)).json()) as FightLogFile;
    assert.equal(served.head.head, file.head.head);
    assert.equal((await fetch(`http://${base}${FIGHT_PREFIX}/log/nope`)).status, 404);
    h.ws.close();
  });
  it("does not keep a record for a room where nothing was played", async () => {
    const before = records().length;
    const h = await open("EMPTY1", "host");
    const g = await open("EMPTY1", "guest");
    await until(() => g.got.includes("sready"));
    g.ws.close();
    await until(() => h.got.includes("sleft"));
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(records().length, before);
    h.ws.close();
  });
  it("accepts an unsigned join unless the signature is wrong, and refuses a signature for another room, role or address", async () => {
    const plain = await open("AUTH01", "host");
    assert.equal(plain.status, undefined);
    plain.ws.close();
    const wrongRoom = await open("AUTH02", "host", `&sig=${await sign(alice, "OTHER", "host")}&addr=${alice.address}`);
    assert.equal(wrongRoom.status, 401);
    const wrongRole = await open("AUTH03", "host", `&sig=${await sign(alice, "AUTH03", "guest")}&addr=${alice.address}`);
    assert.equal(wrongRole.status, 401);
    const wrongAddr = await open("AUTH04", "host", `&sig=${await sign(alice, "AUTH04", "host")}&addr=${bob.address}`);
    assert.equal(wrongAddr.status, 401);
    const garbage = await open("AUTH05", "host", "&sig=0xdead");
    assert.equal(garbage.status, 401);
  });
});

describe("fight relay with required identity", () => {
  it("refuses a join that carries no signature", async () => {
    const root2 = mkdtempSync(join(tmpdir(), "fightauth-"));
    const game = join(root2, "game");
    const ref = join(root2, "ref");
    mkdirSync(join(game, "fork-core", "src"), { recursive: true });
    mkdirSync(join(ref, "TEMP_REF__site"), { recursive: true });
    mkdirSync(join(ref, "TEMP_REF__assets"), { recursive: true });
    writeFileSync(join(game, "fork-core", "src", "main.ws1.js"), "x");
    const strict = createFight({ gameDir: game, refDir: ref, referee, requireAuth: true, log: () => {} });
    const srv = createServer((_q, res) => res.writeHead(404).end());
    srv.on("upgrade", (req, socket, head) => {
      if (!strict.upgrade(req, socket, head)) socket.destroy();
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as { port: number }).port;
    const status = await new Promise<number | undefined>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}${FIGHT_PREFIX}/ws?room=STRICT&role=host`);
      ws.on("open", () => resolve(undefined));
      ws.on("unexpected-response", (_q, res) => resolve(res.statusCode));
      ws.on("error", () => resolve(0));
    });
    assert.equal(status, 401);
    const sa = await sign(alice, "STRICT", "host");
    const okStatus = await new Promise<number | undefined>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}${FIGHT_PREFIX}/ws?room=STRICT&role=host&addr=${alice.address}&sig=${sa}`);
      ws.on("open", () => {
        ws.close();
        resolve(undefined);
      });
      ws.on("unexpected-response", (_q, res) => resolve(res.statusCode));
      ws.on("error", () => resolve(0));
    });
    assert.equal(okStatus, undefined);
    strict.close();
    await new Promise<void>((r) => srv.close(() => r()));
    rmSync(root2, { recursive: true, force: true });
  });
});
