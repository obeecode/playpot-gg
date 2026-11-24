import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { WebSocket } from "ws";
import { checkFightFiles, createFight, fightFromEnv, FIGHT_PREFIX, type Fight } from "./fight.ts";

const MAIN = 'const a = "https://be.counterpicklabs.com"; const w = "wss://be.counterpicklabs.com"; new WebSocket(x + location.host + "/ws?room=" + r); link = (base || location.origin) + "/?room=" + room;';

let root: string, server: Server, fight: Fight, base: string;
const logged: string[] = [];

before(async () => {
  root = mkdtempSync(join(tmpdir(), "fight-"));
  const game = join(root, "game");
  const ref = join(root, "ref");
  mkdirSync(join(game, "fork-core", "src"), { recursive: true });
  mkdirSync(join(ref, "TEMP_REF__site", "assets", "misc"), { recursive: true });
  mkdirSync(join(ref, "TEMP_REF__assets", "packed_sprites"), { recursive: true });
  writeFileSync(join(game, "fork-core", "src", "main.ws1.js"), MAIN);
  writeFileSync(join(ref, "TEMP_REF__site", "TEMP_REF__index.html"), '<html><head><script src="https://accounts.google.com/gsi/client" async></script></head><body>game</body></html>');
  writeFileSync(join(ref, "TEMP_REF__site", "TEMP_REF__main.abc123.js"), "ORIGINAL");
  writeFileSync(join(ref, "TEMP_REF__site", "TEMP_REF__455.def456.js"), "if(!('~'>x){y}});a10r();rest");
  writeFileSync(join(ref, "TEMP_REF__site", "assets", "misc", "TEMP_REF__fighter.atlas"), "atlas");
  writeFileSync(join(ref, "TEMP_REF__assets", "packed_sprites", "TEMP_REF__ui.json"), "{}");
  writeFileSync(join(root, "secret.txt"), "do not serve");
  fight = createFight({ gameDir: game, refDir: ref, keepAliveMs: 60_000, statsMs: 100, log: (l) => logged.push(l) });
  server = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    if (!fight.http(req, res, u.pathname, u.search)) {
      res.writeHead(404);
      res.end("other");
    }
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

const get = (path: string) => fetch(`http://${base}${path}`, { redirect: "manual" });

describe("fight files", () => {
  it("serves the page from the TEMP_REF__ labelled files and strips third-party scripts", async () => {
    const r = await get(`${FIGHT_PREFIX}/`);
    assert.equal(r.status, 200);
    const t = await r.text();
    assert.ok(t.includes("game"));
    assert.ok(!t.includes("accounts.google.com"));
    assert.ok(t.includes(`window.GAME_API_BASE="http://${base}${FIGHT_PREFIX}"`));
    assert.ok(t.includes(`window.GAME_WS_BASE="ws://${base}${FIGHT_PREFIX}"`));
  });
  it("redirects /g/fight to /g/fight/ and keeps the room code", async () => {
    const r = await get(`${FIGHT_PREFIX}?room=ABCDEF`);
    assert.equal(r.status, 302);
    assert.equal(r.headers.get("location"), `${FIGHT_PREFIX}/?room=ABCDEF`);
  });
  it("serves the fork's main script, pointed at this server and path", async () => {
    const t = await (await get(`${FIGHT_PREFIX}/main.abc123.js`)).text();
    assert.ok(!t.includes("counterpicklabs.com"));
    assert.ok(t.includes(`http://${base}${FIGHT_PREFIX}`));
    assert.ok(t.includes(`ws://${base}${FIGHT_PREFIX}`));
    assert.ok(t.includes(`location.host + "${FIGHT_PREFIX}/ws?room="`));
    assert.ok(t.includes(`"${FIGHT_PREFIX}/?room="`));
    assert.ok(!t.includes("ORIGINAL"));
  });
  it("uses the https and wss origin behind a tunnel", async () => {
    const t = await new Promise<string>((resolve, reject) => {
      const [hostname, port] = base.split(":");
      const rq = request({ hostname, port: Number(port), path: `${FIGHT_PREFIX}/main.abc123.js`, headers: { host: "app.example.test", "x-forwarded-proto": "https" } }, (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => resolve(d));
      });
      rq.on("error", reject);
      rq.end();
    });
    assert.ok(t.includes(`https://app.example.test${FIGHT_PREFIX}`));
    assert.ok(t.includes(`wss://app.example.test${FIGHT_PREFIX}`));
  });
  it("removes the domain guard from original chunks, in the served copy only", async () => {
    const t = await (await get(`${FIGHT_PREFIX}/455.def456.js`)).text();
    assert.ok(!t.includes("a10r();"));
  });
  it("finds files in either reference folder, with or without the label in the request", async () => {
    assert.equal(await (await get(`${FIGHT_PREFIX}/assets/misc/fighter.atlas`)).text(), "atlas");
    assert.equal(await (await get(`${FIGHT_PREFIX}/assets/misc/TEMP_REF__fighter.atlas`)).text(), "atlas");
    assert.equal(await (await get(`${FIGHT_PREFIX}/packed_sprites/ui.json`)).text(), "{}");
  });
  it("answers the startup API calls itself", async () => {
    assert.equal(await (await get(`${FIGHT_PREFIX}/api/misc/vs`)).text(), '{"s":[]}');
    assert.equal((await get(`${FIGHT_PREFIX}/api/anything/else`)).status, 404);
  });
  it("does not serve files outside the reference folders", async () => {
    for (const p of ["/../../secret.txt", "/%2e%2e/%2e%2e/secret.txt", "/..%5c..%5csecret.txt"]) {
      const r = await get(`${FIGHT_PREFIX}${p}`);
      assert.ok(r.status === 404 || r.status === 400, p);
      assert.ok(!(await r.text()).includes("do not serve"));
    }
  });
  it("leaves other paths alone", async () => {
    assert.equal(await (await get("/state")).text(), "other");
    assert.equal(await (await get("/g/fighter/x")).text(), "other");
  });
});

const open = (room: string, role: string) =>
  new Promise<{ ws: WebSocket; got: string[] }>((resolve) => {
    const ws = new WebSocket(`ws://${base}${FIGHT_PREFIX}/ws?room=${room}&role=${role}`);
    const got: string[] = [];
    ws.on("message", (d) => got.push(d.toString()));
    ws.on("open", () => resolve({ ws, got }));
    ws.on("error", () => resolve({ ws, got }));
  });
const until = async (f: () => boolean) => {
  for (let i = 0; i < 100 && !f(); i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(f(), "timed out");
};

describe("fight relay", () => {
  it("pairs a host and a guest, forwards text between them, and tells the other when one leaves", async () => {
    const h = await open("ROOM01", "host");
    const g = await open("ROOM01", "guest");
    await until(() => h.got.includes("sready") && g.got.includes("sready"));
    h.ws.send("r1:4|4|i5$|");
    g.ws.send('c{"t":"hello"}');
    await until(() => g.got.includes("r1:4|4|i5$|") && h.got.includes('c{"t":"hello"}'));
    g.ws.close();
    await until(() => h.got.includes("sleft"));
    h.ws.close();
    await until(() => fight.rooms() === 0);
  });
  it("logs how each player\'s connection behaves while a room is playing", async () => {
    const h = await open("ROOM04", "host");
    const g = await open("ROOM04", "guest");
    await until(() => g.got.includes("sready"));
    for (let i = 0; i < 5; i++) {
      h.ws.send("r1:x");
      await new Promise((r) => setTimeout(r, 40));
    }
    await until(() => logged.some((l) => l.includes("ROOM04") && /host \d+ msg\/s, longest silence \d+ ms, ping/.test(l) && l.includes("guest")));
    h.ws.close();
    g.ws.close();
  });
  it("tells a guest when nobody is hosting and refuses a second player in the same role", async () => {
    const g = await open("NOHOST", "guest");
    await until(() => g.got.includes("snohost"));
    const h1 = await open("ROOM02", "host");
    const h2 = await open("ROOM02", "host");
    await until(() => h2.got.includes("sfull"));
    h1.ws.close();
  });
  it("closes the room when the host leaves", async () => {
    const h = await open("ROOM03", "host");
    const g = await open("ROOM03", "guest");
    await until(() => g.got.includes("sready"));
    const closed = new Promise<number>((r) => g.ws.on("close", (c) => r(c)));
    h.ws.close();
    assert.equal(await closed, 1000);
    await until(() => fight.rooms() === 0);
  });
  it("rejects a bad room code or role", async () => {
    for (const q of ["room=x&role=host", "room=ABCDEF&role=spectator", "role=host"]) {
      const failed = await new Promise<boolean>((resolve) => {
        const ws = new WebSocket(`ws://${base}${FIGHT_PREFIX}/ws?${q}`);
        ws.on("open", () => resolve(false));
        ws.on("error", () => resolve(true));
      });
      assert.ok(failed, q);
    }
  });
});

describe("fight config", () => {
  it("is off unless both folders are given, and says what is wrong", () => {
    assert.deepEqual(fightFromEnv({}), {});
    assert.ok(fightFromEnv({ FIGHT_DIR: "/x" }).problem?.includes("FIGHT_REF"));
    assert.ok(fightFromEnv({ FIGHT_DIR: join(root, "game"), FIGHT_REF: join(root, "nope") }).problem?.includes("TEMP_REF__site"));
    assert.ok(fightFromEnv({ FIGHT_DIR: join(root, "game"), FIGHT_REF: join(root, "ref") }).options);
    assert.equal(checkFightFiles({ gameDir: join(root, "game"), refDir: join(root, "ref") }), undefined);
  });
});
