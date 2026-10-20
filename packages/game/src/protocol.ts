import {
  concatHex,
  encodeAbiParameters,
  keccak256,
  recoverTypedDataAddress,
  type Address,
  type Hex,
  type LocalAccount,
} from "viem";
import { applyMove, initialBoard, ONGOING, type Board, type Outcome } from "./tictactoe.ts";

export const GENESIS_LABEL = "PLAYPOT_TTT_GENESIS";

export function genesisHash(matchId: bigint): Hex {
  return keccak256(encodeAbiParameters([{ type: "string" }, { type: "uint256" }], [GENESIS_LABEL, matchId]));
}

export function chainHash(prev: Hex, cell: number): Hex {
  return keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint8" }], [prev, cell]));
}

export function eip712Domain(chainId: number, verifyingContract: Address) {
  return { name: "PlayPotEscrow", version: "1", chainId, verifyingContract } as const;
}
export type Domain = ReturnType<typeof eip712Domain>;

export const MOVE_TYPES = {
  Move: [
    { name: "matchId", type: "uint256" },
    { name: "index", type: "uint8" },
    { name: "cell", type: "uint8" },
    { name: "prevHash", type: "bytes32" },
  ],
} as const;

export const RESULT_TYPES = {
  Result: [
    { name: "matchId", type: "uint256" },
    { name: "result", type: "uint8" },
    { name: "finalHash", type: "bytes32" },
  ],
} as const;

// Off-chain only: the referee countersigns every accepted move with its receive time.
export const EVENT_TYPES = {
  Event: [
    { name: "matchId", type: "uint256" },
    { name: "index", type: "uint8" },
    { name: "cell", type: "uint8" },
    { name: "hash", type: "bytes32" },
    { name: "recvMs", type: "uint64" },
  ],
} as const;

export interface MoveMsg {
  matchId: bigint;
  index: number;
  cell: number;
  prevHash: Hex;
}
export interface ResultMsg {
  matchId: bigint;
  result: number;
  finalHash: Hex;
}
export interface EventMsg {
  matchId: bigint;
  index: number;
  cell: number;
  hash: Hex;
  recvMs: bigint;
}

export const signMove = (a: LocalAccount, d: Domain, m: MoveMsg) =>
  a.signTypedData({ domain: d, types: MOVE_TYPES, primaryType: "Move", message: m });
export const signResult = (a: LocalAccount, d: Domain, m: ResultMsg) =>
  a.signTypedData({ domain: d, types: RESULT_TYPES, primaryType: "Result", message: m });
export const signEvent = (a: LocalAccount, d: Domain, m: EventMsg) =>
  a.signTypedData({ domain: d, types: EVENT_TYPES, primaryType: "Event", message: m });

export const recoverMove = (d: Domain, m: MoveMsg, signature: Hex) =>
  recoverTypedDataAddress({ domain: d, types: MOVE_TYPES, primaryType: "Move", message: m, signature });
export const recoverResult = (d: Domain, m: ResultMsg, signature: Hex) =>
  recoverTypedDataAddress({ domain: d, types: RESULT_TYPES, primaryType: "Result", message: m, signature });
export const recoverEvent = (d: Domain, m: EventMsg, signature: Hex) =>
  recoverTypedDataAddress({ domain: d, types: EVENT_TYPES, primaryType: "Event", message: m, signature });

const lower = (a: string) => a.toLowerCase();

// ------------------------------------------------------------------ match log

export interface LoggedMove {
  index: number;
  cell: number;
  sig: Hex; // mover's session key over Move(matchId, index, cell, prevHash)
  hash: Hex; // chain head after this move
  recvMs: string; // referee receive time, decimal string for JSON
  serverSig: Hex; // referee countersignature over Event(...)
}

export interface MatchLog {
  matchId: string; // decimal
  chainId: number;
  escrow: Address;
  key1: Address;
  key2: Address;
  referee: Address;
  moves: LoggedMove[];
  result?: number;
  finalHash?: Hex;
  refSig?: Hex;
  sig1?: Hex;
  sig2?: Hex;
}

export interface Verification {
  ok: boolean;
  errors: string[];
  outcome: Outcome;
  head: Hex;
  board: Board;
}

/** Re-derives everything from a log: signatures, hash chain, rules, result. Pure and deterministic. */
export async function verifyLog(log: MatchLog): Promise<Verification> {
  const errors: string[] = [];
  const matchId = BigInt(log.matchId);
  const domain = eip712Domain(log.chainId, log.escrow);
  let head = genesisHash(matchId);
  let board = initialBoard();
  let outcome: Outcome = ONGOING;

  for (let i = 0; i < log.moves.length; i++) {
    const mv = log.moves[i];
    if (mv.index !== i) {
      errors.push(`move ${i}: wrong index ${mv.index}`);
      break;
    }
    if (outcome !== ONGOING) {
      errors.push(`move ${i}: after game end`);
      break;
    }
    try {
      ({ board, outcome } = applyMove(board, mv.cell));
    } catch (e) {
      errors.push(`move ${i}: illegal (${(e as Error).message})`);
      break;
    }
    const signer = await recoverMove(domain, { matchId, index: i, cell: mv.cell, prevHash: head }, mv.sig).catch(
      () => undefined,
    );
    const expected = i % 2 === 0 ? log.key1 : log.key2;
    if (!signer || lower(signer) !== lower(expected)) errors.push(`move ${i}: bad player signature`);
    head = chainHash(head, mv.cell);
    if (mv.hash !== head) errors.push(`move ${i}: hash mismatch`);
    const refSigner = await recoverEvent(
      domain,
      { matchId, index: i, cell: mv.cell, hash: head, recvMs: BigInt(mv.recvMs) },
      mv.serverSig,
    ).catch(() => undefined);
    if (!refSigner || lower(refSigner) !== lower(log.referee)) errors.push(`move ${i}: bad referee countersignature`);
  }

  if (log.result !== undefined) {
    if (outcome === ONGOING) errors.push("result claimed but game not finished");
    else if (log.result !== outcome) errors.push(`result ${log.result} != replayed outcome ${outcome}`);
    if (log.finalHash !== head) errors.push("finalHash does not match chain head");
    if (log.refSig) {
      const r = await recoverResult(domain, { matchId, result: log.result, finalHash: head }, log.refSig).catch(
        () => undefined,
      );
      if (!r || lower(r) !== lower(log.referee)) errors.push("bad referee result signature");
    }
  }
  return { ok: errors.length === 0, errors, outcome, head, board };
}

/** Arguments for PotEscrow.submitReplay(id, cells, sigs). */
export function replayArgs(log: MatchLog): { cells: number[]; sigs: Hex[] } {
  return { cells: log.moves.map((m) => m.cell), sigs: log.moves.map((m) => m.sig) };
}

export const concat = concatHex;
