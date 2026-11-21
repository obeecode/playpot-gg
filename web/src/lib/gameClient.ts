import type {
  Account, GameId, MatchState, Offer, PlayerProfile, SettleAction,
} from './types';

/**
 * The only thing the UI knows about the backend.
 *
 * To connect the real games: implement this interface (wallet + PotEscrow +
 * WebSocket referee) and pass it to <ClientProvider client={...}> in main.tsx.
 * No page needs to change.
 */
export interface GameClient {
  getAccount(): Promise<Account>;
  /** Free test-token faucet. */
  mintTestTokens(): Promise<Account>;

  listOffers(game: GameId): Promise<Offer[]>;
  /** Funds the stake and publishes an offer. */
  createOffer(game: GameId, stake: number): Promise<Offer>;
  getPlayer(handle: string): Promise<PlayerProfile>;

  /**
   * One atomic click: pulls the challenger's matching stake and, after one
   * wallet signature (per-match session key), starts the match. Returns match id.
   */
  challenge(offerId: string): Promise<string>;

  getMatch(matchId: string): Promise<MatchState>;
  /** Calls back with every new state. Returns an unsubscribe function. */
  subscribeMatch(matchId: string, cb: (m: MatchState) => void): () => void;
  /** Signed silently by the session key. `cell` is the game-specific move. */
  makeMove(matchId: string, cell: number): Promise<void>;
  settle(matchId: string, action: SettleAction): Promise<void>;
}
