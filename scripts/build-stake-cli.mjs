// Bundles scripts/fight-stake.ts, with everything it needs, into one file: dist/fight-stake.mjs.
// A player who only wants to take part in staked matches needs Node 22 or newer and that one file: no clone, no npm install.
//   npm run build:stake-cli
import { build } from "esbuild";

await build({
  entryPoints: ["scripts/fight-stake.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: "dist/fight-stake.mjs",
  banner: { js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);' },
  logLevel: "info",
});
console.log("wrote dist/fight-stake.mjs: send that one file to the other player (Node 22+ is all they need)");
