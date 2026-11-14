// Practice mode: JINX against the bot, entirely in the browser. No wallet, no chain, no stake.
// It uses the same rules as the real game (jinx.applyTurn through replayJinx), so it teaches the real thing.
import { botPick, jinx, TURN_LIMIT_MS } from "@playpot/game";
import { replayJinx, type Replay, type TurnLike } from "./jinxUi.ts";

export type PracticePhase = "commit" | "reveal" | "gap" | "ended";

export interface Timing {
  botMinMs: number; // the bot "thinks" for a random time in this range
  botMaxMs: number;
  revealMs: number; // both locked in: the reveal beat
  gapMs: number; // after a turn: time to read the result
}
export const DEFAULT_TIMING: Timing = { botMinMs: 700, botMaxMs: 4500, revealMs: 900, gapMs: 1700 };

/** One practice match. The view reads these fields and calls tap(); onChange fires whenever they change. */
export class Practice {
  readonly bestOf: 3 | 5;
  entries: TurnLike[] = [];
  phase: PracticePhase = "commit";
  turn = 0;
  openedMs = 0;
  skewMs = 0; // always zero: the clock is local
  myPick: number | null = null; // the square I locked this turn
  botLocked = false;
  fxUntil = 0; // squares placed on the last turn animate until this time
  rep: Replay;
  private onChange: () => void;
  private rand: () => number;
  private timing: Timing;
  private now: () => number;
  private botCell = -1;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private dead = false;

  constructor(
    bestOf: 3 | 5,
    onChange: () => void,
    rand: () => number = Math.random,
    timing: Timing = DEFAULT_TIMING,
    now: () => number = Date.now,
  ) {
    this.bestOf = bestOf;
    this.onChange = onChange;
    this.rand = rand;
    this.timing = timing;
    this.now = now;
    this.rep = replayJinx([], bestOf);
    this.open();
  }

  get result(): number {
    return this.rep.result;
  }

  destroy() {
    this.dead = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  private later(fn: () => void, ms: number) {
    const t = setTimeout(() => {
      this.timers.delete(t);
      if (!this.dead) fn();
    }, ms);
    this.timers.add(t);
  }

  private open() {
    this.phase = "commit";
    this.openedMs = this.now();
    this.myPick = null;
    this.botLocked = false;
    this.botCell = -1;
    const { timing } = this;
    this.later(() => {
      // The bot decides from the board alone: it never sees my pick.
      this.botCell = botPick(this.rep.game, 2, 1, this.rand);
      this.botLocked = true;
      this.maybeReveal();
      this.onChange();
    }, timing.botMinMs + this.rand() * (timing.botMaxMs - timing.botMinMs));
    this.later(() => {
      if (this.phase === "commit" && this.myPick === null) this.resolve(); // the clock ran out: a missed pick
    }, TURN_LIMIT_MS);
    this.onChange();
  }

  /** The player taps a square. Returns false if the tap is not allowed right now. */
  tap(cell: number): boolean {
    if (this.phase !== "commit" || this.myPick !== null) return false;
    if (cell < 0 || cell >= jinx.CELLS || this.rep.game.cells[cell] !== jinx.EMPTY) return false;
    this.myPick = cell;
    this.maybeReveal();
    this.onChange();
    return true;
  }

  private maybeReveal() {
    if (this.phase !== "commit" || this.myPick === null || !this.botLocked) return;
    this.phase = "reveal";
    this.later(() => this.resolve(), this.timing.revealMs);
  }

  private resolve() {
    const bot = this.botLocked ? this.botCell : this.pickNow();
    const mine = this.myPick;
    this.entries = [
      ...this.entries,
      { a: { missed: mine === null, missKind: 0, cell: mine ?? 0 }, b: { missed: false, missKind: 0, cell: bot } },
    ];
    this.rep = replayJinx(this.entries, this.bestOf);
    this.turn = this.entries.length;
    this.fxUntil = this.now() + 700;
    if (this.rep.result !== 0) {
      this.phase = "ended";
    } else {
      this.phase = "gap";
      this.later(() => this.open(), this.timing.gapMs);
    }
    this.onChange();
  }

  /** The clock ran out before the bot "locked in" (only possible with very slow timings). */
  private pickNow(): number {
    return botPick(this.rep.game, 2, 1, this.rand);
  }
}
