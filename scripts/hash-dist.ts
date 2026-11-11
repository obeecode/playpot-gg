// Writes <dist>/manifest.json: the sha256 of every built file plus one root hash for the whole site.
// Usage: node scripts/hash-dist.ts packages/web/dist
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { rootOf, sha256, type Manifest } from "./dist-hash.ts";

const dist = process.argv[2];
if (!dist) {
  console.error("usage: node scripts/hash-dist.ts <dist dir>");
  process.exit(1);
}

const files: Record<string, string> = {};
const walk = (dir: string) => {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full);
    else {
      const rel = relative(dist, full).split(sep).join("/");
      if (rel !== "manifest.json") files[rel] = sha256(readFileSync(full));
    }
  }
};
walk(dist);

const manifest: Manifest = { root: rootOf(files), files };
writeFileSync(join(dist, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`site hash ${manifest.root}  (${Object.keys(files).length} files)`);
