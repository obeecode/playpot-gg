// Makes the Fight game's simulation give identical results in every browser (and in the referee's Node) by replacing the Math
// functions that engines may compute differently (sin, cos, atan2, pow, exp, log, hypot) with fixed implementations built only from
// operations every engine computes identically (scripts/lib/deterministic-math.src.js).
//   node scripts/harden-game-math.mjs [path\to\main.ws1.js]     rewrite the build in place (default: $FIGHT_DIR/fork-core/src/main.ws1.js)
//   node scripts/harden-game-math.mjs --check [path]             only report what is left (exit 1 if a risky Math function is still used)
// Safe to run twice. Fails loudly if the build uses a risky function that has no replacement yet.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const check = args.includes("--check");
const given = args.find((a) => !a.startsWith("--"));
if (!given && !process.env.FIGHT_DIR) throw new Error("give the path to main.ws1.js, or set FIGHT_DIR to your gameplay-core folder");
const file = path.resolve(given ?? path.join(process.env.FIGHT_DIR, "fork-core", "src", "main.ws1.js"));
let s = fs.readFileSync(file, "utf8");

const REPLACED = ["sin", "cos", "atan2", "pow", "exp", "log", "hypot"];
// engines may differ on all of these; a build that uses one we have no replacement for must not slip through
const UNSUPPORTED = ["tan", "atan", "asin", "acos", "sinh", "cosh", "tanh", "asinh", "acosh", "atanh", "cbrt", "log2", "log10", "log1p", "expm1"];
const count = (names) => names.map((n) => [n, (s.match(new RegExp(`Math\\.${n}\\(`, "g")) ?? []).length]).filter(([, c]) => c > 0);

const unsupported = count(UNSUPPORTED);
const remaining = count(REPLACED);
const hardened = s.includes("const __DM =");
if (check) {
  console.log(hardened ? "the build carries the deterministic math" : "the build does not carry the deterministic math");
  console.log(remaining.length ? `still calling the engine's math: ${remaining.map(([n, c]) => `${n} x${c}`).join(", ")}` : "no call to the engine's sin, cos, atan2, pow, exp, log or hypot");
  console.log(unsupported.length ? `calls with no replacement yet: ${unsupported.map(([n, c]) => `${n} x${c}`).join(", ")}` : "no call to a risky function without a replacement");
  process.exit(remaining.length || unsupported.length || !hardened ? 1 : 0);
}
if (unsupported.length) throw new Error(`the build calls Math functions that have no deterministic replacement yet: ${unsupported.map(([n, c]) => `${n} x${c}`).join(", ")}`);

const edits = [];
if (!hardened) {
  const marker = "'use strict';";
  const at = s.indexOf(marker);
  if (at < 0 || at > 400) throw new Error("could not find the start of the game's script");
  const src = fs.readFileSync(path.join(here, "lib", "deterministic-math.src.js"), "utf8").trim();
  const insert = `\n  // deterministic math (scripts/harden-game-math.mjs): the same results in every browser and in the referee\n  const __DM = ${src};\n  if (typeof window !== "undefined") window.__DM = __DM;\n`;
  s = s.slice(0, at + marker.length) + insert + s.slice(at + marker.length);
  edits.push("added the deterministic math");
}
for (const [name, c] of count(REPLACED)) {
  s = s.replace(new RegExp(`Math\\.${name}\\(`, "g"), `__DM.${name}(`);
  edits.push(`Math.${name} -> __DM.${name} (x${c})`);
}
if (edits.length === 0) console.log("nothing to do: the build is already hardened");
else fs.writeFileSync(file, s);
console.log(edits.map((e) => "  " + e).join("\n"));
const left = count([...REPLACED, ...UNSUPPORTED]);
if (left.length) throw new Error(`still calling the engine's math: ${left.map(([n, c]) => `${n} x${c}`).join(", ")}`);
console.log("done: no call to the engine's sin, cos, atan2, pow, exp, log or hypot is left");
