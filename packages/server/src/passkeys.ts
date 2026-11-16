// A public directory of passkey public keys, so a player on a new device can find their wallet again.
// A passkey the browser syncs (iCloud, Google, Windows) hands back its id but not its public key, and the wallet address
// comes from the public key. Both are public data. Entries are write-once: nobody can replace the key behind an id, and
// the browser checks a fresh signature against the key it gets back, so a lying server could only make sign-in fail.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ID = /^[A-Za-z0-9_-]{16,512}$/;
const KEY = /^0x[0-9a-fA-F]{128}$/; // the P-256 public key as x then y, 64 bytes
const MAX_ENTRIES = 500_000;

export type RegisterResult = "created" | "same" | "conflict" | "invalid" | "full";

/** The wallet a passkey signs for, when it is not the wallet made from the passkey itself (a recovery passkey). */
export interface WalletRef {
  address: string;
  ownerIndex: number;
}
const validRef = (w: unknown): w is WalletRef => {
  const r = w as Partial<WalletRef> | null;
  return !!r && typeof r.address === "string" && /^0x[0-9a-fA-F]{40}$/.test(r.address) && Number.isInteger(r.ownerIndex) && r.ownerIndex! >= 0 && r.ownerIndex! < 256;
};
const sameRef = (a?: WalletRef, b?: WalletRef) => (!a && !b) || (!!a && !!b && a.address.toLowerCase() === b.address.toLowerCase() && a.ownerIndex === b.ownerIndex);

export class PasskeyRegistry {
  private keys = new Map<string, string>();
  private wallets = new Map<string, WalletRef>();
  private file: string;

  constructor(dataDir: string) {
    this.file = join(dataDir, "passkeys.jsonl");
    if (!existsSync(this.file)) return;
    for (const line of readFileSync(this.file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const { id, publicKey, wallet } = JSON.parse(line) as { id: string; publicKey: string; wallet?: WalletRef };
        if (ID.test(id) && KEY.test(publicKey) && !this.keys.has(id)) {
          this.keys.set(id, publicKey.toLowerCase());
          if (validRef(wallet)) this.wallets.set(id, wallet);
        }
      } catch {
        /* a damaged line is skipped */
      }
    }
  }

  get size() {
    return this.keys.size;
  }

  get(id: string): { publicKey: string; wallet?: WalletRef } | undefined {
    if (!ID.test(id)) return undefined;
    const publicKey = this.keys.get(id);
    return publicKey ? { publicKey, wallet: this.wallets.get(id) } : undefined;
  }

  register(id: unknown, publicKey: unknown, wallet?: unknown): RegisterResult {
    if (typeof id !== "string" || typeof publicKey !== "string" || !ID.test(id) || !KEY.test(publicKey)) return "invalid";
    if (wallet !== undefined && !validRef(wallet)) return "invalid";
    const key = publicKey.toLowerCase();
    const have = this.keys.get(id);
    if (have) return have === key && sameRef(this.wallets.get(id), wallet as WalletRef | undefined) ? "same" : "conflict";
    if (this.keys.size >= MAX_ENTRIES) return "full";
    this.keys.set(id, key);
    if (wallet) this.wallets.set(id, wallet as WalletRef);
    appendFileSync(this.file, JSON.stringify({ id, publicKey: key, ...(wallet ? { wallet } : {}), at: Date.now() }) + "\n");
    return "created";
  }
}
