// Email sign-in, without custody. An emailed code proves the player controls an address; it then releases the player's
// ENCRYPTED wallet key, which only their passphrase (in their own browser) can open. The server stores ciphertext it
// cannot read, and never sees the key or the passphrase. Email addresses are stored only as keyed hashes.
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface Mailer {
  sendCode(to: string, code: string): Promise<void>;
}

/** Brevo's transactional email API. The sender address must be verified in Brevo (ideally the whole domain). */
export function brevoMailer(o: { apiKey: string; fromEmail: string; fromName?: string; endpoint?: string; fetchFn?: typeof fetch }): Mailer {
  const fetchFn = o.fetchFn ?? fetch;
  return {
    async sendCode(to, code) {
      const res = await fetchFn(o.endpoint ?? "https://api.brevo.com/v3/smtp/email", {
        method: "POST",
        headers: { "api-key": o.apiKey, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          sender: { name: o.fromName ?? "PlayPot.GG", email: o.fromEmail },
          to: [{ email: to }],
          subject: `Your PlayPot sign-in code: ${code}`,
          textContent: `Your PlayPot.GG sign-in code is ${code}.\n\nIt works for 10 minutes. If you did not ask for it, ignore this email.\n\nPlayPot will never ask for your passphrase or your wallet key, by email or anywhere else.`,
          htmlContent: `<p>Your PlayPot.GG sign-in code is</p><p style="font-size:28px;letter-spacing:4px"><b>${code}</b></p><p>It works for 10 minutes. If you did not ask for it, ignore this email.</p><p style="color:#666">PlayPot will never ask for your passphrase or your wallet key, by email or anywhere else.</p>`,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`the email service answered ${res.status}`); // never include the key or the body
    },
  };
}

/** An encrypted wallet key, as the browser made it. The server checks its shape and size, nothing more. */
export interface VaultBlob {
  v: 1;
  kdf: "pbkdf2-sha256";
  iter: number;
  salt: string;
  iv: string;
  ct: string;
  address: string;
  /** Set for a recovery key: the wallet it is an extra owner of, and its owner index there. Public data, not secret. */
  wallet?: { address: string; ownerIndex: number };
}

const B64 = /^[A-Za-z0-9+/_=-]{8,1024}$/;
export function validVault(b: unknown): b is VaultBlob {
  const v = b as Partial<VaultBlob> | null;
  return (
    !!v &&
    v.v === 1 &&
    v.kdf === "pbkdf2-sha256" &&
    typeof v.iter === "number" &&
    Number.isInteger(v.iter) &&
    v.iter >= 100_000 &&
    v.iter <= 5_000_000 &&
    typeof v.salt === "string" && B64.test(v.salt) &&
    typeof v.iv === "string" && B64.test(v.iv) &&
    typeof v.ct === "string" && B64.test(v.ct) &&
    typeof v.address === "string" && /^0x[0-9a-fA-F]{40}$/.test(v.address) &&
    (v.wallet === undefined ||
      (typeof v.wallet === "object" && v.wallet !== null && typeof v.wallet.address === "string" && /^0x[0-9a-fA-F]{40}$/.test(v.wallet.address) && Number.isInteger(v.wallet.ownerIndex) && v.wallet.ownerIndex >= 0 && v.wallet.ownerIndex < 256))
  );
}

export type StartResult = "sent" | "invalid" | "limited" | "failed";
export type VerifyResult = { ok: true; token: string; hasVault: boolean } | { ok: false; reason: "wrong" | "locked" };
export type PutResult = "ok" | "invalid" | "unauthorized" | "full";

const CODE_TTL_MS = 10 * 60_000;
const TOKEN_TTL_MS = 20 * 60_000;
const MAX_ATTEMPTS = 5;
const MAX_VERSIONS = 20;
const emailOk = (e: string) => e.length <= 254 && /^[^@\s]{1,64}@[^@\s.]+(\.[^@\s.]+)+$/.test(e);

export interface EmailAuthOptions {
  dataDir: string;
  mailer: Mailer;
  now?: () => number;
  makeCode?: () => string; // tests fix the code
  perEmailPerHour?: number;
  perIpPerHour?: number;
}

export class EmailAuth {
  private o: EmailAuthOptions;
  private now: () => number;
  private pepper: Buffer;
  private codes = new Map<string, { hash: string; salt: string; expires: number; attempts: number; sentAt: number }>();
  private tokens = new Map<string, { key: string; expires: number }>();
  private vaults = new Map<string, Array<{ blob: VaultBlob; at: number }>>();
  private sends = new Map<string, number[]>();
  private file: string;

  constructor(o: EmailAuthOptions) {
    this.o = o;
    this.now = o.now ?? Date.now;
    mkdirSync(o.dataDir, { recursive: true });
    // A secret kept next to the data: without it a leaked vault file cannot be matched against guessed addresses.
    const pepperFile = join(o.dataDir, "email-pepper.key");
    if (!existsSync(pepperFile)) writeFileSync(pepperFile, randomBytes(32).toString("hex"), { mode: 0o600 });
    this.pepper = Buffer.from(readFileSync(pepperFile, "utf8").trim(), "hex");
    this.file = join(o.dataDir, "vaults.jsonl");
    if (existsSync(this.file)) {
      for (const line of readFileSync(this.file, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const { k, blob, at } = JSON.parse(line) as { k: string; blob: VaultBlob; at: number };
          if (/^[0-9a-f]{64}$/.test(k) && validVault(blob)) this.vaults.set(k, [...(this.vaults.get(k) ?? []), { blob, at }]);
        } catch {
          /* skip a damaged line */
        }
      }
    }
  }

  private key(email: string) {
    return createHmac("sha256", this.pepper).update(email).digest("hex");
  }
  private within(map: Map<string, number[]>, id: string, max: number, windowMs: number): boolean {
    const t = this.now();
    const recent = (map.get(id) ?? []).filter((x) => t - x < windowMs);
    if (recent.length >= max) return false;
    recent.push(t);
    map.set(id, recent);
    if (map.size > 50_000) map.clear();
    return true;
  }
  private codeHash(code: string, salt: string) {
    return createHash("sha256").update(`${salt}:${code}`).digest("hex");
  }

  /** Emails a code. The answer never says whether the address already has a wallet. */
  async start(emailRaw: unknown, ip: string): Promise<StartResult> {
    const email = typeof emailRaw === "string" ? emailRaw.trim().toLowerCase() : "";
    if (!emailOk(email)) return "invalid";
    const k = this.key(email);
    const prior = this.codes.get(k);
    if (prior && this.now() - prior.sentAt < 20_000) return "limited"; // one code every 20 seconds
    if (!this.within(this.sends, `e:${k}`, this.o.perEmailPerHour ?? 6, 3_600_000) || !this.within(this.sends, `i:${ip}`, this.o.perIpPerHour ?? 20, 3_600_000)) return "limited";
    const code = (this.o.makeCode ?? (() => String(randomInt(0, 1_000_000)).padStart(6, "0")))();
    const salt = randomBytes(8).toString("hex");
    this.codes.set(k, { hash: this.codeHash(code, salt), salt, expires: this.now() + CODE_TTL_MS, attempts: 0, sentAt: this.now() });
    try {
      await this.o.mailer.sendCode(email, code);
    } catch (e) {
      this.codes.delete(k);
      console.error(`email: could not send a code (${(e as Error).message.slice(0, 120)})`);
      return "failed";
    }
    return "sent";
  }

  /** Checks a code. Five wrong tries lock that code; a right one is spent and gives a short-lived token. */
  verify(emailRaw: unknown, codeRaw: unknown): VerifyResult {
    const email = typeof emailRaw === "string" ? emailRaw.trim().toLowerCase() : "";
    const code = typeof codeRaw === "string" ? codeRaw.trim() : "";
    const k = this.key(email);
    const entry = this.codes.get(k);
    if (!entry || this.now() > entry.expires) {
      this.codes.delete(k);
      return { ok: false, reason: "wrong" };
    }
    if (entry.attempts >= MAX_ATTEMPTS) return { ok: false, reason: "locked" };
    entry.attempts++;
    const a = Buffer.from(this.codeHash(code, entry.salt));
    const b = Buffer.from(entry.hash);
    if (!/^\d{6}$/.test(code) || a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: entry.attempts >= MAX_ATTEMPTS ? "locked" : "wrong" };
    this.codes.delete(k);
    const token = randomBytes(32).toString("hex");
    this.tokens.set(token, { key: k, expires: this.now() + TOKEN_TTL_MS });
    if (this.tokens.size > 50_000) this.tokens.clear();
    return { ok: true, token, hasVault: this.vaults.has(k) };
  }

  private who(token: unknown): string | undefined {
    if (typeof token !== "string") return undefined;
    const t = this.tokens.get(token);
    if (!t) return undefined;
    if (this.now() > t.expires) {
      this.tokens.delete(token);
      return undefined;
    }
    return t.key;
  }

  /** The newest encrypted key for the address the token proves. */
  vaultFor(token: unknown): { blob: VaultBlob; version: number } | "unauthorized" | undefined {
    const k = this.who(token);
    if (!k) return "unauthorized";
    const list = this.vaults.get(k);
    return list?.length ? { blob: list[list.length - 1].blob, version: list.length } : undefined;
  }

  /** Stores a new version. Older versions are kept, so a change can always be undone by hand. */
  putVault(token: unknown, blob: unknown): PutResult {
    const k = this.who(token);
    if (!k) return "unauthorized";
    if (!validVault(blob)) return "invalid";
    const list = this.vaults.get(k) ?? [];
    if (list.length >= MAX_VERSIONS) return "full";
    list.push({ blob, at: this.now() });
    this.vaults.set(k, list);
    appendFileSync(this.file, JSON.stringify({ k, blob, at: this.now() }) + "\n");
    return "ok";
  }
}
