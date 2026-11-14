// Pure helpers for the JINX screens: replaying a log into boards, describing a turn, and the clock maths.
import { jinx, TURN_LIMIT_MS } from "@playpot/game";

export const cellName = (i: number): string => "ABCDE"[i % 5] + (Math.floor(i / 5) + 1);

export interface Snap {
  turn: number;
  gameNumber: number;
  picks: [number | null, number | null]; // null = missed
  missKinds: [0 | 1 | undefined, 0 | 1 | undefined];
  cells: number[]; // board after this turn
  age: number[];
  death: boolean;
  outcome: jinx.GameOutcome;
  jinx: boolean;
  doubleWin: boolean;
  cleared: boolean;
  forfeit: 0 | 1 | 2;
  doubleForfeit: boolean;
  winLine: number[];
  wins: [number, number]; // games won after this turn
  draws: number;
  matchWinner: 0 | 1 | 2;
}

export interface Replay {
  snaps: Snap[];
  game: jinx.GameState; // the state the next turn will be played on
  match: jinx.MatchState;
  gameNumber: number;
  result: number; // 0 while undecided, 1/2 winner, 3 refund
}

/** What the screens need from one side of a turn. A signed log entry satisfies it, and so does a practice turn. */
export interface PickLike {
  missed: boolean;
  missKind: 0 | 1;
  cell: number;
}
export interface TurnLike {
  a: PickLike;
  b: PickLike;
}

const pickOf = (s: PickLike): number | null => (s.missed ? null : s.cell);

/** Replays the turns of a match with the shared rules. Does not check signatures; verifyJinxLog does that. */
export function replayJinx(entries: readonly TurnLike[], bestOf: 3 | 5): Replay {
  let game = jinx.newGame(false);
  let match = jinx.newMatch(bestOf);
  let gameNumber = 1;
  let result = 0;
  const snaps: Snap[] = [];
  entries.forEach((e, turn) => {
    const r = jinx.applyTurn(game, pickOf(e.a), pickOf(e.b));
    let matchWinner: 0 | 1 | 2 = 0;
    const snapGame = gameNumber;
    game = r.state;
    const board = { cells: game.cells.slice(), age: game.age.slice(), death: game.death };
    if (r.doubleForfeit) {
      result = 3;
    } else if (r.outcome !== "ongoing") {
      const rec = jinx.recordGame(match, r.outcome);
      match = rec.match;
      if (rec.winner) {
        result = rec.winner;
        matchWinner = rec.winner;
      } else {
        game = jinx.newGame(jinx.isDeathMatch(match));
        gameNumber++;
      }
    }
    if (result === 0 && turn + 1 === jinx.MAX_MATCH_TURNS) result = 3;
    snaps.push({
      turn,
      gameNumber: snapGame,
      picks: [pickOf(e.a), pickOf(e.b)],
      missKinds: [e.a.missed ? e.a.missKind : undefined, e.b.missed ? e.b.missKind : undefined],
      ...board,
      outcome: r.outcome,
      jinx: r.jinx,
      doubleWin: r.doubleWin,
      cleared: r.cleared,
      forfeit: r.forfeit,
      doubleForfeit: r.doubleForfeit,
      winLine: r.winLine,
      wins: [match.wins[0], match.wins[1]],
      draws: match.draws,
      matchWinner,
    });
  });
  return { snaps, game, match, gameNumber, result };
}

