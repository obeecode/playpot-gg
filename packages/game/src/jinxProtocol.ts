// JINX pick protocol: signed commitments, referee receipts and misses, the hash chain, and a log verifier that mirrors
// the on-chain replay in contracts/src/JinxEscrow.sol. Encodings here must match the contract byte for byte.
import {
  encodeAbiParameters,
  keccak256,
  recoverTypedDataAddress,
  type Address,
  type Hex,
  type LocalAccount,
} from "viem";
import { RESULT_TYPES, type ResultMsg } from "./protocol.ts";
import { applyTurn, isDeathMatch, MAX_MATCH_TURNS, newGame, newMatch, recordGame, type GameState, type MatchState } from "./jinx.ts";

export const TURN_LIMIT_MS = 10_000; // the clock a player sees
export const GRACE_MS = 1_500; // network allowance the referee adds on top
export const NO_PICK = 255;
export const ZERO32: Hex = `0x${"00".repeat(32)}`;

export const jinxDomain = (chainId: number, verifyingContract: Address) =>
  ({ name: "PlayPotJinx", version: "1", chainId, verifyingContract }) as const;
export type JinxDomain = ReturnType<typeof jinxDomain>;

export const JINX_COMMIT_TYPES = {
  Commit: [
    { name: "matchId", type: "uint256" },
    { name: "turn", type: "uint16" },
    { name: "commitment", type: "bytes32" },
    { name: "prevHash", type: "bytes32" },
  ],
} as const;

export const JINX_RECEIPT_TYPES = {
  Receipt: [
    { name: "matchId", type: "uint256" },
    { name: "turn", type: "uint16" },
    { name: "side", type: "uint8" },
    { name: "commitment", type: "bytes32" },
    { name: "openedMs", type: "uint64" },
    { name: "recvMs", type: "uint64" },
  ],
} as const;

export const JINX_MISS_TYPES = {
  Miss: [
    { name: "matchId", type: "uint256" },
    { name: "turn", type: "uint16" },
    { name: "side", type: "uint8" },
    { name: "kind", type: "uint8" },
    { name: "commitment", type: "bytes32" },
    { name: "openedMs", type: "uint64" },
    { name: "atMs", type: "uint64" },
  ],
} as const;

export interface CommitMsg {
  matchId: bigint;
  turn: number;
  commitment: Hex;
  prevHash: Hex;
}
export interface ReceiptMsg {
  matchId: bigint;
  turn: number;
  side: 1 | 2;
  commitment: Hex;
  openedMs: bigint;
  recvMs: bigint;
}
export interface MissMsg {
  matchId: bigint;
  turn: number;
  side: 1 | 2;
  kind: 0 | 1;
  commitment: Hex;
  openedMs: bigint;
  atMs: bigint;
}

export const signCommit = (a: LocalAccount, d: JinxDomain, m: CommitMsg) =>
  a.signTypedData({ domain: d, types: JINX_COMMIT_TYPES, primaryType: "Commit", message: m });
export const signReceipt = (a: LocalAccount, d: JinxDomain, m: ReceiptMsg) =>
  a.signTypedData({ domain: d, types: JINX_RECEIPT_TYPES, primaryType: "Receipt", message: m });
export const signMiss = (a: LocalAccount, d: JinxDomain, m: MissMsg) =>
  a.signTypedData({ domain: d, types: JINX_MISS_TYPES, primaryType: "Miss", message: m });

export const signJinxResult = (a: LocalAccount, d: JinxDomain, m: ResultMsg) =>
  a.signTypedData({ domain: d, types: RESULT_TYPES, primaryType: "Result", message: m });
export const recoverJinxResult = (d: JinxDomain, m: ResultMsg, signature: Hex) =>
  recoverTypedDataAddress({ domain: d, types: RESULT_TYPES, primaryType: "Result", message: m, signature });

export const recoverCommit = (d: JinxDomain, m: CommitMsg, signature: Hex) =>
  recoverTypedDataAddress({ domain: d, types: JINX_COMMIT_TYPES, primaryType: "Commit", message: m, signature });
