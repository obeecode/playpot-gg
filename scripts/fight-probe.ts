// Runs the cross-browser determinism probe in Chromium and prints its fingerprint. To compare other browsers, open the same page in
// each by hand: http://localhost:8787/g/fight/?probe=7,1500 (with the server running), or your public address with the same ending.
//   FIGHT_DIR=<gameplay-core> FIGHT_REF=<counterpick-ref> CHROMIUM=<browser path> node scripts/fight-probe.ts [seed] [frames]
// Skipped when the game's files are not configured.
import { createServer } from "node:http";
import { chromium } from "playwright-core";
import { createFight, fightFromEnv, FIGHT_PREFIX } from "../packages/server/src/fight.ts";

const env = fightFromEnv();
if (!env.options) {
  console.log(`skipped: ${env.problem ?? "set FIGHT_DIR and FIGHT_REF"}`);
  process.exit(0);
}
const seed = process.argv[2] ?? "7", frames = process.argv[3] ?? "1500";
const fight = createFight(env.options);
const server = createServer((req, res) => {
  const u = new URL(req.url ?? "/", "http://x");
  if (!fight.http(req, res, u.pathname, u.search)) res.writeHead(404).end();
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? process.env.CHROME, args: ["--no-sandbox", "--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const runs: Array<{ hashes: string[]; fingerprint: string; checkpoints: string[]; math: Record<string, string>; tickErrors: number; framesUnavailable: number }> = [];
for (let i = 0; i < 2; i++) {
  const page = await (await browser.newContext({ viewport: { width: 960, height: 540 } })).newPage();
  page.setDefaultTimeout(240_000);
  await page.goto(`${base}${FIGHT_PREFIX}/?probe=${seed},${frames}`);
  await page.waitForFunction("window.__probe && window.__probe.done", undefined, { timeout: 600_000, polling: 500 }); // not the default animation-frame polling: the probe switches animation frames off
  const r = (await page.evaluate("window.__probe")) as (typeof runs)[number] & { error?: string };
  if (r.error) throw new Error(r.error);
  runs.push(r);
  await page.context().close();
}
await browser.close();
fight.close();
server.close();
if (process.env.HASH_OUT) (await import("node:fs")).writeFileSync(process.env.HASH_OUT, JSON.stringify(runs[0].hashes)); // for scripts/fight-compare.mjs
console.log(`probe ${seed},${frames}`);
runs.forEach((r, i) => console.log(`  run ${i + 1}: game fingerprint ${r.fingerprint}, tick errors ${r.tickErrors}, frames without a snapshot ${r.framesUnavailable}`));
console.log(`  checkpoints: ${runs[0].checkpoints.join("  ")}`);
console.log(`  math: ${Object.entries(runs[0].math).map(([k, v]) => `${k} ${v}`).join("  ")}`);
const same = runs[0].fingerprint === runs[1].fingerprint;
console.log(same ? "the two runs agree" : "THE TWO RUNS DISAGREE");
process.exit(same ? 0 : 1);
