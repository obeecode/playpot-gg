// Self-hosted passkey wallets. The passkey is created and used on this page (the browser's own WebAuthn), the wallet is the
// open-source Coinbase Smart Wallet contract with the passkey as its owner, and every transaction is an ERC-4337 operation
// sent through this site's own /bundler and /paymaster. No third-party sign-in page, so nothing outside app.playpot.gg has
// to be reachable from the player's network.
import { createBundlerClient, createPaymasterClient, createWebAuthnCredential, toCoinbaseSmartAccount, toWebAuthnAccount } from "viem/account-abstraction";
import { http, toHex, type Address, type Hex, type PublicClient } from "viem";
import { WebAuthnP256 } from "ox";
import type { BatchLog, Eip1193 } from "./wallet.ts";

export interface PasskeyRecord {
  id: string;
  publicKey: Hex; // P-256 public key, x then y (64 bytes)
}

const STORE = "playpot:passkey";

/** A passkey is tied to a domain. app.playpot.gg and any other playpot.gg subdomain share one, so the app can move. */
export const rpIdFor = (hostname: string): string => (hostname === "playpot.gg" || hostname.endsWith(".playpot.gg") ? "playpot.gg" : hostname);

export function savedPasskey(): PasskeyRecord | null {
  try {
    const rec = JSON.parse(localStorage.getItem(STORE) ?? "null") as PasskeyRecord | null;
    return rec && typeof rec.id === "string" && /^0x[0-9a-fA-F]{128}$/.test(rec.publicKey) ? rec : null;
  } catch {
    return null;
  }
}
const save = (rec: PasskeyRecord) => {
  try {
    localStorage.setItem(STORE, JSON.stringify(rec));
  } catch {
    /* private mode: the passkey can still be found again through the directory */
  }
};

const randomChallenge = (): Hex => toHex(crypto.getRandomValues(new Uint8Array(32)));
const point = (publicKey: Hex) => ({ prefix: 4, x: BigInt(`0x${publicKey.slice(2, 66)}`), y: BigInt(`0x${publicKey.slice(66)}`) });

const friendly = (e: unknown): Error => {
  const name = (e as { name?: string })?.name;
  if (name === "NotAllowedError" || name === "AbortError") return new Error("The passkey prompt was cancelled or timed out.");
  if (name === "SecurityError") return new Error("This browser would not use a passkey on this address.");
  if (name === "NotSupportedError") return new Error("This browser or device does not support passkeys.");
  return e instanceof Error ? e : new Error(String(e));
};

/** Makes a new passkey on this device and records its public key in the directory. */
export async function createPasskey(serverUrl: string): Promise<PasskeyRecord> {
  let cred;
  try {
    cred = await createWebAuthnCredential({
      name: `PlayPot ${new Date().toISOString().slice(0, 10)}`,
      rp: { id: rpIdFor(location.hostname), name: "PlayPot.GG" },
    });
  } catch (e) {
    throw friendly(e);
  }
  const rec: PasskeyRecord = { id: cred.id, publicKey: cred.publicKey };
  const res = await fetch(`${serverUrl}/passkey`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(rec) });
  if (!res.ok) throw new Error(`could not register the passkey (${res.status})`);
  save(rec);
  return rec;
}

/**
 * Signs in with a passkey the player already has. On this browser's device the key is remembered and the passkey is
 * asked for directly; on a new device the browser offers the passkeys it has synced for this site, and the public key is
 * fetched from the directory. Either way a fresh signature is checked against the public key before it is trusted.
 */
export async function signInWithPasskey(serverUrl: string): Promise<PasskeyRecord> {
  const rpId = rpIdFor(location.hostname);
  const known = savedPasskey();
  const challenge = randomChallenge();
  let signed;
  try {
    signed = await WebAuthnP256.sign({ challenge, rpId, ...(known ? { credentialId: known.id } : {}) });
  } catch (e) {
    throw friendly(e);
  }
  const id = signed.raw.id;
  let publicKey = known && known.id === id ? known.publicKey : undefined;
  if (!publicKey) {
    const res = await fetch(`${serverUrl}/passkey/${encodeURIComponent(id)}`);
    if (!res.ok) throw new Error("That passkey is not registered with PlayPot. Create a new passkey wallet instead.");
    publicKey = ((await res.json()) as { publicKey: Hex }).publicKey;
  }
  const ok = WebAuthnP256.verify({ challenge, metadata: signed.metadata, publicKey: point(publicKey), signature: signed.signature });
  if (!ok) throw new Error("The passkey's signature did not match the key on record.");
  const rec = { id, publicKey };
  save(rec);
  return rec;
}

