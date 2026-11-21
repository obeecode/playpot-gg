// Shared UI types. The real game/referee code should produce these shapes
// (or be adapted to them inside a GameClient implementation).

export type GameId = 'tic-tac-toe' | 'chess';
export type Mark = 'X' | 'O';

export interface Account {
  address: string;
  short: string;
  /** Test-token balance (tPOT). */
  balance: number;
}

export interface Offer {
  id: string;
  game: GameId;
  owner: string; // player handle
  /** Each side's stake. */
  stake: number;
  /** stake * 2, before the platform fee. */
  pot: number;
  settleWindowMin: number;
}

export interface GameSetting {
  game: GameId;
  stake: number;
  settleWindowMin: number;
  /** Open, funded offer to challenge. Absent when the game is not offered. */
  offerId?: string;
}

export interface RecentMatch {
  id: string;
  vs: string;
  result: 'won' | 'lost' | 'draw';
  pot: number;
}

export interface PlayerProfile {
  handle: string;
  address: string;
  isYou: boolean;
  games: GameSetting[];
  recent: RecentMatch[];
}

/** One move. For tic-tac-toe `cell` is 0..8. Chess will need a richer move type. */
export interface Move {
  mark: Mark;
  cell: number;
}

export type MatchStatus = 'playing' | 'won' | 'lost' | 'draw';
export type Settlement = 'open' | 'signed' | 'claimed' | 'disputed';

export interface MatchState {
  id: string;
  game: GameId;
  you: { handle: string; mark: Mark };
  opponent: { handle: string; mark: Mark };
  stake: number;
  pot: number;
  moves: Move[];
  status: MatchStatus;
  /** True while waiting for the opponent (or referee) to move. */
  waiting: boolean;
  settlement: Settlement;
  settleWindowMin: number;
  /** Hash-chain head that commits to the whole game. */
  logHash: string;
}

export type SettleAction = 'claim' | 'sign' | 'dispute';
