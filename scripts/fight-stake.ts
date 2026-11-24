// Command line for staked Fight matches, until the lobby has the screens for it.
//   node scripts/fight-stake.ts offer <stake>          lock <stake> test tokens and open an offer (you are the host / player 1)
//   node scripts/fight-stake.ts challenge <id>         match the offer's stake and start the match (you are the guest / player 2)
//   node scripts/fight-stake.ts link <id>              print your signed link to the match's room; open it in a browser
//   node scripts/fight-stake.ts status <id>            what the chain says about the match
//   node scripts/fight-stake.ts concede <id>           give up an active match
//   node scripts/fight-stake.ts dispute <id>           dispute a proposed result (posts the dispute bond)
//   node scripts/fight-stake.ts claim                  withdraw what you are owed
//   node scripts/fight-stake.ts wallet                 make a new wallet (prints its address and private key; nothing is sent anywhere)
// Environment: RPC_URL, FIGHT_ESCROW, PLAYER_PK (your wallet's private key: keep it out of chats and logs), SERVER_URL (for example
// https://app.playpot.gg). Each match gets its own throwaway key, kept in .fight-keys.json next to where you run this (git ignores it);
// it signs your join to the room, so your wallet key never leaves this computer. (Keys are filed by match and wallet, so two
// players can even share one folder when testing alone.)
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, createWalletClient, http, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { fightEscrowAbi, testTokenAbi } from "../packages/game/src/index.ts";
import { joinMessage } from "../packages/server/src/fightLog.ts";
import { roomForMatch } from "../packages/server/src/fightSettle.ts";

const need = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`set ${k}`);
  return v;
};
const [cmd, arg] = process.argv.slice(2);
/** How to run this program again, for the hints it prints: the bundled file when that is what is running. */
const self = (process.argv[1] ?? "").endsWith(".mjs") ? "node fight-stake.mjs" : "node scripts/fight-stake.ts";
if (cmd === "wallet") {
  const key = generatePrivateKey();
  console.log(`address:     ${privateKeyToAccount(key).address}\nprivate key: ${key}\n\nKeep the private key to yourself. Send only the address to whoever is funding you.`);
  process.exit(0);
}
if (!["offer", "challenge", "link", "status", "concede", "dispute", "claim"].includes(cmd ?? "")) {
  console.log(`usage: ${self} wallet | offer <stake> | challenge <id> | link <id> | status <id> | concede <id> | dispute <id> | claim`);
  process.exit(2);
}
const rpc = process.env.RPC_URL ?? "https://sepolia.base.org";
const escrow = need("FIGHT_ESCROW") as Address;
const pub = createPublicClient({ transport: http(rpc) });
const KEYS = ".fight-keys.json";
const keys = (): Record<string, { key: Hex; role: "host" | "guest" }> => (existsSync(KEYS) ? JSON.parse(readFileSync(KEYS, "utf8")) : {});
const slot = (id: bigint) => `${id}:${me().address.toLowerCase()}`;
const me = () => privateKeyToAccount(need("PLAYER_PK") as Hex);
const wallet = () => createWalletClient({ account: me(), transport: http(rpc) });
const send = async (functionName: string, args: unknown[], abi: unknown = fightEscrowAbi, address: Address = escrow) => {
  const hash = await wallet().writeContract({ chain: null, address, abi: abi as never, functionName, args } as never);
  await pub.waitForTransactionReceipt({ hash });
  return hash;
};
const read = (functionName: string, args: unknown[] = []) => pub.readContract({ address: escrow, abi: fightEscrowAbi, functionName, args } as never) as Promise<never>;
const STATUS = ["none", "active", "proposed", "disputed", "settled"];
const OUTCOME = ["", "host wins", "guest wins", "void (refunded)"];

