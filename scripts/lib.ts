import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, createWalletClient, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

function artifact(name: string): { abi: unknown; bytecode: Hex } {
  const path = join("contracts", "out", `${name}.sol`, `${name}.json`);
  const j = JSON.parse(readFileSync(path, "utf8"));
  return { abi: j.abi, bytecode: j.bytecode.object as Hex };
}

export interface DeployParams {
  rpc: string;
  deployerPk: Hex;
  referee: Address;
  treasury: Address;
  rakeBps?: number;
  challengeWindow?: number;
  matchDuration?: number;
  abortGrace?: number;
  bond?: bigint;
}

/** Deploys TestToken + PotEscrow (needs `forge build` first). */
export async function deployContracts(p: DeployParams): Promise<{ token: Address; escrow: Address }> {
  const pub = createPublicClient({ transport: http(p.rpc) });
  const dep = createWalletClient({ account: privateKeyToAccount(p.deployerPk), transport: http(p.rpc) });
  const t = artifact("TestToken");
  const e = artifact("PotEscrow");
  const tr = await pub.waitForTransactionReceipt({
    hash: await dep.deployContract({ chain: null, abi: t.abi as never, bytecode: t.bytecode }),
  });
  const token = tr.contractAddress!;
  const er = await pub.waitForTransactionReceipt({
    hash: await dep.deployContract({
      chain: null,
      abi: e.abi as never,
      bytecode: e.bytecode,
      args: [
        token,
        p.referee,
        p.treasury,
        p.rakeBps ?? 300,
        p.challengeWindow ?? 1800,
        p.matchDuration ?? 3600,
        p.abortGrace ?? 600,
        p.bond ?? 5_000_000n,
      ] as never,
    }),
  });
  return { token, escrow: er.contractAddress! };
}

/** Deploys JinxEscrow against an existing token (needs `forge build` first). */
export async function deployJinx(
  p: DeployParams & { token: Address },
): Promise<Address> {
  const pub = createPublicClient({ transport: http(p.rpc) });
  const dep = createWalletClient({ account: privateKeyToAccount(p.deployerPk), transport: http(p.rpc) });
  const j = artifact("JinxEscrow");
  const r = await pub.waitForTransactionReceipt({
    hash: await dep.deployContract({
      chain: null,
      abi: j.abi as never,
      bytecode: j.bytecode,
      args: [
        p.token,
        p.referee,
        p.treasury,
        p.rakeBps ?? 300,
        p.challengeWindow ?? 1800,
        p.matchDuration ?? 7200,
        p.abortGrace ?? 600,
        p.bond ?? 5_000_000n,
      ] as never,
    }),
  });
  return r.contractAddress!;
}