export const recoverReceipt = (d: JinxDomain, m: ReceiptMsg, signature: Hex) =>
  recoverTypedDataAddress({ domain: d, types: JINX_RECEIPT_TYPES, primaryType: "Receipt", message: m, signature });
export const recoverMiss = (d: JinxDomain, m: MissMsg, signature: Hex) =>
  recoverTypedDataAddress({ domain: d, types: JINX_MISS_TYPES, primaryType: "Miss", message: m, signature });

export const jinxGenesis = (matchId: bigint): Hex =>
  keccak256(encodeAbiParameters([{ type: "string" }, { type: "uint256" }], ["PLAYPOT_JINX_GENESIS", matchId]));

export const commitmentOf = (matchId: bigint, turn: number, cell: number, salt: Hex): Hex =>
  keccak256(
    encodeAbiParameters([{ type: "uint256" }, { type: "uint16" }, { type: "uint8" }, { type: "bytes32" }], [matchId, turn, cell, salt]),
  );

export const jinxChain = (head: Hex, turn: number, commitA: Hex, commitB: Hex, cellA: number, cellB: number): Hex =>
  keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint16" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint8" }, { type: "uint8" }],
      [head, turn, commitA, commitB, cellA, cellB],
    ),
  );

// ------------------------------------------------------------------------------------------------------ the log

/** One player's evidence for one turn: a revealed, receipted pick, or a referee-asserted miss. Times are decimal strings. */
export interface JinxSide {
  missed: boolean;
  missKind: 0 | 1; // 0: no commitment arrived in time, 1: committed but never revealed
  cell: number;
  salt: Hex;
  commitment: Hex; // missKind 1 only
  openedMs: string;
  recvMs: string;
  atMs: string;
  commitSig: Hex;
  refSig: Hex; // the receipt (pick) or the miss signature
}
export interface JinxTurnLog {
  a: JinxSide;
  b: JinxSide;
}
export interface JinxMatchLog {
  matchId: string;
  chainId: number;
  escrow: Address;
  key1: Address;
  key2: Address;
  referee: Address;
  bestOf: 3 | 5;
  turns: JinxTurnLog[];
  result?: number; // 1 player 1 wins, 2 player 2 wins, 3 refund
  finalHash?: Hex;
  refSig?: Hex;
  sig1?: Hex;
  sig2?: Hex;
}

