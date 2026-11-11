// Checks that a live site serves exactly the build you expect.
//   node scripts/verify-site.ts https://app.playpot.gg                 compare against your own local build
//   node scripts/verify-site.ts https://app.playpot.gg --expect <hash>  compare against a published hash
// Local build: npm ci && npm run build:web   (prints the hash)
import { existsSync, readFileSync } from "node:fs";
import { rootOf, sha256, type Manifest } from "./dist-hash.ts";

export interface Verdict {
  ok: boolean;
  root: string;
  errors: string[];
}

const get = async (url: string): Promise<Uint8Array> => {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
};

export async function verifySite(base: string, expectedRoot?: string): Promise<Verdict> {
  const errors: string[] = [];
  const url = base.replace(/\/$/, "");
  let manifest: Manifest;
  try {
    manifest = JSON.parse(new TextDecoder().decode(await get(`${url}/manifest.json`)));
  } catch (e) {
    return { ok: false, root: "", errors: [`cannot read manifest.json: ${(e as Error).message}`] };
  }

  // Re-hash every file as actually served, instead of trusting the manifest's own numbers.
  const served: Record<string, string> = {};
  for (const [path, claimed] of Object.entries(manifest.files)) {
    try {
      served[path] = sha256(await get(`${url}/${path}`));
      if (served[path] !== claimed) errors.push(`${path}: served bytes differ from the manifest`);
    } catch (e) {
      errors.push((e as Error).message);
    }
  }
  const root = rootOf(served);
  if (root !== manifest.root) errors.push("manifest root does not match the files served");

  // The page the browser actually loads at "/" must be the hashed index.html, with no extra or external code.
  try {
    const page = await get(`${url}/`);
    if (sha256(page) !== manifest.files["index.html"]) errors.push("the page served at / is not the hashed index.html");
    const html = new TextDecoder().decode(page);
    for (const m of html.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/g)) {
      const ref = m[1];
      if (/^(?:[a-z]+:)?\/\//i.test(ref)) errors.push(`index.html loads external resource ${ref}`);
      else if (!manifest.files[ref.replace(/^\//, "").split(/[?#]/)[0]]) errors.push(`index.html references unlisted file ${ref}`);
    }
    if (/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/i.test(html)) errors.push("index.html contains inline script");
  } catch (e) {
    errors.push((e as Error).message);
  }

  if (expectedRoot && root !== expectedRoot) errors.push(`site hash ${root} != expected ${expectedRoot}`);
  return { ok: errors.length === 0, root, errors };
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  const args = process.argv.slice(2);
  const site = args.find((a) => !a.startsWith("--"));
  const i = args.indexOf("--expect");
  let expected = i >= 0 ? args[i + 1] : undefined;
  if (!site) {
    console.error("usage: node scripts/verify-site.ts <url> [--expect <hash>]");
    process.exit(2);
  }
  if (!expected) {
    const local = "packages/web/dist/manifest.json";
    if (!existsSync(local)) {
      console.error("No --expect given and no local build. Run `npm ci && npm run build:web` or pass --expect <hash>.");
      process.exit(2);
    }
    expected = (JSON.parse(readFileSync(local, "utf8")) as Manifest).root;
    console.log(`expected (your local build): ${expected}`);
  }
  const v = await verifySite(site, expected);
  console.log(`served site hash:            ${v.root}`);
  if (v.ok) console.log("PASS: the live site is exactly the expected build.");
  else {
    console.log("FAIL:");
    v.errors.forEach((e) => console.log(`  - ${e}`));
    process.exit(1);
  }
}
