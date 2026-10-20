import {
  createPublicClient,
  createWalletClient,
  http,
  type Address,
  type Hex,
  type LocalAccount,
  type PublicClient,
  type WalletClient,
} from "viem";
import { potEscrowAbi } from "@playpot/game";

export interface OnChainMatch {
  p1: Address;
  p2: Address;
  key1: Address;
  key2: Address;
  referee: Address;
  stake: bigint;
  status: number; // 0 none, 1 active, 2 proposed, 3 disputed, 4 settled
}

export class Chain {
  readonly pub: PublicClient;
  readonly wallet: WalletClient;
  readonly escrow: Address;
  readonly relayer: LocalAccount;
  chainId = 0;

  constructor(rpcUrl: string, escrow: Address, relayer: LocalAccount) {
    this.pub = createPublicClient({ transport: http(rpcUrl) });
    this.wallet = createWalletClient({ transport: http(rpcUrl), account: relayer });
    this.escrow = escrow;
    this.relayer = relayer;
  }

  async init() {
    this.chainId = await this.pub.getChainId();
  }

  async getMatch(id: bigint): Promise<OnChainMatch> {
    const m = await this.pub.readContract({ address: this.escrow, abi: potEscrowAbi, functionName: "getMatch", args: [id] });
    return { p1: m.p1, p2: m.p2, key1: m.key1, key2: m.key2, referee: m.referee, stake: m.stake, status: m.status };
  }

  async token(): Promise<Address> {
    return this.pub.readContract({ address: this.escrow, abi: potEscrowAbi, functionName: "token" });
  }

  async settle(id: bigint, result: number, finalHash: Hex, sig1: Hex | undefined, sig2: Hex | undefined, sigRef: Hex) {
    const hash = await this.wallet.writeContract({
      chain: null,
      account: this.relayer,
      address: this.escrow,
      abi: potEscrowAbi,
      functionName: "settle",
      args: [id, result, finalHash, sig1 ?? "0x", sig2 ?? "0x", sigRef],
    });
    await this.pub.waitForTransactionReceipt({ hash });
    return hash;
  }
}
