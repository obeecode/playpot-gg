// Copies the server's data folder (match logs, the passkey directory, the encrypted email-wallet vaults and the secret
// that goes with them) into a new timestamped folder. Run it with:  npm run backup
// DATA_DIR (default "data") is what to copy; BACKUP_DIR (default "backups") is where copies go, for example a USB drive
// or a cloud-synced folder:  $env:BACKUP_DIR = "D:\PlayPotBackups"
import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const dataDir = resolve(process.env.DATA_DIR ?? "data");
const backupRoot = resolve(process.env.BACKUP_DIR ?? "backups");

if (!existsSync(dataDir)) {
  console.error(`Nothing to back up: ${dataDir} does not exist yet (the server creates it the first time it runs).`);
  process.exit(1);
}
if (backupRoot === dataDir || backupRoot.startsWith(dataDir + "\\") || backupRoot.startsWith(dataDir + "/")) {
  console.error("BACKUP_DIR must not be inside the data folder.");
  process.exit(1);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const target = join(backupRoot, `playpot-data-${stamp}`);
mkdirSync(target, { recursive: true });
cpSync(dataDir, target, { recursive: true });

const names = readdirSync(target);
const size = names.reduce((n, f) => n + statSync(join(target, f)).size, 0);
console.log(`Backed up ${names.length} files (${(size / 1024).toFixed(1)} KB) to ${target}`);

const has = (f: string) => names.includes(f);
if (has("vaults.jsonl") && !has("email-pepper.key")) {
  console.error("WARNING: vaults.jsonl is there but email-pepper.key is not. Without the pepper, email wallets cannot be matched to their owners after a restore.");
  process.exitCode = 2;
}
if (!has("vaults.jsonl") && !has("passkeys.jsonl")) console.log("(No wallet files yet: nobody has signed up with a passkey or an email.)");
console.log("Keep this folder somewhere other than this computer, and keep it private: it holds encrypted wallet keys.");
