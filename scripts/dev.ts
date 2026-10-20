// Local playground: anvil + deployed contracts + referee server. Then run `npm run web` in another shell.
// Usage: (cd contracts && forge build) && node scripts/dev.ts
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createPublicClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { startServer } from "../packages/server/src/main.ts";
import { deployContracts } from "./lib.ts";

const PORT = Number(process.env.ANVIL_PORT ?? 8545);
const RPC = `http://127.0.0.1:${PORT}`;
const DEPLOYER = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;
const REFEREE = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;
const TREASURY = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

const anvil = spawn(process.env.ANVIL ?? "anvil", ["--port", String(PORT), "--silent"], { stdio: "inherit" });
const pub = createPublicClient({ transport: http(RPC) });
for (let i = 0; ; i++) {
  try {
    await pub.getChainId();
    break;
  } catch {
    if (i > 50) throw new Error("anvil did not start");
    await new Promise((r) => setTimeout(r, 100));
  }
}

const { token, escrow } = await deployContracts({
  rpc: RPC,
  deployerPk: DEPLOYER,
  referee: privateKeyToAccount(REFEREE).address,
  treasury: TREASURY,
  challengeWindow: Number(process.env.CHALLENGE_WINDOW ?? 1800),
});
mkdirSync("deployments", { recursive: true });
writeFileSync("deployments/local.json", JSON.stringify({ chainId: 31337, token, escrow }, null, 2));

const server = await startServer({
  rpcUrl: RPC,
  escrow,
  refereePk: REFEREE,
  port: Number(process.env.PORT ?? 8787),
  dataDir: process.env.DATA_DIR ?? "data",
  resultWaitMs: Number(process.env.RESULT_WAIT_MS ?? 15000),
});
console.log(`anvil ${RPC}\ntoken  ${token}\nescrow ${escrow}\nreferee server http://127.0.0.1:${server.port}`);
console.log("Now run `npm run web` and open the printed Vite URL. Ctrl+C to stop.");

const stop = () => {
  anvil.kill();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