/** A short, plain description of what happened on a turn, from the viewing player's side. */
export function describeTurn(s: Snap, side: 0 | 1 | 2): { msg: string; sub: string } {
  const me = side === 2 ? 1 : 0; // index into picks
  const you = (idx: number) => (side === 0 ? (idx === 0 ? "Player 1" : "Player 2") : idx === me ? "You" : "They");
  const [a, b] = s.picks;
  const took = (idx: number, c: number | null) => (c === null ? null : `${you(idx)} took ${cellName(c)}`);
  const both = [took(0, a), took(1, b)].filter(Boolean).join(", ");
  const missed = (idx: number) => `${you(idx)} missed the clock`;
  let sub = both ? `${both}.` : "Nothing was placed.";

  if (s.doubleForfeit) return { msg: "Both players stopped picking.", sub: "The match is abandoned and both stakes are refunded." };
  if (s.jinx) return { msg: "Jinx!", sub: `Both picked ${cellName(a!)}. ${s.death ? "That square is locked for two turns." : "That square is dead."}` };
  if (s.doubleWin) return { msg: "Double win. Both lines burn.", sub: "You each finished a line on the same reveal, so those squares are dead." };
  if (s.matchWinner) {
    const w = s.matchWinner;
    const who = side === 0 ? `Player ${w}` : w === side ? "You" : "They";
    return { msg: `${who} ${who === "You" ? "win" : "wins"} the match ${Math.max(...s.wins)}–${Math.min(...s.wins)}.`, sub };
  }
  if (s.forfeit) {
    const loser = s.forfeit - 1;
    return { msg: `${you(loser)} ${you(loser) === "You" ? "forfeit" : "forfeits"} this game.`, sub: "Two missed picks in a row." };
  }
  if (s.outcome === "p1" || s.outcome === "p2") {
    const w = s.outcome === "p1" ? 0 : 1;
    return { msg: `${you(w)} ${you(w) === "You" ? "win" : "wins"} this game.`, sub };
  }
  if (s.outcome === "draw") return { msg: "Dead board. Draw.", sub: `${sub} Drawn games are replayed.` };
  if (s.cleared) return { msg: "Board full. It clears.", sub: "The death match goes on until someone wins." };
  if (a === null && b === null) return { msg: "Both missed the clock.", sub: "Nothing was placed. Miss again and the match is abandoned." };
  if (a === null) return { msg: `${missed(0)}.`, sub: `${sub} Miss again and ${you(0)} ${you(0) === "You" ? "forfeit" : "forfeits"} the game.` };
  if (b === null) return { msg: `${missed(1)}.`, sub: `${sub} Miss again and ${you(1)} ${you(1) === "You" ? "forfeit" : "forfeits"} the game.` };
  return { msg: "Pick again.", sub };
}

/** Seconds left on the clock the player sees, given the referee's open time and our offset from its clock. */
export function clockRemaining(openedMs: number, skewMs: number, localNowMs: number): number {
  const elapsed = localNowMs + skewMs - openedMs;
  return Math.max(0, Math.min(TURN_LIMIT_MS / 1000, (TURN_LIMIT_MS - elapsed) / 1000));
}

export const RING = 169.65; // circumference of the clock ring (r = 27)

/** Stake limits and rake tiers the server reads from a v2 JINX escrow (token units: 6 decimals). */
export interface Limits {
  minStake: string;
  maxStake: string;
  tiers: Array<{ floor: string; bps: number }>;
  refereeBond: string;
  refereeBondFloor: string;
}

/** The rake, in basis points, for a pot: the highest tier whose floor the pot reaches. */
export function rakeBpsFor(tiers: Limits["tiers"], pot: bigint): number {
  let bps = tiers[0]?.bps ?? 0;
  for (const t of tiers) if (pot >= BigInt(t.floor)) bps = t.bps;
  return bps;
}

const pct = (bps: number) => `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 1)}%`;
const money = (units: bigint) => (Number(units) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 2 });

/** "8.5% on pots under 500, 7% from 500, 5% from 1,000, 3% from 10,000" */
export function describeTiers(tiers: Limits["tiers"]): string {
  return tiers
    .map((t, i) => {
      const next = tiers[i + 1];
      if (i === 0 && next) return `${pct(t.bps)} on pots under ${money(BigInt(next.floor))}`;
      if (i === 0) return `${pct(t.bps)} on every pot`;
      return `${pct(t.bps)} from ${money(BigInt(t.floor))}`;
    })
    .join(", ");
}

export { money, pct };