export interface JinxVerification {
  ok: boolean;
  errors: string[];
  result: number; // 0 while the match is undecided
  head: Hex;
  match: MatchState;
  game: GameState;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

interface SideRead {
  cell: number | null;
  commitment: Hex;
}

async function readSide(
  log: JinxMatchLog,
  domain: JinxDomain,
  turn: number,
  side: 1 | 2,
  s: JinxSide,
  head: Hex,
  errors: string[],
  voided: ReadonlySet<number>,
): Promise<SideRead> {
  const matchId = BigInt(log.matchId);
  const key = side === 1 ? log.key1 : log.key2;
  const label = `turn ${turn} P${side}`;
  const opened = BigInt(s.openedMs);
  if (!s.missed) {
    if (s.cell < 0 || s.cell > 24) errors.push(`${label}: cell out of range`);
    const commitment = commitmentOf(matchId, turn, s.cell, s.salt);
    const signer = await recoverCommit(domain, { matchId, turn, commitment, prevHash: head }, s.commitSig).catch(() => undefined);
    if (!signer || !same(signer, key)) errors.push(`${label}: bad commitment signature`);
    const recv = BigInt(s.recvMs);
    if (recv < opened || recv > opened + BigInt(TURN_LIMIT_MS + GRACE_MS)) errors.push(`${label}: receipt outside the clock`);
    const ref = await recoverReceipt(domain, { matchId, turn, side, commitment, openedMs: opened, recvMs: recv }, s.refSig).catch(
      () => undefined,
    );
    if (!ref || !same(ref, log.referee)) errors.push(`${label}: bad referee receipt`);
    return { cell: s.cell, commitment };
  }
  const commitment = s.missKind === 1 ? s.commitment : ZERO32;
  const at = BigInt(s.atMs);
  const ref = await recoverMiss(domain, { matchId, turn, side, kind: s.missKind, commitment, openedMs: opened, atMs: at }, s.refSig).catch(
    () => undefined,
  );
  if (!ref || !same(ref, log.referee)) errors.push(`${label}: bad referee miss signature`);
  if (s.missKind === 0) {
    if (at < opened + BigInt(TURN_LIMIT_MS)) errors.push(`${label}: miss called before the clock ran out`);
    if (voided.has(turn * 2 + side - 1)) errors.push(`${label}: miss was voided by a receipt`);
  }
  return { cell: null, commitment };
}

/** Re-derives a match from its log: signatures, receipts, hash chain, rules and result. Pure and deterministic.
 *  `voided` is the set of turn*2+side-1 slots whose no-commitment miss a receipt has cancelled on-chain. */
export async function verifyJinxLog(log: JinxMatchLog, voided: ReadonlySet<number> = new Set()): Promise<JinxVerification> {
  const errors: string[] = [];
  const matchId = BigInt(log.matchId);
  const domain = jinxDomain(log.chainId, log.escrow);
  let head = jinxGenesis(matchId);
  let game = newGame(false);
  let match = newMatch(log.bestOf);
  let result = 0;

  if (log.turns.length > MAX_MATCH_TURNS) errors.push("more turns than the cap");
  for (let i = 0; i < log.turns.length && errors.length === 0; i++) {
    if (result !== 0) {
      errors.push(`turn ${i}: after the match was decided`);
      break;
    }
    const t = log.turns[i];
    const a = await readSide(log, domain, i, 1, t.a, head, errors, voided);
    const b = await readSide(log, domain, i, 2, t.b, head, errors, voided);
    head = jinxChain(head, i, a.commitment, b.commitment, a.cell ?? NO_PICK, b.cell ?? NO_PICK);
    if (errors.length) break;

    let turn;
    try {
      turn = applyTurn(game, a.cell, b.cell);
    } catch (e) {
      errors.push(`turn ${i}: ${(e as Error).message}`);
      break;
    }
    game = turn.state;
    if (turn.doubleForfeit) {
      result = 3;
    } else if (turn.outcome !== "ongoing") {
      const rec = recordGame(match, turn.outcome);
      match = rec.match;
      if (rec.winner) result = rec.winner;
      else game = newGame(isDeathMatch(match));
    }
    if (result === 0 && i + 1 === MAX_MATCH_TURNS) result = 3;
  }
  if (errors.length === 0 && result === 0) errors.push("the log does not end in a decided match");
  if (log.result !== undefined) {
    if (log.result !== result) errors.push(`claimed result ${log.result} != replayed result ${result}`);
    if (log.finalHash !== head) errors.push("finalHash does not match the chain head");
  }
  return { ok: errors.length === 0, errors, result, head, match, game };
}

/** The turns in the shape PotEscrow-style `submitReplay` expects (viem argument encoding). */
export function toContractTurns(log: JinxMatchLog) {
  const side = (s: JinxSide) => ({
    missed: s.missed,
    missKind: s.missKind,
    cell: s.missed ? 0 : s.cell,
    salt: s.missed ? ZERO32 : s.salt,
    commitment: s.missed && s.missKind === 1 ? s.commitment : ZERO32,
    openedMs: BigInt(s.openedMs),
    recvMs: s.missed ? 0n : BigInt(s.recvMs),
    atMs: s.missed ? BigInt(s.atMs) : 0n,
    commitSig: s.missed ? ("0x" as Hex) : s.commitSig,
    refSig: s.refSig,
  });
  return log.turns.map((t) => ({ a: side(t.a), b: side(t.b) }));
}
