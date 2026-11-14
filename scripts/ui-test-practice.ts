// Drives the practice mode (JINX against the bot) in headless Chromium, on a desktop and a phone-sized screen.
// It needs no chain: a tiny static server stands in for the referee. Usage: node scripts/ui-test-practice.ts
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { chromium, type Page } from "playwright-core";

const SHOTS = process.env.SHOTS_DIR ?? join(tmpdir(), "playpot-shots");
mkdirSync(SHOTS, { recursive: true });
const built = spawnSync("npm", ["run", "build:web"], { stdio: "ignore", shell: true });
if (built.status !== 0) throw new Error("web build failed");

const DIST = "packages/web/dist";
const types: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
const server = createServer((req, res) => {
  const path = (req.url ?? "/").split("?")[0];
  if (path === "/config") {
    res.setHeader("content-type", "application/json");
    return void res.end(JSON.stringify({ chainId: 84532, escrow: "0x558f479c8de7019AA26893e743e4e9FF3F989FfD", token: "0x43aD88593cFE37567Aa6385812260446168E2eb7", referee: "0xC3Abd6eD23D0b57dCBB0fA0C6F4f45eD745d2DB5", rpcUrl: "http://127.0.0.1:9/", jinx: { escrow: "0x3cF2006B19758b9c5143Eb71022E7D7cD48c70F4", token: "0x43aD88593cFE37567Aa6385812260446168E2eb7" } }));
  }
  const file = join(DIST, path === "/" ? "index.html" : path);
  if (!path.startsWith("/assets/") && path !== "/") {
    res.statusCode = 404;
    return void res.end("no");
  }
  if (!existsSync(file)) {
    res.statusCode = 404;
    return void res.end("no");
  }
  res.setHeader("content-type", types[extname(file)] ?? "application/octet-stream");
  res.end(readFileSync(file));
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as { port: number }).port;
const url = `http://127.0.0.1:${port}`;

let code = 0;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--no-sandbox"] });
const check = (cond: unknown, what: string) => {
  if (!cond) throw new Error(`FAILED: ${what}`);
  console.log(`ok: ${what}`);
};

async function playMatch(page: Page, label: string) {
  const status = () => page.locator("#jstatus").innerText().catch(() => "");
  for (let i = 0; i < 4000; i++) {
    if (await page.locator("#pagain").count()) break;
    const cell = page.locator('button.jcell[data-act="ptap"]:not([disabled])').first();
    if (await cell.count()) await cell.click({ timeout: 1000 }).catch(() => {});
    await page.waitForTimeout(25);
  }
  const text = await status();
  check(/wins? the match|abandoned/i.test(text), `${label}: the match ended (${text.split("\n")[0]})`);
}

try {
  for (const [name, viewport] of [["desktop", { width: 1000, height: 900 }], ["phone", { width: 390, height: 844 }]] as const) {
    const ctx = await browser.newContext({ viewport, hasTouch: name === "phone", isMobile: name === "phone" });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => console.log(`[${name} pageerror]`, e.message));
    await page.goto(`${url}/?burner=${name}&pfast=1`);
    await page.waitForSelector("#practice");
    check(await page.locator("#start").count(), `${name}: the get-started checklist shows for a new wallet`);
    await page.screenshot({ path: join(SHOTS, `practice-${name}-lobby.png`) });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check(overflow <= 0, `${name}: the lobby does not scroll sideways (${overflow}px)`);

    await page.click("#practice");
    await page.waitForSelector("#jboard");
    check((await page.locator(".jcell").count()) === 25, `${name}: the 5x5 board shows`);
    await page.screenshot({ path: join(SHOTS, `practice-${name}-start.png`) });
    const first = page.locator('button.jcell[data-act="ptap"]:not([disabled])').first();
    await first.click();
    check(await page.locator("#jlock-a.on").count(), `${name}: my lock-in shows`);
    await page.waitForSelector(".jcell.pop", { timeout: 5000 });
    check(true, `${name}: squares animate in after the reveal`);
    const over2 = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check(over2 <= 0, `${name}: the game screen does not scroll sideways (${over2}px)`);
    await page.screenshot({ path: join(SHOTS, `practice-${name}-play.png`) });
    await playMatch(page, name);
    await page.screenshot({ path: join(SHOTS, `practice-${name}-end.png`) });
    await page.click("#pagain");
    await page.waitForSelector("#jboard");
    check((await page.locator(".jcell.a, .jcell.b").count()) === 0, `${name}: play again starts a clean board`);
    await page.click("#pleave");
    await page.waitForSelector("#practice");
    check(true, `${name}: leaving returns to the lobby`);
    await ctx.close();
  }
  console.log("practice ui test passed");
} catch (e) {
  console.error((e as Error).message);
  code = 1;
} finally {
  await browser.close();
  server.close();
}
process.exit(code);