// --------------------------------------------------------------------------------------------- the wallet provider

export interface UserOpReceipt {
  success: boolean;
  logs: BatchLog[];
  receipt: { transactionHash: Hex };
}
/** What the provider needs from a bundler client (the real one is viem's; tests pass a fake). */
export interface BundlerLike {
  sendUserOperation(args: { calls: Array<{ to: Address; data: Hex; value: bigint }> }): Promise<Hex>;
  getUserOperationReceipt(args: { hash: Hex }): Promise<UserOpReceipt>;
}

const notFound = (e: unknown) => (e as { name?: string })?.name === "UserOperationReceiptNotFoundError" || /could not be found/i.test((e as Error)?.message ?? "");

/**
 * Presents a smart account as the small wallet interface the app already speaks (EIP-1193 plus EIP-5792 batches), so
 * the rest of the app does not care whether the wallet is a passkey, MetaMask or anything else.
 */
export function smartProvider(address: Address, bundler: BundlerLike): Eip1193 {
  return {
    async request({ method, params }) {
      const p = (params ?? []) as unknown[];
      switch (method) {
        case "eth_requestAccounts":
        case "eth_accounts":
          return [address];
        case "wallet_switchEthereumChain":
          return null;
        case "wallet_sendCalls": {
          const batch = p[0] as { calls: Array<{ to: Address; data?: Hex; value?: Hex }> };
          return bundler.sendUserOperation({ calls: batch.calls.map((c) => ({ to: c.to, data: c.data ?? "0x", value: BigInt(c.value ?? "0x0") })) });
        }
        case "wallet_getCallsStatus": {
          try {
            const r = await bundler.getUserOperationReceipt({ hash: p[0] as Hex });
            return { status: r.success ? 200 : 500, receipts: [{ status: r.success ? "0x1" : "0x0", transactionHash: r.receipt.transactionHash, logs: r.logs }] };
          } catch (e) {
            if (notFound(e)) return { status: 100, receipts: [] };
            throw e;
          }
        }
        default:
          throw new Error(`the passkey wallet does not do ${method}`);
      }
    },
  };
}

export interface OpenedWallet {
  provider: Eip1193;
  address: Address;
}

/** Builds the smart account for a passkey and a bundler client that sends through this site's relay. */
export async function openPasskeyWallet(rec: PasskeyRecord, o: { publicClient: PublicClient; serverUrl: string; sponsored: boolean }): Promise<OpenedWallet> {
  const owner = toWebAuthnAccount({ credential: { id: rec.id, publicKey: rec.publicKey }, rpId: rpIdFor(location.hostname) });
  let account;
  try {
    account = await toCoinbaseSmartAccount({ client: o.publicClient, owners: [owner], version: "1.1" });
  } catch (e) {
    throw new Error(`could not work out the wallet address on this network (${(e as Error).message.slice(0, 120)})`);
  }
  const bundler = createBundlerClient({
    account,
    client: o.publicClient,
    transport: http(`${o.serverUrl}/bundler`),
    ...(o.sponsored ? { paymaster: createPaymasterClient({ transport: http(`${o.serverUrl}/paymaster`) }) } : {}),
    userOperation: {
      // Providers that offer a recommended gas price (Pimlico does) get asked first; others use the node's estimate.
      async estimateFeesPerGas({ bundlerClient }) {
        try {
          const r = (await bundlerClient.request({ method: "pimlico_getUserOperationGasPrice" } as never)) as { fast: { maxFeePerGas: Hex; maxPriorityFeePerGas: Hex } };
          return { maxFeePerGas: BigInt(r.fast.maxFeePerGas), maxPriorityFeePerGas: BigInt(r.fast.maxPriorityFeePerGas) };
        } catch {
          return o.publicClient.estimateFeesPerGas();
        }
      },
    },
  });
  return { provider: smartProvider(account.address, bundler as unknown as BundlerLike), address: account.address };
}
