// Plays one full Fight match between two real browsers through the relay and keeps the referee-signed record.
//   FIGHT_DIR=<gameplay-core> FIGHT_REF=<counterpick-ref> CHROMIUM=<browser path> node scripts/fight-record-match.ts [outDir] [seed]
// Both players press random keys (seeded) until the game says the match is over. The server then replays the record headless
// and signs a verdict, which is checked here against what the two real clients saw. Skipped when the game's files are not configured.
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { chromium } from "playwright-core";
import { createFight, fightFromEnv, FIGHT_PREFIX } from "../packages/server/src/fight.ts";
import { WINNER_GUEST, WINNER_HOST, verifyFightLog, verifyVerdict, type FightLogFile, type FightVerdict } from "../packages/server/src/fightLog.ts";

const env = fightFromEnv();
if (!env.options) {
  console.log(`skipped: ${env.problem ?? "set FIGHT_DIR and FIGHT_REF"}`);
  process.exit(0);
}
const outDir = process.argv[2] ?? "fight-records";
const seed = Number(process.argv[3] ?? 5);
mkdirSync(outDir, { recursive: true });
const referee = privateKeyToAccount(generatePrivateKey());
const fight = createFight({ ...env.options, referee, logDir: outDir, log: (l) => console.log(l) });
const server = createServer((req, res) => {
  const u = new URL(req.url ?? "/", "http://x");
  if (!fight.http(req, res, u.pathname, u.search)) res.writeHead(404).end();
});
server.on("upgrade", (req, socket, head) => {
  if (!fight.upgrade(req, socket, head)) socket.destroy();
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? process.env.CHROME, args: ["--no-sandbox", "--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const rng = (s: number) => () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296; };
try {
  const mk = async () => {
    const p = await (await browser.newContext({ viewport: { width: 960, height: 540 } })).newPage();
    return p;
  };
  const host = await mk(), guest = await mk();
  await host.goto(`${base}${FIGHT_PREFIX}/`);
  await host.waitForFunction("window.__fc && window.__fc.CM", undefined, { timeout: 90_000 });
  await host.waitForTimeout(6000);
  const link = (await host.evaluate("(() => { const r = __fc.NET.newRoom(); __fc.NET.open('host', r); return __fc.NET.link(r); })()")) as string;
  await guest.goto(link);
  await guest.waitForFunction("window.__fc && window.__fc.NET && window.__fc.NET.active", undefined, { timeout: 90_000 });
  await host.waitForTimeout(6000);
  for (const p of [host, guest]) {
    await p.mouse.click(480, 300);
    await p.keyboard.press("f");
    await p.waitForTimeout(500);
  }
  await host.waitForFunction("__fc.CM.mode === 'match'", undefined, { timeout: 30_000 });
  const keys = ["a", "d", "w", "f", "g", "e"];
  const r1 = rng(seed), r2 = rng(seed + 1000);
  const held = [new Set<string>(), new Set<string>()];
  const t0 = Date.now();
  let over = false;
  while (!over && Date.now() - t0 < 240_000) {
    for (const [i, p, r] of [[0, host, r1], [1, guest, r2]] as const) {
      for (const k of keys) {
        const want = r() < 0.35;
        if (want && !held[i].has(k)) { held[i].add(k); await p.keyboard.down(k); }
        else if (!want && held[i].has(k)) { held[i].delete(k); await p.keyboard.up(k); }
      }
    }
    await host.waitForTimeout(130);
    over = (await host.evaluate("__fc.CM.phase")) === "over" && (await guest.evaluate("__fc.CM.phase")) === "over";
  }
  const scoreH = await host.evaluate("__fc.CM.score.join('-')"), scoreG = await guest.evaluate("__fc.CM.score.join('-')");
  console.log(`match ${over ? "finished" : "did NOT finish in time"}: host sees ${scoreH}, guest sees ${scoreG}, after ${Math.round((Date.now() - t0) / 1000)} s`);
  await guest.close();
  for (let i = 0; i < 100 && readdirSync(outDir).length === 0; i++) await host.waitForTimeout(100);
  console.log("record:", readdirSync(outDir).map((f) => `${outDir}/${f}`).join(", "));
  console.log("referee address:", referee.address);
  console.log("clients agree on the score:", scoreH === scoreG);
  const recFile = readdirSync(outDir).find((f) => !f.endsWith(".verdict.json"));
  if (recFile) {
    const rec = JSON.parse(readFileSync(`${outDir}/${recFile}`, "utf8")) as FightLogFile;
    console.log("record verifies:", (await verifyFightLog(rec, referee.address)).ok);
    let verdict: FightVerdict | undefined;
    for (let i = 0; i < 3000 && !verdict; i++) {
      const r = await fetch(`${base}${FIGHT_PREFIX}/result/${rec.head.room}`);
      if (r.ok) verdict = (await r.json()) as FightVerdict;
      else await host.waitForTimeout(100);
    }
    if (!verdict) console.log("no verdict arrived");
    else {
      const [h, gs] = String(scoreH).split("-").map(Number);
      console.log(`verdict: clean=${verdict.clean}, winner=${["none", "host", "guest"][verdict.winner]}, score ${verdict.hostScore}-${verdict.guestScore}, ${verdict.rounds} rounds, ${verdict.stampsChecked} state hashes checked`);
      console.log("verdict verifies:", (await verifyVerdict(verdict, rec, referee.address)).ok);
      const expectWinner = h > gs ? WINNER_HOST : WINNER_GUEST;
      console.log("verdict matches what the clients saw:", verdict.clean && verdict.winner === expectWinner && verdict.hostScore === h && verdict.guestScore === gs);
    }
  }
} finally {
  await browser.close();
  fight.close();
  server.close();
}
process.exit(0);