async function ensureApproval(amount: bigint) {
  const token = (await read("token")) as Address;
  const allowance = (await pub.readContract({ address: token, abi: testTokenAbi, functionName: "allowance", args: [me().address, escrow] } as never)) as bigint;
  if (allowance < amount) await send("approve", [escrow, 2n ** 256n - 1n], testTokenAbi, token);
}

if (cmd === "offer") {
  const stake = BigInt(Math.round(Number(arg) * 1_000_000));
  if (!stake) throw new Error("usage: offer <stake in tokens>");
  const key = generatePrivateKey();
  const id = (await read("nextId")) as bigint;
  await ensureApproval(stake);
  const expiry = BigInt(Math.floor(Date.now() / 1000) + 24 * 3600);
  await send("createOffer", [stake, expiry, privateKeyToAccount(key).address]);
  writeFileSync(KEYS, JSON.stringify({ ...keys(), [slot(id)]: { key, role: "host" } }, null, 2));
  console.log(`offer ${id} is open with ${arg} tokens locked. Tell your opponent to run:  ${self} challenge ${id}`);
} else if (cmd === "challenge") {
  const id = BigInt(arg ?? "");
  const offer = (await read("offers", [id])) as readonly [Address, Address, bigint, bigint, boolean];
  if (!offer[4]) throw new Error("that offer is not open");
  const key = generatePrivateKey();
  await ensureApproval(offer[2]);
  await send("challenge", [id, privateKeyToAccount(key).address]);
  writeFileSync(KEYS, JSON.stringify({ ...keys(), [slot(id)]: { key, role: "guest" } }, null, 2));
  console.log(`match ${id} has started. Open your link:  ${self} link ${id}`);
} else if (cmd === "link") {
  const id = BigInt(arg ?? "");
  const mine = keys()[slot(id)];
  if (!mine) throw new Error(`no key for match ${id} and this wallet in ${KEYS}: run this where you made the offer or challenge`);
  const room = roomForMatch(id);
  const sig = await privateKeyToAccount(mine.key).signMessage({ message: joinMessage(room, mine.role) });
  const base = (process.env.SERVER_URL ?? "http://localhost:8787").replace(/\/$/, "");
  console.log(`${base}/g/fight/?room=${room}${mine.role === "host" ? "&role=host" : ""}&sig=${sig}`);
  console.log(`(you are the ${mine.role}; both players press F once on the select screen when they are ready)`);
} else if (cmd === "status") {
  const id = BigInt(arg ?? "");
  const m = (await read("getMatch", [id])) as { status: number; outcome: number; p1: Address; p2: Address; stake: bigint; windowEnd: bigint; p1Score: number; p2Score: number };
  console.log(`match ${id}: ${STATUS[m.status]}, stake ${Number(m.stake) / 1e6} each, host ${m.p1}, guest ${m.p2}`);
  if (m.status === 2) console.log(`proposed: ${OUTCOME[m.outcome]} ${m.p1Score}-${m.p2Score}; the loser may dispute until ${new Date(Number(m.windowEnd) * 1000).toISOString()}, then anyone can finalize`);
  if (m.status === 3) console.log(`disputed: the arbiter rules until ${new Date(Number(m.windowEnd) * 1000).toISOString()}`);
} else if (cmd === "concede") {
  await send("concede", [BigInt(arg ?? "")]);
  console.log("conceded: your opponent wins");
} else if (cmd === "dispute") {
  const bond = (await read("disputeBond")) as bigint;
  await ensureApproval(bond);
  await send("dispute", [BigInt(arg ?? "")]);
  console.log("disputed: the funds are frozen until the arbiter rules");
} else if (cmd === "claim") {
  const owed = (await read("claimable", [me().address])) as bigint;
  if (owed === 0n) console.log("nothing to claim");
  else {
    await send("claim", []);
    console.log(`claimed ${Number(owed) / 1e6} tokens`);
  }
} else {
  console.log(`usage: ${self} wallet | offer <stake> | challenge <id> | link <id> | status <id> | concede <id> | dispute <id> | claim`);
  process.exit(2);
}
