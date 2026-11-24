// Reads a Fight match record and reports how each player's messages arrived at the server: how steady, where the stalls were, and
// whether both players stalled together (the shared path: the server's connection or the tunnel) or one alone (that player's link).
//   node scripts/fight-timing.mjs data/fight-logs/<record>.json
import fs from "node:fs";

const file = process.argv[2];
if (!file) {
  console.error("usage: node scripts/fight-timing.mjs <record.json>");
  process.exit(2);
}
const rec = JSON.parse(fs.readFileSync(file, "utf8"));
const game = rec.entries.filter((e) => e.payload.charAt(0) === "r"); // the game's own traffic (control messages are rare)
const names = ["host", "guest"];
const pct = (a, p) => (a.length ? a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))] : 0);
const seconds = (ms) => (ms / 1000).toFixed(1) + " s";

const bySide = [[], []];
for (const e of game) bySide[e.side].push(e.at);
const gapsOf = (ts) => ts.slice(1).map((t, i) => ({ at: ts[i], len: t - ts[i] }));
const gaps = bySide.map(gapsOf);

console.log(`record ${rec.head.room}: ${rec.entries.length} messages over ${seconds(rec.head.durationMs)}, closed because ${rec.head.reason}`);
console.log("");
for (const s of [0, 1]) {
  const g = gaps[s].map((x) => x.len).sort((a, b) => a - b);
  const total = bySide[s].length ? bySide[s][bySide[s].length - 1] - bySide[s][0] : 0;
  const over = (n) => g.filter((x) => x > n).length;
  console.log(`${names[s]}: ${bySide[s].length} messages, ${total ? (bySide[s].length / (total / 1000)).toFixed(0) : 0}/s on average`);
  console.log(`  gap between messages:  typical ${pct(g, 50)} ms, 95th ${pct(g, 95)} ms, 99th ${pct(g, 99)} ms, worst ${g.length ? g[g.length - 1] : 0} ms`);
  console.log(`  stalls:                over 100 ms: ${over(100)}, over 250 ms: ${over(250)}, over 500 ms: ${over(500)}, over 1000 ms: ${over(1000)}`);
}

// stalls (gaps over 250 ms) for each player, and how many happened at the same time for both
const stalls = gaps.map((g) => g.filter((x) => x.len > 250).map((x) => ({ from: x.at, to: x.at + x.len })));
const overlaps = stalls[0].filter((a) => stalls[1].some((b) => a.from < b.to && b.from < a.to));
console.log("");
console.log(`stalls over 250 ms: host ${stalls[0].length}, guest ${stalls[1].length}, at the same moment for both: ${overlaps.length}`);
if (stalls[0].length + stalls[1].length > 0) {
  const share = (overlaps.length / Math.max(1, Math.min(stalls[0].length, stalls[1].length))) * 100;
  console.log(
    share >= 50
      ? "  -> most stalls hit both players together: the shared path (the server's own connection or the tunnel) is the likely cause"
      : "  -> stalls mostly hit one player at a time: that player's own connection is the likely cause",
  );
}
const worst = stalls.flatMap((l, s) => l.map((x) => ({ side: names[s], at: x.from, len: x.to - x.from }))).sort((a, b) => b.len - a.len).slice(0, 8);
if (worst.length) {
  console.log("");
  console.log("longest stalls:");
  for (const w of worst) console.log(`  ${w.side.padEnd(5)} at ${seconds(w.at).padStart(7)} into the match, ${w.len} ms with nothing arriving`);
}

// second-by-second view of the busiest trouble: how many messages arrived each second, and a mark where a second was thin
const secs = Math.ceil(rec.head.durationMs / 1000);
const perSec = [new Array(secs).fill(0), new Array(secs).fill(0)];
for (const e of game) perSec[e.side][Math.min(secs - 1, Math.floor(e.at / 1000))]++;
const med = perSec.map((a) => pct([...a].sort((x, y) => x - y), 50));
const thin = [];
for (let i = 2; i < secs - 1; i++) for (const s of [0, 1]) if (perSec[s][i] < med[s] * 0.6) thin.push(`${names[s]}@${i}s(${perSec[s][i]})`);
console.log("");
console.log(`seconds with far fewer messages than usual (typical ${med[0]}/s host, ${med[1]}/s guest): ${thin.length ? thin.slice(0, 20).join(", ") : "none"}`);
