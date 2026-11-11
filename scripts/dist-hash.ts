import { createHash } from "node:crypto";

export const sha256 = (data: Uint8Array | string): string => createHash("sha256").update(data).digest("hex");

export interface Manifest {
  root: string;
  files: Record<string, string>; // posix path -> sha256 hex
}

/** Root hash: sha256 over "path<TAB>sha256<LF>" lines sorted by path. manifest.json itself is excluded. */
export function rootOf(files: Record<string, string>): string {
  const lines = Object.keys(files)
    .filter((p) => p !== "manifest.json")
    .sort()
    .map((p) => `${p}\t${files[p]}\n`);
  return sha256(lines.join(""));
}
