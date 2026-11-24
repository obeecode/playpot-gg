// Does the Fight game's simulation replay exactly? Plays the same scripted (random but seeded) inputs through the game twice, in
// two fresh browsers, stepping frames by hand, and compares the game's own per-frame state hash. Also reports the cost per frame.
//   FIGHT_DIR=<gameplay-core> FIGHT_REF=<counterpick-ref> node scripts/fight-determinism.ts [frames] [seed]
// The game listens for keys on document, so the script sends them there. Skipped when the game's files are not configured.
import { createServer } from "node:http";
import { chromium } from "playwright-core";
import { createFight, fightFromEnv, FIGHT_PREFIX } from "../packages/server/src/fight.ts";
const N = Number(process.argv[2] ?? 1800), SEED = Number(process.argv[3] ?? 7);
const env = fightFromEnv();
if (!env.options) {
  console.log(`skipped: ${env.problem ?? "set FIGHT_DIR and FIGHT_REF"}`);
  process.exit(0);
}
const fight = createFight(env.options);
const server = createServer((req, res) => { const u = new URL(req.url ?? "/", "http://x"); if (!fight.http(req, res, u.pathname, u.search)) res.writeHead(404).end(); });
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1243/chrome-linux64/chrome", args: ["--no-sandbox", "--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
async function run(): Promise<{ hashes: string[]; ms: number; errors: number; frame: number; startFrame: number }> {
  const c = await b.newContext({ viewport: { width: 960, height: 540 } });
  const p = await c.newPage();
  await p.addInitScript(() => { (window as any).__rafOn = true; const raf = window.requestAnimationFrame.bind(window); window.requestAnimationFrame = (cb) => ((window as any).__rafOn ? raf(cb) : 0); });
  await p.goto(`${base}${FIGHT_PREFIX}/`);
  await p.waitForFunction("window.__fc && window.__fc.CM && window.__fc.CM.handlers", undefined, { timeout: 90000 });
  await p.waitForTimeout(3000);
  const out = await p.evaluate(async ({ N, SEED }) => {
    (window as any).__rafOn = false;
    await new Promise((r) => setTimeout(r, 300));
    const fc = (window as any).__fc, GS = fc.GameSession;
    await fc.CM.startMatch();
    await new Promise((r) => setTimeout(r, 500));
    for (let i = 0; i < 400 && GS.executionFrame < 200; i++) GS.tick(); // start both runs from the same frame number
    const startFrame = GS.executionFrame;
    let x = SEED | 0 || 1; const rnd = () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return (x >>> 0) / 4294967296; };
    const KEYS: [string, string, number][] = [["KeyA", "a", 65], ["KeyD", "d", 68], ["KeyW", "w", 87], ["KeyF", "f", 70], ["KeyG", "g", 71], ["KeyE", "e", 69], ["ArrowLeft", "ArrowLeft", 37], ["ArrowRight", "ArrowRight", 39], ["Period", ".", 190], ["Slash", "/", 191]];
    const down = new Set<string>(); const hashes: string[] = []; let errors = 0;
    const t0 = performance.now();
    for (let f = 0; f < N; f++) {
      if (f % 8 === 0) for (const [code, key, keyCode] of KEYS) { const want = rnd() < 0.3; if (want && !down.has(code)) { down.add(code); document.dispatchEvent(new KeyboardEvent("keydown", { code, key, keyCode, which: keyCode, bubbles: true })); } else if (!want && down.has(code)) { down.delete(code); document.dispatchEvent(new KeyboardEvent("keyup", { code, key, keyCode, which: keyCode, bubbles: true })); } }
      try { GS.tick(); } catch { errors++; }
      let h = "?"; try { h = String(GS.getFrameSnapshot(GS.executionFrame).G2()); } catch { h = "err"; }
      hashes.push(h);
    }
    return { hashes, ms: performance.now() - t0, errors, frame: GS.executionFrame, startFrame };
  }, { N, SEED });
  await c.close();
  return out;
}
const a = await run(), c2 = await run();
let firstDiff = -1; for (let i = 0; i < a.hashes.length; i++) if (a.hashes[i] !== c2.hashes[i]) { firstDiff = i; break; }
console.log(`start frames A/B: ${a.startFrame}/${c2.startFrame}`);
console.log(`run A: ${a.frame} frames, ${a.errors} tick errors, ${(a.ms / N * 1000).toFixed(0)} us per tick (incl. hashing), distinct hashes ${new Set(a.hashes).size}`);
console.log(`run B: ${c2.frame} frames, ${c2.errors} tick errors, ${(c2.ms / N * 1000).toFixed(0)} us per tick, distinct hashes ${new Set(c2.hashes).size}`);
console.log(firstDiff < 0 ? "IDENTICAL: all " + N + " per-frame state hashes match between the two runs" : `DIVERGED at frame index ${firstDiff}: ${a.hashes[firstDiff]} vs ${c2.hashes[firstDiff]}`);
console.log("sample (id,x,y,action,frame counters per fighter):", a.hashes.slice(0, 3).join(","), "...", a.hashes.slice(-2).join(","));
await b.close(); fight.close(); server.close(); process.exit(0);
