// Compares two per-frame hash files (from scripts/fight-determinism.ts with HASH_OUT, and scripts/fight-headless.cjs).
//   node scripts/fight-compare.mjs browser.json node.json
// With --fingerprint it instead prints the same fingerprint the browser probe (?probe=) shows, from one hash file:
//   node scripts/fight-compare.mjs --fingerprint node.json
import fs from "node:fs";
if (process.argv[2] === "--fingerprint") {
  const hashes = JSON.parse(fs.readFileSync(process.argv[3], "utf8")).map((h) => (h.startsWith("err") ? "err" : h));
  const hex = (n) => ("00000000" + (n >>> 0).toString(16)).slice(-8);
  let a = 2166136261, b = 3735928559, n = 0;
  const cps = [];
  hashes.forEach((h, i) => {
    if (i === 0) return; // the probe leaves out the first frame, which carries a start-up counter
    const t = n++ > 0 ? "\n" + h : h;
    for (let k = 0; k < t.length; k++) {
      a = Math.imul(a ^ t.charCodeAt(k), 16777619) >>> 0;
      b = Math.imul(b ^ t.charCodeAt(k), 16777619) >>> 0;
    }
    if ((i + 1) % 250 === 0) cps.push(`${i + 1}:${hex(a)}${hex(b)}`);
  });
  console.log(`game fingerprint ${hex(a)}${hex(b)}`);
  console.log(`checkpoints: ${cps.join("  ")}`);
  process.exit(0);
}
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
