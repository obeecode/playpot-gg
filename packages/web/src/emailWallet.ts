// Email wallets: the wallet key is made in the browser, encrypted with a passphrase the player chooses, and kept by the
// server only as ciphertext. An emailed code lets a player fetch it on any device; the passphrase opens it. The server
// never sees the key or the passphrase, so it cannot spend anything, and nobody can recover a forgotten passphrase.
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Address, Hex } from "viem";

export interface VaultBlob {
  v: 1;
  kdf: "pbkdf2-sha256";
  iter: number;
  salt: string;
  iv: string;
  ct: string;
  address: Address;
}

export const KDF_ITERATIONS = 600_000;

const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const addrBytes = (a: string) => new TextEncoder().encode(a.toLowerCase());

async function aesKey(passphrase: string, salt: Uint8Array, iter: number) {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(passphrase.normalize("NFKC")), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations: iter }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

/** Why a passphrase is not good enough, or null if it is. A wallet that holds money needs more than a short word. */
export function passphraseProblem(p: string): string | null {
  if (p.length < 10) return "Use at least 10 characters. Four random words works well.";
  if (new Set(p.toLowerCase()).size < 5) return "That passphrase repeats too much. Try a few unrelated words.";
  if (/^(password|passphrase|12345|qwerty|letmein|playpot)/i.test(p)) return "That passphrase is too easy to guess.";
  return null;
}

/** Encrypts a wallet key. The address is bound into the ciphertext, so a swapped blob fails to open. */
export async function encryptWalletKey(privateKey: Hex, passphrase: string, iter = KDF_ITERATIONS): Promise<VaultBlob> {
  const address = privateKeyToAccount(privateKey).address;
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await aesKey(passphrase, salt, iter);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource, additionalData: addrBytes(address) as BufferSource }, key, new TextEncoder().encode(privateKey)));
  return { v: 1, kdf: "pbkdf2-sha256", iter, salt: b64(salt), iv: b64(iv), ct: b64(ct), address };
}

/** Opens a wallet key. A wrong passphrase, or a blob that was altered, is the same plain error. */
export async function decryptWalletKey(blob: VaultBlob, passphrase: string): Promise<Hex> {
  let plain: ArrayBuffer;
  try {
    const key = await aesKey(passphrase, unb64(blob.salt), blob.iter);
    plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(blob.iv) as BufferSource, additionalData: addrBytes(blob.address) as BufferSource }, key, unb64(blob.ct) as BufferSource);
  } catch {
    throw new Error("That passphrase did not open the wallet.");
  }
  const pk = new TextDecoder().decode(plain) as Hex;
  if (!/^0x[0-9a-f]{64}$/i.test(pk) || privateKeyToAccount(pk).address.toLowerCase() !== blob.address.toLowerCase()) throw new Error("The saved wallet is damaged.");
  return pk;
}

export const newWalletKey = (): Hex => generatePrivateKey();

// ------------------------------------------------------------------------------------------------- the server calls

async function call<T>(serverUrl: string, path: string, init: { method?: string; token?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`${serverUrl}${path}`, {
    method: init.method ?? "GET",
    headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...(init.token ? { authorization: `Bearer ${init.token}` } : {}) },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const json = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw Object.assign(new Error(json.error ?? `the server said ${res.status}`), { status: res.status });
  return json as T;
}

export const emailStart = (serverUrl: string, email: string) => call<{ ok: true }>(serverUrl, "/email/start", { method: "POST", body: { email } });
export const emailVerify = (serverUrl: string, email: string, code: string) => call<{ token: string; hasVault: boolean }>(serverUrl, "/email/verify", { method: "POST", body: { email, code } });
export const fetchVault = (serverUrl: string, token: string) => call<{ blob: VaultBlob; version: number }>(serverUrl, "/vault", { token });
export const saveVault = (serverUrl: string, token: string, blob: VaultBlob) => call<{ ok: true }>(serverUrl, "/vault", { method: "PUT", token, body: { blob } });

// -------------------------------------------------------------------------------------- what this device remembers

const VAULT = "playpot:vault"; // the encrypted blob: lets this device unlock with the passphrase alone, no new code
const SESSION_KEY = "playpot:emailkey"; // the opened key, for this tab only, so a reload does not ask again

export function localVault(): VaultBlob | null {
  try {
    const b = JSON.parse(localStorage.getItem(VAULT) ?? "null") as VaultBlob | null;
    return b && b.v === 1 && typeof b.ct === "string" ? b : null;
  } catch {
    return null;
  }
}
export function rememberVault(blob: VaultBlob) {
  try {
    localStorage.setItem(VAULT, JSON.stringify(blob));
  } catch {
    /* private mode */
  }
}
export function sessionKey(): Hex | null {
  try {
    return (sessionStorage.getItem(SESSION_KEY) as Hex | null) ?? null;
  } catch {
    return null;
  }
}
export function rememberSessionKey(pk: Hex) {
  try {
    sessionStorage.setItem(SESSION_KEY, pk);
  } catch {
    /* private mode */
  }
}
export function forgetEmailWallet() {
  try {
    sessionStorage.removeItem(SESSION_KEY);
  } catch {
    /* nothing to forget */
  }
}
