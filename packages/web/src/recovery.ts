// Wallet recovery. A smart wallet can have several owners. A wallet made with a passkey gets an email key as a second
// owner, and a wallet made with an email gets a passkey as a second owner, so losing either one does not lose the wallet.
// The app will not let a wallet stake until it has a second owner.
import { pad, parseAbi, type Address, type Hex, type PublicClient } from "viem";
import { call, type Call } from "./wallet.ts";

/** Which wallet an owner signs for, and its place in that wallet's owner list. */
export interface WalletRef {
  address: Address;
  ownerIndex: number;
}

export const walletAbi = parseAbi([
  "function addOwnerAddress(address owner)",
  "function addOwnerPublicKey(bytes32 x, bytes32 y)",
  "function ownerCount() view returns (uint256)",
  "function nextOwnerIndex() view returns (uint256)",
  "function ownerAtIndex(uint256 index) view returns (bytes)",
]);

export const MIN_OWNERS = 2;

export interface OwnerState {
  deployed: boolean; // a wallet only exists on-chain after its first operation
  count: number;
  next: number; // the index the next added owner will get
}

/** Reads how many owners a wallet has. A wallet that is not deployed yet counts as having none. */
export async function readOwners(pub: PublicClient, wallet: Address): Promise<OwnerState> {
  const none: OwnerState = { deployed: false, count: 0, next: 0 };
  try {
    const code = await pub.getCode({ address: wallet });
    if (!code || code === "0x") return none;
    const [count, next] = await Promise.all([
      pub.readContract({ address: wallet, abi: walletAbi, functionName: "ownerCount" }),
      pub.readContract({ address: wallet, abi: walletAbi, functionName: "nextOwnerIndex" }),
    ]);
    return { deployed: true, count: Number(count), next: Number(next) };
  } catch {
    return none;
  }
}

export const isProtected = (s: OwnerState): boolean => s.deployed && s.count >= MIN_OWNERS;

/** How the wallet stores an owner: a 32-byte padded address, or the 64-byte passkey public key. */
export const ownerBytesOfAddress = (a: Address): Hex => pad(a, { size: 32 });
export const ownerBytesOfPasskey = (publicKey: Hex): Hex => publicKey;

/** Is this owner really at that place in the wallet's owner list? Used to check what a directory or a saved record claims. */
export async function isOwnerAt(pub: PublicClient, ref: WalletRef, ownerBytes: Hex): Promise<boolean> {
  try {
    const at = await pub.readContract({ address: ref.address, abi: walletAbi, functionName: "ownerAtIndex", args: [BigInt(ref.ownerIndex)] });
    return at.toLowerCase() === ownerBytes.toLowerCase();
  } catch {
    return false;
  }
}

export const addOwnerAddressCall = (wallet: Address, owner: Address): Call => call(wallet, walletAbi, "addOwnerAddress", [owner]);
export const addOwnerPublicKeyCall = (wallet: Address, publicKey: Hex): Call =>
  call(wallet, walletAbi, "addOwnerPublicKey", [`0x${publicKey.slice(2, 66)}` as Hex, `0x${publicKey.slice(66)}` as Hex]);
