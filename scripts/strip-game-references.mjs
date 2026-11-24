// Removes the Steam and Counterpick Labs references from the fork's build (src/main.ws1.js by default).
//   node scripts/strip-game-references.mjs [path\to\main.ws1.js]    rewrite the build in place (default: $FIGHT_DIR/fork-core/src/main.ws1.js)
//   node scripts/strip-game-references.mjs --check               only report what is left (exit 1 if anything)
// Every edit must match exactly once, so a build that changed shape fails loudly instead of being half-stripped.
// The backend address becomes window.GAME_API_BASE / window.GAME_WS_BASE, which the host page sets (PlayPot's server does).
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const check = args.includes("--check");
const given = args.find((a) => !a.startsWith("--"));
if (!given && !process.env.FIGHT_DIR) throw new Error("give the path to main.ws1.js, or set FIGHT_DIR to your gameplay-core folder");
const file = path.resolve(given ?? path.join(process.env.FIGHT_DIR , "fork-core", "src", "main.ws1.js"));
let s = fs.readFileSync(file, "utf8");

// "steam" only counts at the start of a word, so names like changesTeamOnReflect are not flagged
const LEFTOVER = /(?<![a-z])steam|counterpick|discord\.gg|utm_source|cplbrowser|cpl-swaps/gi;
const report = () => {
  const hits = [];
  s.split("\n").forEach((line, i) => {
    const m = line.match(LEFTOVER);
    if (m) hits.push(`${i + 1}: ${[...new Set(m.map((x) => x.toLowerCase()))].join(", ")}`);
  });
  return hits;
};
if (check) {
  const hits = report();
  console.log(hits.length ? "left:\n" + hits.join("\n") : "no Steam or Counterpick references left");
  process.exit(hits.length ? 1 : 0);
}

const edits = [];
const once = (what, from, to) => {
  const n = typeof from === "string" ? s.split(from).length - 1 : (s.match(from) ?? []).length;
  if (n !== 1) throw new Error(`${what}: expected 1 match, found ${n}`);
  s = typeof from === "string" ? s.replace(from, () => to) : s.replace(from, () => to);
  edits.push(what);
};
const all = (what, from, to, expected) => {
  const n = s.split(from).length - 1;
  if (n !== expected) throw new Error(`${what}: expected ${expected} matches, found ${n}`);
  s = s.split(from).join(to);
  edits.push(`${what} (x${n})`);
};

// backend address: set by the host page instead of pointing at the original service
once("api base", 'return "https://be.counterpicklabs.com" + fVW;', 'return (window.GAME_API_BASE || "") + fVW;');
once("presence socket", '"wss://be.counterpicklabs.com/wds/gen?p="', '(window.GAME_WS_BASE || "") + "/wds/gen?p="');
once("source map comment", /\n?\}\)\(\); \/\/# sourceURL=https:\/\/www\.counterpicklabs\.com\/[^\n]*/, "\n})();");

// Steam sign-in, achievements and ticket calls: the platform API does not exist in this build
once("steam login path", '"/steam_login_register_full"', '"/external_login"');
once("steam purchase path", '"/redeem_steam_purchase"', '"/redeem_purchase"');
once("steam input setting key", '"suppress_steam_input_modal"', '"suppress_input_modal"');
all("steamAPI variable", "steamAPI", "platformAPI", 6);
once("platform API handle", "let platformAPI = window.platformAPI;", "let platformAPI = null; // no platform API in this build");
once("platform ticket", "window.platformAPI.getSteamNameAndTicket()", 'Promise.reject(new Error("external sign-in is not available"))');
once("sign-in toast (electron)", 'IS_ELECTRON ? "signed in via steam" : "signed in."', '"signed in."');
once("sign-in toast", '"signed in via steam"', '"signed in."');
once("sign-in failure toast", '"steam sign-in failed, entering offline mode."', '"sign-in failed, entering offline mode."');

// Player-facing text that names the store, the old brand or its community
once("update notice", /fVd\.innerHTML = fVa \? "[^\n]*? : "[^\n]*?";/, 'fVd.innerHTML = "Your client\'s version is outdated! Please refresh your page to load the new patch before playing online.";');
once("controller help", /fVF\.innerHTML = "\\n    <p>If your controller inputs are being read[^\n]*";/, 'fVF.innerHTML = "<p>If your controller inputs are being read as mouse + keyboard inputs, close other programs that remap controllers and reconnect it.</p>";');
once("loading tip", /document\.getElementById\("steam-prompt"\)\.innerHTML = "[^\n]*";/, "/* no store tip in this build */");
once("skin label", '"cpl-swaps"', '"swaps"');

fs.writeFileSync(file, s);
console.log(edits.map((e) => "stripped: " + e).join("\n"));
const left = report();
console.log(left.length ? "still present:\n" + left.join("\n") : "no Steam or Counterpick references left");
