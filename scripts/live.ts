// One command to play with a friend: local chain + contracts + referee serving the site, shared via a free
// Cloudflare quick tunnel. Usage: (cd contracts && forge build) && npm run live
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createPublicClient, http } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { startServer } from "../packages/server/src/main.ts";
import { deployContracts } from "./lib.ts";

const ANVIL_PORT = Number(process.env.ANVIL_PORT ?? 8545);
const PORT = Number(process.env.PORT ?? 8787);
const RPC = `http://127.0.0.1:${ANVIL_PORT}`;

if (!existsSync("contracts/out/PotEscrow.sol/PotEscrow.json")) {
  console.error("Contracts are not built. Run:  cd contracts && forge build");
  process.exit(1);
}
console.log("Building the web client...");
const build = spawnSync("npm", ["run", "build", "-w", "@playpot/web"], { stdio: "inherit", shell: true });
if (build.status !== 0) process.exit(1);

const children: ChildProcess[] = [];
const stop = () => {
  children.forEach((c) => c.kill());
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

const anvil = spawn(process.env.ANVIL ?? "anvil", ["--port", String(ANVIL_PORT), "--silent"], { stdio: "inherit" });
children.push(anvil);
anvil.on("error", () => {
  console.error("Could not start anvil. Is Foundry on your PATH?  (Windows: $env:Path += \";C:\\foundry\")");
  process.exit(1);
});
const pub = createPublicClient({ transport: http(RPC) });
for (let i = 0; ; i++) {
  try {
    await pub.getChainId();
    break;
  } catch {
    if (i > 100) throw new Error("anvil did not start");
    await new Promise((r) => setTimeout(r, 100));
  }
}

// Fresh random keys: anvil's built-in dev keys are public, so they must not run a shared game.
const deployerPk = generatePrivateKey();
const refereePk = generatePrivateKey();
const treasury = privateKeyToAccount(generatePrivateKey()).address;
const referee = privateKeyToAccount(refereePk);
for (const addr of [privateKeyToAccount(deployerPk).address, referee.address]) {
  await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "anvil_setBalance", params: [addr, "0x56BC75E2D63100000"] }),
  });
}

const { escrow } = await deployContracts({
  rpc: RPC,
  deployerPk,
  referee: referee.address,
  treasury,
  challengeWindow: Number(process.env.CHALLENGE_WINDOW ?? 1800),
});
const server = await startServer({
  rpcUrl: RPC,
  escrow,
  refereePk,
  port: PORT,
  dataDir: process.env.DATA_DIR ?? "data",
  resultWaitMs: Number(process.env.RESULT_WAIT_MS ?? 15000),
  webDir: "packages/web/dist",
  proxyRpc: true,
});
console.log(`\nLocal: http://localhost:${server.port}   (open ?burner=alice and ?burner=bob in two windows to test alone)`);

const tunnel = spawn("cloudflared", ["tunnel", "--url", `http://localhost:${server.port}`, "--no-autoupdate"], {
  stdio: ["ignore", "pipe", "pipe"],
});
children.push(tunnel);
tunnel.on("error", () => {
  console.log(
    "\ncloudflared is not installed, so there is no public link yet.\n" +
      "  Windows:  winget install --id Cloudflare.cloudflared   (then open a NEW PowerShell and run this again)\n" +
      "  Mac:      brew install cloudflared\n" +
      "Until then you can still play on this computer at the Local address above.",
  );
});
let announced = false;
const onData = (buf: Buffer) => {
  const m = buf.toString().match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
  if (m && !announced) {
    announced = true;
    console.log(`\n=======================================================\n  Share this link with your friend:\n  ${m[0]}\n=======================================================\nOpen it yourself too. Each of you gets a burner wallet; use "Dev: 10 ETH" then "Mint 1000 test tokens".\nKeep this window open while you play. Ctrl+C to stop (the chain resets).`);
  }
};
tunnel.stdout?.on("data", onData);
tunnel.stderr?.on("data", onData);
