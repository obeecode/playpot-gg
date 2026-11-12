import type { Address, Hex, LocalAccount } from "viem";
import {
  commitmentOf,
  GRACE_MS,
  jinx,
  jinxChain,
  jinxGenesis,
  NO_PICK,
  recoverCommit,
  recoverJinxResult,
  signJinxResult,
  signMiss,
  signReceipt,
  TURN_LIMIT_MS,
  verifyJinxLog,
  ZERO32,
  type JinxDomain,
  type JinxMatchLog,
  type JinxSide,
  type JinxTurnLog,
} from "@playpot/game";

export interface JinxMatchInfo {
  matchId: bigint;
  chainId: number;
  escrow: Address;
  key1: Address;
  key2: Address;
  referee: Address;
  bestOf: 3 | 5;
}

export interface JinxRoomOptions {
  startDelayMs?: number; // before the first turn opens
  turnGapMs?: number; // between turns
  gameGapMs?: number; // after a game ends, before the next one starts
  revealMs?: number; // how long a committed player has to reveal
}

export interface Receipt {
  turn: number;
  side: 1 | 2;
  commitment: Hex;
  openedMs: string;
  recvMs: string;
  refSig: Hex;
}

/** What the host should send. `private` events go only to that side. */
export type JinxEvent =
  | { type: "open"; turn: number; openedMs: number; nowMs: number; game: number; death: boolean }
  | { type: "locked"; turn: number; side: 1 | 2 }
  | { type: "receipt"; private: 1 | 2; receipt: Receipt }
  | { type: "reveal-now"; turn: number }
  | { type: "turn"; turn: number; entry: JinxTurnLog; outcome: jinx.GameOutcome; flags: { jinx: boolean; doubleWin: boolean; cleared: boolean; forfeit: 0 | 1 | 2 } }
  | { type: "game-over"; turn: number; outcome: jinx.GameOutcome; wins: [number, number]; draws: number }
  | { type: "end"; result: number; finalHash: Hex; refSig: Hex };

interface SideState {
  commitment?: Hex;
  commitSig?: Hex;
  recvMs?: number;
  receiptSig?: Hex;
  missKind?: 0 | 1;
  atMs?: number;
  missSig?: Hex;
  cell?: number;
  salt?: Hex;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * One JINX match, driven by calls and a clock the host supplies. It opens turns, takes signed commitments, signs
 * receipts, collects reveals together, calls misses, applies the rules and signs the final result. No timers inside:
 * the host calls tick(nowMs) often, which keeps every clock rule testable.
 */
export class JinxRoom {
  readonly info: JinxMatchInfo;
  private referee: LocalAccount;
  private domain: JinxDomain;
  private opts: Required<JinxRoomOptions>;

  phase: "gap" | "commit" | "reveal" | "ended" = "gap";
  turn = 0;
  result = 0;
  finalHash?: Hex;
  refSig?: Hex;
  sig1?: Hex;
  sig2?: Hex;

  private openAt = 0;
  private openedMs = 0;
  private revealStart = 0;
  private head: Hex;
  private game: jinx.GameState = jinx.newGame(false);
  private match: jinx.MatchState;
  private gameNumber = 1;
  private sides: [SideState, SideState] = [{}, {}];
  private entries: JinxTurnLog[] = [];

  constructor(info: JinxMatchInfo, referee: LocalAccount, domain: JinxDomain, opts: JinxRoomOptions = {}) {
    this.info = info;
    this.referee = referee;
    this.domain = domain;
    this.opts = { startDelayMs: 1500, turnGapMs: 700, gameGapMs: 3000, revealMs: 4000, ...opts };
    this.head = jinxGenesis(info.matchId);
    this.match = jinx.newMatch(info.bestOf);
  }

  /** Schedules the first turn. */
  start(nowMs: number): void {
    this.openAt = nowMs + this.opts.startDelayMs;
    this.phase = "gap";
  }

  get ended(): boolean {
    return this.phase === "ended";
  }
  get bothPlayersSigned(): boolean {
    return !!this.sig1 && !!this.sig2;
  }
  get deadlineMs(): number {
    return this.openedMs + TURN_LIMIT_MS + GRACE_MS;
  }

  get log(): JinxMatchLog {
    const log: JinxMatchLog = {
      matchId: this.info.matchId.toString(),
      chainId: this.info.chainId,
      escrow: this.info.escrow,
      key1: this.info.key1,
      key2: this.info.key2,
      referee: this.info.referee,
      bestOf: this.info.bestOf,
      turns: this.entries,
    };
    if (this.phase === "ended") {
      log.result = this.result;
      log.finalHash = this.finalHash;
      log.refSig = this.refSig;
    }
    log.sig1 = this.sig1;
    log.sig2 = this.sig2;
    return log;
  }

