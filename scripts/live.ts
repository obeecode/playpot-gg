// One command to play with a friend, shared through a free Cloudflare quick tunnel. Two modes:
//  - default: throwaway local chain + fresh contracts.   (cd contracts && forge build) && npm run live
//  - existing deployment (e.g. Base Sepolia): set ESCROW and REFEREE_PK, no local chain is started.
//      $env:ESCROW="0x..."; $env:REFEREE_PK="0x..."; npm run live
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createPublicClient, http, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { startServer } from "../packages/server/src/main.ts";
import { deployContracts, deployJinx } from "./lib.ts";

const PORT = Number(process.env.PORT ?? 8787);
const existing = Boolean(process.env.ESCROW && process.env.REFEREE_PK);

if (!existing && !existsSync("contracts/out/PotEscrow.sol/PotEscrow.json")) {
  console.error("Contracts are not built. Run:  cd contracts && forge build");
  process.exit(1);
}
console.log("Building the web client...");
const build = spawnSync("npm", ["run", "build:web"], { stdio: "inherit", shell: true });
if (build.status !== 0) process.exit(1);

const children: ChildProcess[] = [];
const stop = () => {
  children.forEach((c) => c.kill());
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

let server: Awaited<ReturnType<typeof startServer>>;
if (existing) {
  const rpc = process.env.RPC_URL ?? "https://sepolia.base.org";
  server = await startServer({
    rpcUrl: rpc,
    publicRpcUrl: process.env.PUBLIC_RPC_URL ?? rpc,
    escrow: process.env.ESCROW as Address,
    jinxEscrow: process.env.JINX_ESCROW as Address | undefined,
    refereePk: process.env.REFEREE_PK as Hex,
    port: PORT,
    dataDir: process.env.DATA_DIR ?? "data",
    resultWaitMs: Number(process.env.RESULT_WAIT_MS ?? 15000),
    webDir: "packages/web/dist",
  });
  console.log(`\nReferee ${server.referee} serving ${process.env.ESCROW} via ${rpc}`);
} else {
  const ANVIL_PORT = Number(process.env.ANVIL_PORT ?? 8545);
  const RPC = `http://127.0.0.1:${ANVIL_PORT}`;
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

  const { escrow, token } = await deployContracts({
    rpc: RPC,
    deployerPk,
    referee: referee.address,
    treasury,
    challengeWindow: Number(process.env.CHALLENGE_WINDOW ?? 1800),
  });
  const jinxEscrow = await deployJinx({
    rpc: RPC,
    deployerPk,
    referee: referee.address,
    treasury,
    token,
    challengeWindow: Number(process.env.CHALLENGE_WINDOW ?? 1800),
  });
  server = await startServer({
    rpcUrl: RPC,
    escrow,
    jinxEscrow,
    refereePk,
    port: PORT,
    dataDir: process.env.DATA_DIR ?? "data",
    resultWaitMs: Number(process.env.RESULT_WAIT_MS ?? 15000),
    webDir: "packages/web/dist",
    proxyRpc: true,
  });
}
console.log(`\nLocal: http://localhost:${server.port}${existing ? "" : "   (open ?burner=alice and ?burner=bob in two windows to test alone)"}`);

if (process.env.NO_TUNNEL === "1") {
  console.log(`\nNo tunnel started (NO_TUNNEL=1). Point your own tunnel at port ${server.port}, for example:  ngrok http ${server.port}`);
} else startTunnel(server.port);

function startTunnel(port: number) {
// TCP (http2) is more reliable than the default QUIC/UDP on many home networks, VPNs and antivirus setups.
// Set TUNNEL_PROTOCOL=quic to use QUIC instead.
// With TUNNEL_NAME (and TUNNEL_HOST) it runs a named Cloudflare tunnel on your own domain, so the link never changes.
const proto = process.env.TUNNEL_PROTOCOL ?? "http2";
const named = process.env.TUNNEL_NAME;
const namedHost = process.env.TUNNEL_HOST;
if (named && !namedHost) console.log("TUNNEL_NAME is set but TUNNEL_HOST is not (for example app.playpot.gg), so the link cannot be announced.");
const tunnelArgs = named
  ? ["tunnel", "--no-autoupdate", "--protocol", proto, "run", "--url", `http://localhost:${port}`, named]
  : ["tunnel", "--url", `http://localhost:${port}`, "--no-autoupdate", "--protocol", proto];
const tunnel = spawn("cloudflared", tunnelArgs, { stdio: ["ignore", "pipe", "pipe"] });
children.push(tunnel);
tunnel.on("error", () => {
  console.log(
    "\ncloudflared is not installed, so there is no public link yet.\n" +
      "  Windows:  winget install --id Cloudflare.cloudflared   (then open a NEW PowerShell and run this again)\n" +
      "  Mac:      brew install cloudflared\n" +
      "Until then you can still play on this computer at the Local address above.",
  );
});
const howTo = existing
  ? 'Open it yourself too. Use MetaMask (or "Use burner wallet"). Each player needs a little Base Sepolia ETH for gas:\ncopy the address shown in the Wallet box and request it from a Base Sepolia faucet. Then click "Mint 1000 test tokens".\nKeep this window open while you play. Ctrl+C to stop. Games and balances live on Base Sepolia and survive restarts.'
  : 'Open it yourself too. Each of you gets a burner wallet; use "Dev: 10 ETH" then "Mint 1000 test tokens".\nKeep this window open while you play. Ctrl+C to stop (the chain resets).';
let announced = false;
let url = named && namedHost ? `https://${namedHost}` : "";
const onData = (buf: Buffer) => {
  const text = buf.toString();
  const m = named ? null : text.match(/https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/);
  if (m && !url) url = m[0];
  // The URL is printed before the tunnel is up. Only announce it once cloudflared has really connected.
  if (url && !announced && /Registered tunnel connection/.test(text)) {
    announced = true;
    console.log(`\n=======================================================\n  ${named ? "Your permanent link:" : "Share this link with your friend:"}\n  ${url}\n=======================================================\n${howTo}`);
  }
};
const showProblems = (buf: Buffer) => {
  for (const line of buf.toString().split(/\r?\n/)) {
    if (/\b(ERR|WRN)\b/.test(line) && !/trycloudflare\.com\/?$/.test(line)) console.log(`[tunnel] ${line.replace(/^\S+\s+/, "").slice(0, 200)}`);
  }
};
for (const stream of [tunnel.stdout, tunnel.stderr]) {
  stream?.on("data", onData);
  stream?.on("data", showProblems);
}
tunnel.on("exit", (code) => console.log(`[tunnel] cloudflared exited (code ${code}). The public link no longer works; press Ctrl+C and run again.`));
}
