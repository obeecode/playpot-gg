// Plays the Fight test game through the PlayPot server paths: two browsers, one room, one short match.
// Needs the game's files on this machine (they are never in this repository):
//   FIGHT_DIR=<gameplay-core checkout>  FIGHT_REF=<folder with TEMP_REF__site and TEMP_REF__assets>  node scripts/ui-test-fight.ts
// Without them the test is skipped.
import { createServer } from "node:http";
import { chromium, type Page } from "playwright-core";
import { createFight, fightFromEnv, FIGHT_PREFIX } from "../packages/server/src/fight.ts";

const env = fightFromEnv();
if (env.problem) console.log(`skipped: ${env.problem}`);
if (!env.options) process.exit(0);

const fight = createFight(env.options);
const missing: string[] = [];
const server = createServer((req, res) => {
  const u = new URL(req.url ?? "/", "http://x");
  if (!fight.http(req, res, u.pathname, u.search)) {
    if (u.pathname !== "/favicon.ico") missing.push(u.pathname); // anything the game asks for outside /g/fight would be a path bug
    res.writeHead(404).end();
  }
});
server.on("upgrade", (req, socket, head) => {
  if (!fight.upgrade(req, socket, head)) socket.destroy();
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? process.env.CHROME, args: ["--no-sandbox", "--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const failures: string[] = [];
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};
const player = async () => {
  const ctx = await browser.newContext({ viewport: { width: 960, height: 540 } });
  const p = await ctx.newPage();
  const errors = new Map<string, number>();
  p.on("pageerror", (e) => errors.set(e.message, (errors.get(e.message) ?? 0) + 1));
  return { p, errors };
};
const fc = <T>(p: Page, f: string) => p.evaluate(f) as Promise<T>;

try {
  const host = await player();
  const guest = await player();
  await host.p.goto(`${base}${FIGHT_PREFIX}/`);
  await host.p.waitForFunction("window.__fc && window.__fc.CM", undefined, { timeout: 60_000 });
  await host.p.waitForTimeout(8000);
  const link = await fc<string>(host.p, "(() => { const r = __fc.NET.newRoom(); __fc.NET.open('host', r); return __fc.NET.link(r); })()");
  check(link.includes(`${FIGHT_PREFIX}/?room=`), `invite link stays under ${FIGHT_PREFIX} (${link.replace(base, "")})`);
  await guest.p.goto(link);
  await guest.p.waitForFunction("window.__fc && window.__fc.NET && window.__fc.NET.active", undefined, { timeout: 60_000 });
  check(true, "guest joined the host's room through the link");
  check(await fc<boolean>(host.p, "__fc.NET.active"), "host sees its opponent");
  await host.p.waitForTimeout(6000); // let both select screens finish drawing
  for (const { p } of [host, guest]) {
    await p.mouse.click(480, 300);
    await p.keyboard.press("f"); // online, each player readies with their own F key
    await p.waitForTimeout(500);
  }
  await host.p.waitForFunction("__fc.CM.mode === 'match'", undefined, { timeout: 30_000 });
  await guest.p.waitForFunction("__fc.CM.mode === 'match'", undefined, { timeout: 30_000 });
  check(true, "both players are in the match");
  for (let i = 0; i < 40; i++) {
    for (const { p } of [host, guest]) {
      await p.keyboard.down("d");
      await p.keyboard.press("f");
    }
    await host.p.waitForTimeout(200);
    for (const { p } of [host, guest]) await p.keyboard.up("d");
  }
  const fh = await fc<number>(host.p, "__fc.GameSession.executionFrame");
  const fg = await fc<number>(guest.p, "__fc.GameSession.executionFrame");
  check(fh > 100 && Math.abs(fh - fg) < 30, `both clients advance in step (frames ${fh} and ${fg})`);
  check(missing.length === 0, `nothing requested outside ${FIGHT_PREFIX}${missing.length ? ": " + [...new Set(missing)].slice(0, 5).join(", ") : ""}`);
  const other = [...host.errors.keys(), ...guest.errors.keys()].filter((m) => !m.includes("reading 'wb'"));
  check(other.length === 0, `no page errors besides the known 'wb' one${other.length ? ": " + other[0] : ""}`);
} finally {
  await browser.close();
  fight.close();
  server.close();
}
if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("\nfight ui test passed");
process.exit(0);
