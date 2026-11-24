// Checks a Fight match record: the hash chain, the head, and the referee's signature.
//   node scripts/fight-verify-log.ts <record.json> [refereeAddress]
import { readFileSync } from "node:fs";
import type { Address } from "viem";
import { verifyFightLog, type FightLogFile } from "../packages/server/src/fightLog.ts";

const [file, referee] = process.argv.slice(2);
if (!file) {
  console.error("usage: node scripts/fight-verify-log.ts <record.json> [refereeAddress]");
  process.exit(2);
}
const rec = JSON.parse(readFileSync(file, "utf8")) as FightLogFile;
const v = await verifyFightLog(rec, referee as Address | undefined);
const secs = Math.round(rec.head.durationMs / 1000);
console.log(`record ${rec.head.room}: ${rec.head.count} messages over ${secs} s, closed because ${rec.head.reason}`);
console.log(`players: host ${rec.head.host ?? "(not signed in)"}, guest ${rec.head.guest ?? "(not signed in)"}`);
console.log(`signed by ${rec.signer}${referee ? "" : " (pass the referee's address to insist on it)"}`);
if (v.ok) console.log("VALID: the chain, the head and the signature all check out");
else {
  console.log("INVALID:\n  " + v.errors.slice(0, 5).join("\n  "));
  process.exit(1);
}
