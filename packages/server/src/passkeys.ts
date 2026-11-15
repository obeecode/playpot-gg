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

export class PasskeyRegistry {
  private keys = new Map<string, string>();
  private file: string;

  constructor(dataDir: string) {
    this.file = join(dataDir, "passkeys.jsonl");
    if (!existsSync(this.file)) return;
    for (const line of readFileSync(this.file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const { id, publicKey } = JSON.parse(line) as { id: string; publicKey: string };
        if (ID.test(id) && KEY.test(publicKey) && !this.keys.has(id)) this.keys.set(id, publicKey.toLowerCase());
      } catch {
        /* a damaged line is skipped */
      }
    }
  }

  get size() {
    return this.keys.size;
  }

  get(id: string): string | undefined {
    return ID.test(id) ? this.keys.get(id) : undefined;
  }

  register(id: unknown, publicKey: unknown): RegisterResult {
    if (typeof id !== "string" || typeof publicKey !== "string" || !ID.test(id) || !KEY.test(publicKey)) return "invalid";
    const key = publicKey.toLowerCase();
    const have = this.keys.get(id);
    if (have) return have === key ? "same" : "conflict";
    if (this.keys.size >= MAX_ENTRIES) return "full";
    this.keys.set(id, key);
    appendFileSync(this.file, JSON.stringify({ id, publicKey: key, at: Date.now() }) + "\n");
    return "created";
  }
}
