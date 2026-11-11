import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifySite } from "./verify-site.ts";

function makeSite(): string {
  const dir = mkdtempSync(join(tmpdir(), "playpot-site-"));
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "index.html"), '<!doctype html><html><body><div id="app"></div><script type="module" src="/assets/app.js"></script></body></html>');
  writeFileSync(join(dir, "assets", "app.js"), "console.log('game');");
  execFileSync("node", ["scripts/hash-dist.ts", dir], { stdio: "ignore" });
  return dir;
}

// Serves a directory, with optional overrides to simulate a tampered host.
function serve(dir: string, overrides: Record<string, string> = {}): Promise<{ url: string; srv: Server }> {
  const srv = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    const key = path === "/" ? "index.html" : path.slice(1);
    try {
      res.end(overrides[key] ?? readFileSync(join(dir, key)));
    } catch {
      res.writeHead(404).end();
    }
  });
  return new Promise((ok) => srv.listen(0, "127.0.0.1", () => ok({ url: `http://127.0.0.1:${(srv.address() as { port: number }).port}`, srv })));
}

test("an untouched site verifies and matches the expected hash", async () => {
  const dir = makeSite();
  const root = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")).root;
  const { url, srv } = await serve(dir);
  const v = await verifySite(url, root);
  srv.close();
  assert.deepEqual(v.errors, []);
  assert.equal(v.root, root);
});

test("a modified script is detected", async () => {
  const dir = makeSite();
  const { url, srv } = await serve(dir, { "assets/app.js": "steal(keys);" });
  const v = await verifySite(url);
  srv.close();
  assert.equal(v.ok, false);
  assert.match(v.errors.join(), /app\.js: served bytes differ/);
});

test("an injected external or inline script in the page is detected", async () => {
  const dir = makeSite();
  const evil = '<!doctype html><html><body><script src="https://evil.example/x.js"></script><script>alert(1)</script></body></html>';
  const { url, srv } = await serve(dir, { "index.html": evil });
  const v = await verifySite(url);
  srv.close();
  assert.equal(v.ok, false);
  assert.match(v.errors.join(), /not the hashed index\.html/);
  assert.match(v.errors.join(), /external resource/);
  assert.match(v.errors.join(), /inline script/);
});

test("a different build is rejected against the expected hash", async () => {
  const dir = makeSite();
  const { url, srv } = await serve(dir);
  const v = await verifySite(url, "0".repeat(64));
  srv.close();
  assert.equal(v.ok, false);
  assert.match(v.errors.join(), /!= expected/);
});