  /** What a (re)connecting player needs to carry on. */
  snapshot(side: 1 | 2) {
    const mine = this.sides[side - 1];
    const theirs = this.sides[2 - side];
    return {
      phase: this.phase,
      turn: this.turn,
      openedMs: this.openedMs,
      game: this.gameNumber,
      death: this.game.death,
      iCommitted: mine.commitment !== undefined,
      iRevealed: mine.cell !== undefined,
      opponentCommitted: theirs.commitment !== undefined,
      receipt: mine.receiptSig && mine.commitment ? this.receiptOf(side) : undefined,
    };
  }

  private receiptOf(side: 1 | 2): Receipt {
    const s = this.sides[side - 1];
    return {
      turn: this.turn,
      side,
      commitment: s.commitment!,
      openedMs: this.openedMs.toString(),
      recvMs: String(s.recvMs),
      refSig: s.receiptSig!,
    };
  }

  // ------------------------------------------------------------------------------------------ player messages

  async commit(side: 1 | 2, turn: number, commitment: Hex, sig: Hex, nowMs: number): Promise<JinxEvent[]> {
    if (this.phase !== "commit" || turn !== this.turn) throw new Error("no commitments are open for that turn");
    const s = this.sides[side - 1];
    if (s.commitment !== undefined || s.missKind !== undefined) throw new Error("already committed or missed this turn");
    if (nowMs > this.deadlineMs) throw new Error("too late: the clock ran out");
    if (!/^0x[0-9a-fA-F]{64}$/.test(commitment)) throw new Error("bad commitment");
    const key = side === 1 ? this.info.key1 : this.info.key2;
    const signer = await recoverCommit(
      this.domain,
      { matchId: this.info.matchId, turn, commitment, prevHash: this.head },
      sig,
    ).catch(() => undefined);
    if (!signer || !same(signer, key)) throw new Error("bad commitment signature");

    s.commitment = commitment;
    s.commitSig = sig;
    s.recvMs = nowMs;
    s.receiptSig = await signReceipt(this.referee, this.domain, {
      matchId: this.info.matchId,
      turn,
      side,
      commitment,
      openedMs: BigInt(this.openedMs),
      recvMs: BigInt(nowMs),
    });
    const events: JinxEvent[] = [
      { type: "receipt", private: side, receipt: this.receiptOf(side) },
      { type: "locked", turn, side },
    ];
    return events.concat(await this.afterCommitStep(nowMs));
  }

  async reveal(side: 1 | 2, turn: number, cell: number, salt: Hex, nowMs: number): Promise<JinxEvent[]> {
    if (this.phase !== "reveal" || turn !== this.turn) throw new Error("no reveals are open for that turn");
    const s = this.sides[side - 1];
    if (s.commitment === undefined || s.missKind !== undefined || s.cell !== undefined) throw new Error("nothing to reveal");
    if (!Number.isInteger(cell) || cell < 0 || cell >= jinx.CELLS || commitmentOf(this.info.matchId, turn, cell, salt) !== s.commitment) {
      throw new Error("reveal does not match the commitment");
    }
    if (this.game.cells[cell] !== jinx.EMPTY) {
      // A commitment to an occupied square can never be a legal pick: it is treated as never revealed.
      return this.markNoReveal(side, nowMs);
    }
    s.cell = cell;
    s.salt = salt;
    return this.afterRevealStep(nowMs);
  }

  async acceptResultSig(side: 1 | 2, result: number, sig: Hex): Promise<void> {
    if (this.phase !== "ended") throw new Error("match not over");
    if (result !== this.result) throw new Error("result does not match the replayed outcome");
    const signer = await recoverJinxResult(
      this.domain,
      { matchId: this.info.matchId, result, finalHash: this.finalHash! },
      sig,
    ).catch(() => undefined);
    if (!signer || !same(signer, side === 1 ? this.info.key1 : this.info.key2)) throw new Error("bad result signature");
    if (side === 1) this.sig1 = sig;
    else this.sig2 = sig;
  }

  // ------------------------------------------------------------------------------------------------ the clock

  async tick(nowMs: number): Promise<JinxEvent[]> {
    if (this.phase === "gap" && nowMs >= this.openAt) {
      this.phase = "commit";
      this.openedMs = nowMs;
      this.sides = [{}, {}];
      return [{ type: "open", turn: this.turn, openedMs: nowMs, nowMs, game: this.gameNumber, death: this.game.death }];
    }
    if (this.phase === "commit" && nowMs >= this.deadlineMs) {
      for (const side of [1, 2] as const) {
        const s = this.sides[side - 1];
        if (s.commitment === undefined && s.missKind === undefined) await this.markMiss(side, 0, nowMs);
      }
      return this.afterCommitStep(nowMs);
    }
    if (this.phase === "reveal" && nowMs >= this.revealStart + this.opts.revealMs) {
      let events: JinxEvent[] = [];
      for (const side of [1, 2] as const) {
        const s = this.sides[side - 1];
        if (s.commitment !== undefined && s.cell === undefined && s.missKind === undefined) events = events.concat(await this.markNoReveal(side, nowMs));
      }
      return events;
    }
    return [];
  }

