// Runs the Fight game's rules in plain Node and writes the game's own per-frame state hash while it plays seeded scripted inputs,
// the same inputs scripts/fight-determinism.ts sends to a real browser, so the two can be compared with scripts/fight-compare.mjs.
//   FIGHT_DIR=<gameplay-core> FIGHT_REF=<counterpick-ref> node scripts/fight-headless.cjs [frames] [seed] [out.json]
if (!process.env.FIGHT_DIR || !process.env.FIGHT_REF) { console.log("skipped: set FIGHT_DIR and FIGHT_REF"); process.exit(0); }
const fs = require("fs");
const { boot, deep } = require("./lib/fight-headless-env.cjs");
const log = (...a) => console.log(...a);
const N = Number(process.argv[2] || 600), SEED = Number(process.argv[3] || 1);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function rng(seed) { let x = seed | 0 || 1; return () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return (x >>> 0) / 4294967296; }; }
(async () => {
  const { g } = await boot();
  log("boot done:", !!(g.__fc && g.__fc.CM && g.__fc.CM.handlers));
  if (!g.__fc.CM.ui) g.__fc.CM.ui = deep("ui");
  await g.__fc.CM.startMatch();
  await sleep(300);
  const GS = g.__fc.GameSession;
  for (let i = 0; i < 400 && GS.executionFrame < 200; i++) GS.tick();
  log("start frame:", GS.executionFrame);
  const KEYS = ["KeyA:a:65", "KeyD:d:68", "KeyW:w:87", "KeyF:f:70", "KeyG:g:71", "KeyE:e:69", "ArrowLeft:ArrowLeft:37", "ArrowRight:ArrowRight:39", "Period:.:190", "Slash:/:191"];
  const down = new Set(), r = rng(SEED);
  const ev = (code, key, kc) => ({ code, key, keyCode: kc, which: kc, preventDefault() {}, stopPropagation() {}, repeat: false, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, target: g.document });
  const hashes = [];
  let t0 = process.hrtime.bigint(), errors = 0;
  for (let f = 0; f < N; f++) {
    if (f % 8 === 0) {
      for (const k of KEYS) { const [code, key, kcs] = k.split(":"); const kc = Number(kcs); const want = r() < 0.3; if (want && !down.has(code)) { down.add(code); g.__fire("keydown", ev(code, key, kc)); } else if (!want && down.has(code)) { down.delete(code); g.__fire("keyup", ev(code, key, kc)); } }
    }
    try { GS.tick(); } catch (e) { errors++; if (errors < 3) log("tick error:", String(e.message).slice(0, 160)); }
    let h = "?";
    try { h = String(GS.getFrameSnapshot(GS.executionFrame).G2()); } catch (e) { h = "err:" + String(e.message).slice(0, 40); }
    hashes.push(h);
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  log("frames:", N, "executionFrame:", GS.executionFrame, "tick errors:", errors, "| per tick:", (ms / N * 1000).toFixed(0), "us (includes hashing)");
  log("hash sample:", hashes.slice(0, 3).join(","), "...", hashes.slice(-3).join(","), "| distinct:", new Set(hashes).size);
  fs.writeFileSync(process.argv[4] || "fight-headless-hashes.json", JSON.stringify(hashes));
  process.exit(0);
})();
