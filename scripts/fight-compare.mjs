// Compares two per-frame hash files (from scripts/fight-determinism.ts with HASH_OUT, and scripts/fight-headless.cjs).
//   node scripts/fight-compare.mjs browser.json node.json
import fs from "node:fs";
const [fa, fb] = process.argv.slice(2);
if (!fa || !fb) throw new Error("usage: node scripts/fight-compare.mjs a.json b.json");
const a = JSON.parse(fs.readFileSync(fa, "utf8")), b = JSON.parse(fs.readFileSync(fb, "utf8"));
let valid = 0, differing = 0, unavailable = 0, first = -1;
for (let i = 0; i < Math.min(a.length, b.length); i++) {
  const ea = a[i].startsWith("err"), eb = b[i].startsWith("err");
  if (ea && eb) { unavailable++; continue; } // the game has no snapshot for that frame in either run (after the match ended)
  if (ea !== eb || a[i] !== b[i]) { differing++; if (first < 0) first = i; } else valid++;
}
console.log(`frames compared: ${valid + differing}, identical: ${valid}, different: ${differing}, unavailable in both: ${unavailable}`);
if (differing) { console.log(`first difference at frame index ${first}:\n  ${fa}: ${a[first]}\n  ${fb}: ${b[first]}`); process.exit(1); }
console.log("the two runs agree on every frame");