  // ------------------------------------------------------------------------------------------------ internals

  private async markMiss(side: 1 | 2, kind: 0 | 1, nowMs: number): Promise<void> {
    const s = this.sides[side - 1];
    s.missKind = kind;
    s.atMs = nowMs;
    s.missSig = await signMiss(this.referee, this.domain, {
      matchId: this.info.matchId,
      turn: this.turn,
      side,
      kind,
      commitment: kind === 1 ? s.commitment! : ZERO32,
      openedMs: BigInt(this.openedMs),
      atMs: BigInt(nowMs),
    });
  }

  private async markNoReveal(side: 1 | 2, nowMs: number): Promise<JinxEvent[]> {
    await this.markMiss(side, 1, nowMs);
    return this.afterRevealStep(nowMs);
  }

  /** After every commit or miss: move on once nobody can still commit. */
  private async afterCommitStep(nowMs: number): Promise<JinxEvent[]> {
    const done = this.sides.every((s) => s.commitment !== undefined || s.missKind !== undefined);
    if (!done || this.phase !== "commit") return [];
    if (this.sides.every((s) => s.commitment === undefined)) return this.resolveTurn(nowMs);
    this.phase = "reveal";
    this.revealStart = nowMs;
    return [{ type: "reveal-now", turn: this.turn }];
  }

  private async afterRevealStep(nowMs: number): Promise<JinxEvent[]> {
    const done = this.sides.every((s) => s.commitment === undefined || s.cell !== undefined || s.missKind !== undefined);
    return done && this.phase === "reveal" ? this.resolveTurn(nowMs) : [];
  }

  private sideEntry(side: 1 | 2): { entry: JinxSide; commitment: Hex; cell: number | null } {
    const s = this.sides[side - 1];
    const openedMs = String(this.openedMs);
    if (s.missKind === undefined) {
      return {
        entry: {
          missed: false,
          missKind: 0,
          cell: s.cell!,
          salt: s.salt!,
          commitment: ZERO32,
          openedMs,
          recvMs: String(s.recvMs),
          atMs: "0",
          commitSig: s.commitSig!,
          refSig: s.receiptSig!,
        },
        commitment: s.commitment!,
        cell: s.cell!,
      };
    }
    const commitment = s.missKind === 1 ? s.commitment! : ZERO32;
    return {
      entry: {
        missed: true,
        missKind: s.missKind,
        cell: 0,
        salt: ZERO32,
        commitment,
        openedMs,
        recvMs: "0",
        atMs: String(s.atMs),
        commitSig: "0x",
        refSig: s.missSig!,
      },
      commitment,
      cell: null,
    };
  }

  private async resolveTurn(nowMs: number): Promise<JinxEvent[]> {
    const a = this.sideEntry(1);
    const b = this.sideEntry(2);
    const turn = this.turn;
    this.head = jinxChain(this.head, turn, a.commitment, b.commitment, a.cell ?? NO_PICK, b.cell ?? NO_PICK);
    const entry: JinxTurnLog = { a: a.entry, b: b.entry };
    this.entries.push(entry);

    const r = jinx.applyTurn(this.game, a.cell, b.cell);
    this.game = r.state;
    const events: JinxEvent[] = [
      { type: "turn", turn, entry, outcome: r.outcome, flags: { jinx: r.jinx, doubleWin: r.doubleWin, cleared: r.cleared, forfeit: r.forfeit } },
    ];

    let gameOver = false;
    if (r.doubleForfeit) {
      this.result = 3;
    } else if (r.outcome !== "ongoing") {
      gameOver = true;
      const rec = jinx.recordGame(this.match, r.outcome);
      this.match = rec.match;
      events.push({ type: "game-over", turn, outcome: r.outcome, wins: rec.match.wins, draws: rec.match.draws });
      if (rec.winner) this.result = rec.winner;
      else {
        this.game = jinx.newGame(jinx.isDeathMatch(this.match));
        this.gameNumber++;
      }
    }
    if (this.result === 0 && turn + 1 === jinx.MAX_MATCH_TURNS) this.result = 3;

    if (this.result !== 0) {
      this.phase = "ended";
      this.finalHash = this.head;
      this.refSig = await signJinxResult(this.referee, this.domain, { matchId: this.info.matchId, result: this.result, finalHash: this.head });
      events.push({ type: "end", result: this.result, finalHash: this.head, refSig: this.refSig });
      return events;
    }
    this.turn++;
    this.sides = [{}, {}];
    this.phase = "gap";
    this.openAt = nowMs + (gameOver ? this.opts.gameGapMs : this.opts.turnGapMs);
    return events;
  }

  /** Re-checks the whole log with the same code anyone else would use. */
  verify() {
    return verifyJinxLog(this.log);
  }
}
