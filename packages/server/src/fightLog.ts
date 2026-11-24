// The Fight match record. The relay appends every message it forwards to a hash chain with the server's own arrival time, and the
// referee signs the final head. Nobody can add, remove, reorder or retime a message afterwards without breaking the chain or
// the signature, and the timestamps come from one neutral clock, which is what lag and timing checks need.
import { encodeAbiParameters, keccak256, recoverMessageAddress, stringToHex, type Address, type Hex, type LocalAccount } from "viem";

export const FIGHT_LOG_VERSION = 1;
export const HOST = 0;
export const GUEST = 1;
export type FightSide = typeof HOST | typeof GUEST;

export const fightGenesis = (room: string): Hex => keccak256(encodeAbiParameters([{ type: "string" }, { type: "string" }], ["PLAYPOT_FIGHT_GENESIS", room]));

const payloadHash = (payload: string): Hex => keccak256(stringToHex(payload));

export const fightLink = (prev: Hex, seq: number, at: number, side: FightSide, payload: string): Hex =>
  keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint32" }, { type: "uint32" }, { type: "uint8" }, { type: "bytes32" }], [prev, seq, at, side, payloadHash(payload)]));

export interface FightEntry {
  seq: number;
  at: number; // milliseconds since the match record opened, on the server's clock
  side: FightSide; // who sent it
  payload: string; // exactly what the relay forwarded
  hash: Hex;
}

export interface FightLogHead {
  room: string;
  host: Address | null; // wallet addresses, when the players joined with a signed identity
  guest: Address | null;
  startedAtMs: number; // wall clock when the record opened
  durationMs: number;
  count: number;
  head: Hex;
  reason: string; // why the record closed: "host left", "guest left", "closed"
}

export interface FightLogFile {
  version: typeof FIGHT_LOG_VERSION;
  head: FightLogHead;
  signature: Hex;
  signer: Address;
  entries: FightEntry[];
}

export const headDigest = (h: FightLogHead): Hex =>
  keccak256(
    encodeAbiParameters(
      [{ type: "string" }, { type: "string" }, { type: "address" }, { type: "address" }, { type: "uint64" }, { type: "uint32" }, { type: "uint32" }, { type: "bytes32" }, { type: "string" }],
      ["PLAYPOT_FIGHT_LOG", h.room, h.host ?? ZERO_ADDRESS, h.guest ?? ZERO_ADDRESS, BigInt(h.startedAtMs), h.durationMs, h.count, h.head, h.reason],
    ),
  );
const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";

export class FightLog {
  readonly entries: FightEntry[] = [];
  private headHash: Hex;
  private closed = false;
  readonly room: string;
  readonly startedAtMs: number;
  readonly host: Address | null;
  readonly guest: Address | null;
  constructor(room: string, startedAtMs: number, host: Address | null = null, guest: Address | null = null) {
    this.room = room;
    this.startedAtMs = startedAtMs;
    this.host = host;
    this.guest = guest;
    this.headHash = fightGenesis(room);
  }
  get head(): Hex {
    return this.headHash;
  }
  append(side: FightSide, payload: string, nowMs: number): FightEntry {
    if (this.closed) throw new Error("the record is closed");
    const at = Math.max(0, Math.min(0xffffffff, Math.round(nowMs - this.startedAtMs)));
    const seq = this.entries.length;
    const hash = fightLink(this.headHash, seq, at, side, payload);
    const entry: FightEntry = { seq, at, side, payload, hash };
    this.entries.push(entry);
    this.headHash = hash;
    return entry;
  }
  /** Closes the record and signs its head. Further appends are refused. */
  async finalize(referee: LocalAccount, reason: string, nowMs: number): Promise<FightLogFile> {
    this.closed = true;
    const head: FightLogHead = {
      room: this.room,
      host: this.host,
      guest: this.guest,
      startedAtMs: this.startedAtMs,
      durationMs: Math.max(0, Math.round(nowMs - this.startedAtMs)),
      count: this.entries.length,
      head: this.headHash,
      reason,
    };
    const signature = await referee.signMessage({ message: { raw: headDigest(head) } });
    return { version: FIGHT_LOG_VERSION, head, signature, signer: referee.address, entries: this.entries };
  }
}

export interface FightLogCheck {
  ok: boolean;
  errors: string[];
}

/** Checks the chain link by link, the head, and the referee's signature. Pass the referee's address to insist on who signed. */
export async function verifyFightLog(file: FightLogFile, expectedSigner?: Address): Promise<FightLogCheck> {
  const errors: string[] = [];
  if (file.version !== FIGHT_LOG_VERSION) errors.push(`unknown record version ${String(file.version)}`);
  let prev = fightGenesis(file.head.room);
  let lastAt = 0;
  file.entries.forEach((e, i) => {
    if (e.seq !== i) errors.push(`entry ${i} has sequence number ${e.seq}`);
    if (e.side !== HOST && e.side !== GUEST) errors.push(`entry ${i} has an unknown sender`);
    if (e.at < lastAt) errors.push(`entry ${i} is dated before the one before it`);
    lastAt = e.at;
    const want = fightLink(prev, i, e.at, e.side, e.payload);
    if (e.hash !== want) errors.push(`entry ${i} does not follow the chain`);
    prev = e.hash;
  });
  if (file.head.count !== file.entries.length) errors.push(`the head says ${file.head.count} entries, the record has ${file.entries.length}`);
  if (file.head.head !== prev) errors.push("the head does not match the last entry");
  try {
    const signer = await recoverMessageAddress({ message: { raw: headDigest(file.head) }, signature: file.signature });
    if (signer.toLowerCase() !== file.signer.toLowerCase()) errors.push("the signature was not made by the stated signer");
    if (expectedSigner && signer.toLowerCase() !== expectedSigner.toLowerCase()) errors.push("the record was not signed by the expected referee");
  } catch {
    errors.push("the signature is not valid");
  }
  return { ok: errors.length === 0, errors };
}

/** What a player signs to prove which wallet they are when they join a staked room. */
export const joinMessage = (room: string, role: "host" | "guest"): string => `PlayPot Fight: join room ${room} as ${role}`;

export async function recoverJoin(room: string, role: "host" | "guest", signature: Hex): Promise<Address | undefined> {
  try {
    return await recoverMessageAddress({ message: joinMessage(room, role), signature });
  } catch {
    return undefined;
  }
}
