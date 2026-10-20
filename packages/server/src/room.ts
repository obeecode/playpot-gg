import type { Address, Hex, LocalAccount } from "viem";
import {
  applyMove,
  chainHash,
  genesisHash,
  initialBoard,
  ONGOING,
  recoverMove,
  recoverResult,
  signEvent,
  signResult,
  verifyLog,
  type Board,
  type Domain,
  type LoggedMove,
  type MatchLog,
  type Outcome,
} from "@playpot/game";

export interface MatchInfo {
  matchId: bigint;
  chainId: number;
  escrow: Address;
  key1: Address;
  key2: Address;
  referee: Address;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** One authoritative game: validates, orders, hash-chains and countersigns every move. */
export class Room {
  readonly info: MatchInfo;
  readonly log: MatchLog;
  private board: Board = initialBoard();
  private head: Hex;
  private outcome: Outcome = ONGOING;
  private referee: LocalAccount;
  private domain: Domain;
  settled = false;
  settleTx?: Hex;
  settleMode?: string;

  constructor(info: MatchInfo, referee: LocalAccount, domain: Domain, restored?: MatchLog) {
    this.info = info;
    this.referee = referee;
    this.domain = domain;
    this.head = genesisHash(info.matchId);
    this.log = {
      matchId: info.matchId.toString(),
      chainId: info.chainId,
      escrow: info.escrow,
      key1: info.key1,
      key2: info.key2,
      referee: info.referee,
      moves: [],
    };
    if (restored) this.restore(restored);
  }

  private restore(saved: MatchLog) {
    for (const mv of saved.moves) {
      ({ board: this.board, outcome: this.outcome } = applyMove(this.board, mv.cell));
      this.head = chainHash(this.head, mv.cell);
      this.log.moves.push(mv);
    }
    if (saved.result !== undefined) {
      this.log.result = saved.result;
      this.log.finalHash = saved.finalHash;
      this.log.refSig = saved.refSig;
    }
    this.log.sig1 = saved.sig1;
    this.log.sig2 = saved.sig2;
  }

  get ended(): boolean {
    return this.outcome !== ONGOING;
  }
  get result(): Outcome {
    return this.outcome;
  }
  get finalHash(): Hex {
    return this.head;
  }

  /** Accepts the next move if it is signed by the side to move and legal. */
  async acceptMove(index: number, cell: number, sig: Hex, nowMs: number): Promise<LoggedMove> {
    if (this.ended) throw new Error("game is over");
    if (index !== this.log.moves.length) throw new Error(`expected move index ${this.log.moves.length}`);
    const signer = await recoverMove(
      this.domain,
      { matchId: this.info.matchId, index, cell, prevHash: this.head },
      sig,
    ).catch(() => undefined);
    const expected = index % 2 === 0 ? this.info.key1 : this.info.key2;
    if (!signer || !same(signer, expected)) throw new Error("bad signature for the side to move");

    const next = applyMove(this.board, cell); // throws on illegal moves
    const hash = chainHash(this.head, cell);
    const recvMs = BigInt(nowMs);
    const serverSig = await signEvent(this.referee, this.domain, {
      matchId: this.info.matchId,
      index,
      cell,
      hash,
      recvMs,
    });
    this.board = next.board;
    this.outcome = next.outcome;
    this.head = hash;
    const move: LoggedMove = { index, cell, sig, hash, recvMs: recvMs.toString(), serverSig };
    this.log.moves.push(move);
    return move;
  }

  /** Referee signature over the final result. Only once the game is over. */
  async signFinal(): Promise<{ result: number; finalHash: Hex; refSig: Hex }> {
    if (!this.ended) throw new Error("game not over");
    const refSig = await signResult(this.referee, this.domain, {
      matchId: this.info.matchId,
      result: this.outcome,
      finalHash: this.head,
    });
    this.log.result = this.outcome;
    this.log.finalHash = this.head;
    this.log.refSig = refSig;
    return { result: this.outcome, finalHash: this.head, refSig };
  }

  async acceptResultSig(side: 1 | 2, result: number, sig: Hex): Promise<void> {
    if (!this.ended) throw new Error("game not over");
    if (result !== this.outcome) throw new Error("result does not match the replayed outcome");
    const signer = await recoverResult(
      this.domain,
      { matchId: this.info.matchId, result, finalHash: this.head },
      sig,
    ).catch(() => undefined);
    if (!signer || !same(signer, side === 1 ? this.info.key1 : this.info.key2)) throw new Error("bad result signature");
    if (side === 1) this.log.sig1 = sig;
    else this.log.sig2 = sig;
  }

  get bothPlayersSigned(): boolean {
    return !!this.log.sig1 && !!this.log.sig2;
  }

  verify() {
    return verifyLog(this.log);
  }
}
