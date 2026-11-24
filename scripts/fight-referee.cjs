// Replays a recorded Fight match headless and prints who won. See scripts/lib/fight-referee.cjs for how.
//   FIGHT_DIR=<gameplay-core> FIGHT_REF=<counterpick-ref> node scripts/fight-referee.cjs <record.json> [--out result.json]
// Exit code 0: the match finished and every reported state hash matched. 1: unfinished or a mismatch. 3: the referee itself failed.
if (!process.env.FIGHT_DIR || !process.env.FIGHT_REF) { console.log("skipped: set FIGHT_DIR and FIGHT_REF"); process.exit(0); }
const fs = require("fs");
const { replayRecord } = require("./lib/fight-referee.cjs");
const file = process.argv[2];
const outAt = process.argv.indexOf("--out");
const outFile = outAt > 0 ? process.argv[outAt + 1] : undefined;
if (!file) { console.error("usage: node scripts/fight-referee.cjs <record.json>"); process.exit(2); }
process.env.FIGHT_QUIET = "1";
const record = JSON.parse(fs.readFileSync(file, "utf8"));
replayRecord(record).then((r) => { if (outFile) fs.writeFileSync(outFile, JSON.stringify(r)); console.log(JSON.stringify(r, null, 2)); process.exit(r.finished && !r.desync ? 0 : 1); }, (e) => { console.error("referee failed:", e && e.stack || e); process.exit(3); });
