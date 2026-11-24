// Reads a Fight match record and reports how each player's messages arrived at the server while the match was really being played:
// how steady, where the stalls were, and whether both players stalled together (the shared path: the server's connection or the
// tunnel) or one alone (that player's own link). Loading, the select screen and the "match over" screen are left out.
//   node scripts/fight-timing.mjs data/fight-logs/<record>.json
// (the record is the large file; the small .verdict.json file is something else)
import fs from "node:fs";

const file = process.argv[2];
if (!file) {
  console.error("usage: node scripts/fight-timing.mjs <record.json>");
  process.exit(2);
}
const rec = JSON.parse(fs.readFileSync(file, "utf8"));
if (!Array.isArray(rec.entries)) {
  console.error("that is not a match record (the record is the large .json file, not the .verdict.json one)");
  process.exit(2);
}
const names = ["host", "guest"];
const game = rec.entries.filter((e) => e.payload.charAt(0) === "r");
const pct = (a, p) => (a.length ? a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))] : 0);
const secs = Math.max(1, Math.ceil(rec.head.durationMs / 1000));
const perSec = [new Array(secs).fill(0), new Array(secs).fill(0)];
for (const e of game) perSec[e.side][Math.min(secs - 1, Math.floor(e.at / 1000))]++;

// the game sends a steady stream while it is being played and a trickle on the loading and "match over" screens, so the typical rate
// of the busiest seconds says what "playing" looks like, and the match proper is the stretch where both players send near that rate
const busy = perSec.map((a) => pct([...a].sort((x, y) => x - y), 75));
const playing = (i) => perSec[0][i] >= busy[0] * 0.3 && perSec[1][i] >= busy[1] * 0.3;
// the longest run of seconds, allowing short dips, in which both are sending: that is the match
let best = { from: 0, to: -1 }, cur = null, dip = 0;
for (let i = 0; i < secs; i++) {
  if (playing(i)) {
    if (!cur) cur = { from: i, to: i };
    cur.to = i;
    dip = 0;
  } else if (cur && ++dip > 4) {
    if (cur.to - cur.from > best.to - best.from) best = cur;
    cur = null;
    dip = 0;
  }
}
if (cur && cur.to - cur.from > best.to - best.from) best = cur;
const from = best.from * 1000, to = (best.to + 1) * 1000;

console.log(`record ${rec.head.room}: ${rec.entries.length} messages over ${(rec.head.durationMs / 1000).toFixed(0)} s, closed because ${rec.head.reason}`);
console.log(`the match itself: from ${best.from} s to ${best.to + 1} s (${best.to + 1 - best.from} s). Before that: loading and select screen. After it: ${(secs - best.to - 1)} s on the match-over screen.`);
console.log("");

const inWin = (t) => t >= from && t <= to;
const bySide = [[], []];
for (const e of game) if (inWin(e.at)) bySide[e.side].push(e.at);
const gaps = bySide.map((ts) => ts.slice(1).map((t, i) => ({ at: ts[i], len: t - ts[i] })));
for (const s of [0, 1]) {
  const g = gaps[s].map((x) => x.len).sort((a, b) => a - b);
  const total = bySide[s].length ? bySide[s][bySide[s].length - 1] - bySide[s][0] : 0;
  const over = (n) => g.filter((x) => x > n).length;
  console.log(`${names[s]}: ${bySide[s].length} messages in the match, ${total ? (bySide[s].length / (total / 1000)).toFixed(0) : 0}/s on average`);
  console.log(`  gap between messages:  typical ${pct(g, 50)} ms, 95th ${pct(g, 95)} ms, 99th ${pct(g, 99)} ms, worst ${g.length ? g[g.length - 1] : 0} ms`);
  console.log(`  stalls:                over 100 ms: ${over(100)}, over 250 ms: ${over(250)}, over 500 ms: ${over(500)}, over 1000 ms: ${over(1000)}`);
}
const stalls = gaps.map((g) => g.filter((x) => x.len > 250).map((x) => ({ from: x.at, to: x.at + x.len })));
const together = stalls[0].filter((a) => stalls[1].some((b) => a.from < b.to && b.from < a.to));
console.log("");
console.log(`stalls over 250 ms during the match: host ${stalls[0].length}, guest ${stalls[1].length}, at the same moment for both: ${together.length}`);
const fewer = Math.min(stalls[0].length, stalls[1].length);
if (stalls[0].length + stalls[1].length === 0) console.log("  -> no stall over 250 ms: the connection was steady");
else if (fewer > 0 && together.length / fewer >= 0.5) console.log("  -> most stalls hit both players together: the shared path (the server's own connection or the tunnel) is the likely cause");
else console.log("  -> stalls mostly hit one player at a time: that player's own connection is the likely cause");
const worst = stalls.flatMap((l, s) => l.map((x) => ({ side: names[s], at: x.from, len: x.to - x.from }))).sort((a, b) => b.len - a.len).slice(0, 8);
if (worst.length) {
  console.log("");
  console.log("longest stalls in the match:");
  for (const w of worst) console.log(`  ${w.side.padEnd(5)} at ${(w.at / 1000).toFixed(1).padStart(6)} s into the record, ${w.len} ms with nothing arriving`);
}
// how often the stream is thin in the match, second by second
const thin = [];
for (let i = best.from + 1; i < best.to; i++) for (const s of [0, 1]) if (perSec[s][i] < busy[s] * 0.6) thin.push(`${names[s]}@${i}s(${perSec[s][i]})`);
console.log("");
console.log(`seconds in the match with far fewer messages than usual (usual ${busy[0]}/s host, ${busy[1]}/s guest): ${thin.length ? thin.length + ": " + thin.slice(0, 20).join(", ") : "none"}`);
