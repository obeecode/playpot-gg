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

export interface JinxV2Params extends Omit<DeployParams, "referee" | "rakeBps"> {
  refereePk: Hex;
  token: Address;
  rakeFloors?: bigint[]; // pot sizes where each rate starts (default: the agreed beta tiers)
  rakeBpsTiers?: number[];
  minStake?: bigint;
  maxStake?: bigint;
  hardMaxStake?: bigint;
  bondFloor?: bigint; // collateral the referee needs before it can be assigned matches
  refereeBond?: bigint; // collateral to post right away (test tokens are minted to the referee first)
}

/** Deploys JinxEscrowV2 and, on a test token, posts the referee's collateral so matches can start. */
export async function deployJinxV2(p: JinxV2Params): Promise<Address> {
  const pub = createPublicClient({ transport: http(p.rpc) });
  const dep = createWalletClient({ account: privateKeyToAccount(p.deployerPk), transport: http(p.rpc) });
  const refAccount = privateKeyToAccount(p.refereePk);
  const j = artifact("JinxEscrowV2");
  const bondFloor = p.bondFloor ?? 500_000_000n;
  const config = {
    token: p.token,
    referee: refAccount.address,
    treasury: p.treasury,
    challengeWindow: BigInt(p.challengeWindow ?? 1800),
    matchDuration: BigInt(p.matchDuration ?? 7200),
    abortGrace: BigInt(p.abortGrace ?? 600),
    disputeBond: p.bond ?? 5_000_000n,
    minStake: p.minStake ?? 10_000_000n,
    maxStake: p.maxStake ?? 100_000_000n,
    hardMaxStake: p.hardMaxStake ?? 1_000_000_000n,
    refereeBondFloor: bondFloor,
  };
  const floors = p.rakeFloors ?? [0n, 500_000_000n, 1_000_000_000n, 10_000_000_000n];
  const tiers = p.rakeBpsTiers ?? [850, 700, 500, 300];
  const r = await pub.waitForTransactionReceipt({
    hash: await dep.deployContract({ chain: null, abi: j.abi as never, bytecode: j.bytecode, args: [config, floors, tiers] as never }),
  });
  const escrow = r.contractAddress!;

  const bond = p.refereeBond ?? bondFloor * 2n;
  if (bond > 0n) {
    const ref = createWalletClient({ account: refAccount, transport: http(p.rpc) });
    const t = artifact("TestToken");
    const send = async (hash: Promise<Hex>) => pub.waitForTransactionReceipt({ hash: await hash });
    await send(ref.writeContract({ chain: null, address: p.token, abi: t.abi as never, functionName: "mint", args: [refAccount.address, bond] } as never));
    await send(ref.writeContract({ chain: null, address: p.token, abi: t.abi as never, functionName: "approve", args: [escrow, bond] } as never));
    const v2 = artifact("JinxEscrowV2");
    await send(ref.writeContract({ chain: null, address: escrow, abi: v2.abi as never, functionName: "depositRefereeBond", args: [bond] } as never));
  }
  return escrow;
}
