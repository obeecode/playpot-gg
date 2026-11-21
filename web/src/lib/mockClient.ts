import type { GameClient } from './gameClient';
import type {
  Account, GameId, MatchState, Mark, Offer, PlayerProfile, SettleAction,
} from './types';
import { boardAt, mockOpponentMove, outcome } from '../games/tictactoe';

const delay = (ms = 120) => new Promise((r) => setTimeout(r, ms));
const uid = () => Math.random().toString(36).slice(2, 8);
const fakeHash = () => '0x' + Array.from({ length: 4 }, () => Math.random().toString(16).slice(2, 6)).join('').slice(0, 4) + '…' + Math.random().toString(16).slice(2, 5);

/** In-memory stand-in so the UI runs with no chain and no server. */
export class MockClient implements GameClient {
  private balance = 250;
  private offers: Offer[] = [
    { id: 'o1', game: 'tic-tac-toe', owner: 'nova_7', stake: 5, pot: 10, settleWindowMin: 30 },
    { id: 'o2', game: 'tic-tac-toe', owner: 'kestrel', stake: 10, pot: 20, settleWindowMin: 30 },
    { id: 'o3', game: 'tic-tac-toe', owner: 'ottoline', stake: 10, pot: 20, settleWindowMin: 30 },
    { id: 'o4', game: 'tic-tac-toe', owner: 'bluejay', stake: 25, pot: 50, settleWindowMin: 30 },
    { id: 'o5', game: 'tic-tac-toe', owner: 'deep_roots', stake: 500, pot: 1000, settleWindowMin: 30 },
  ];
  private matches = new Map<string, MatchState>();
  private subs = new Map<string, Set<(m: MatchState) => void>>();

  private account(): Account {
    return { address: '0x7a3f00000000000000000000000000000000c91', short: '0x7a3f…c91', balance: this.balance };
  }
  async getAccount() { await delay(); return this.account(); }
  async mintTestTokens() { await delay(); this.balance += 100; return this.account(); }

  async listOffers(game: GameId) { await delay(); return this.offers.filter((o) => o.game === game); }
  async createOffer(game: GameId, stake: number) {
    await delay();
    if (stake <= 0 || stake > this.balance) throw new Error('Stake must be between 1 and your balance.');
    this.balance -= stake;
    const o: Offer = { id: 'o' + uid(), game, owner: 'you', stake, pot: stake * 2, settleWindowMin: 30 };
    this.offers = [o, ...this.offers];
    return o;
  }

  async getPlayer(handle: string): Promise<PlayerProfile> {
    await delay();
    const isYou = handle === 'you';
    const own = this.offers.filter((o) => o.owner === handle && o.game === 'tic-tac-toe');
    return {
      handle,
      address: isYou ? this.account().address : '0x91c2000000000000000000000000000000004be0',
      isYou,
      games: [
        ...own.slice(0, 1).map((o) => ({ game: o.game, stake: o.stake, settleWindowMin: o.settleWindowMin, offerId: o.id })),
        { game: 'chess' as GameId, stake: 25, settleWindowMin: 30 },
      ],
      recent: [
        { id: 'demo', vs: 'nova_7', result: 'won', pot: 20 },
        { id: 'demo', vs: 'ottoline', result: 'draw', pot: 10 },
        { id: 'demo', vs: 'bluejay', result: 'lost', pot: 50 },
      ],
    };
  }

  async challenge(offerId: string) {
    await delay(300);
    const o = this.offers.find((x) => x.id === offerId);
    if (!o) throw new Error('That offer is gone.');
    if (o.stake > this.balance) throw new Error('Not enough test tokens.');
    this.balance -= o.stake;
    this.offers = this.offers.filter((x) => x.id !== offerId);
    const id = 'm' + uid();
    this.matches.set(id, {
      id, game: o.game,
      you: { handle: 'you', mark: 'X' }, opponent: { handle: o.owner, mark: 'O' },
      stake: o.stake, pot: o.pot, moves: [], status: 'playing', waiting: false,
      settlement: 'open', settleWindowMin: o.settleWindowMin, logHash: fakeHash(),
    });
    return id;
  }

  async getMatch(id: string) {
    await delay();
    const m = this.matches.get(id) ?? this.demoMatch(id);
    return m;
  }
  /** Opening /match/demo directly gives a fresh game against kestrel. */
  private demoMatch(id: string): MatchState {
    const m: MatchState = {
      id, game: 'tic-tac-toe',
      you: { handle: 'you', mark: 'X' }, opponent: { handle: 'kestrel', mark: 'O' },
      stake: 10, pot: 20, moves: [], status: 'playing', waiting: false,
      settlement: 'open', settleWindowMin: 30, logHash: fakeHash(),
    };
    this.matches.set(id, m);
    return m;
  }

  subscribeMatch(id: string, cb: (m: MatchState) => void) {
    const set = this.subs.get(id) ?? new Set();
    set.add(cb);
    this.subs.set(id, set);
    return () => { set.delete(cb); };
  }
  private push(m: MatchState) {
    this.matches.set(m.id, m);
    this.subs.get(m.id)?.forEach((cb) => cb(m));
  }

  async makeMove(id: string, cell: number) {
    const m = this.matches.get(id);
    if (!m || m.status !== 'playing' || m.waiting) return;
    if (boardAt(m.moves, m.moves.length)[cell]) return;
    const moves = [...m.moves, { mark: m.you.mark, cell }];
    const res = outcome(boardAt(moves, moves.length));
    if (res) { this.push(this.finish(m, moves, res)); return; }
    this.push({ ...m, moves, waiting: true });
    setTimeout(() => {
      const cur = this.matches.get(id);
      if (!cur) return;
      const b = boardAt(cur.moves, cur.moves.length);
      const oc = mockOpponentMove(b, cur.opponent.mark, cur.you.mark);
      const mv = [...cur.moves, { mark: cur.opponent.mark as Mark, cell: oc }];
      const r2 = outcome(boardAt(mv, mv.length));
      this.push(r2 ? this.finish(cur, mv, r2) : { ...cur, moves: mv, waiting: false });
    }, 650);
  }
  private finish(m: MatchState, moves: MatchState['moves'], res: Mark | 'draw'): MatchState {
    const status = res === 'draw' ? 'draw' : res === m.you.mark ? 'won' : 'lost';
    return { ...m, moves, status, waiting: false, logHash: fakeHash() };
  }

  async settle(id: string, action: SettleAction) {
    await delay(250);
    const m = this.matches.get(id);
    if (!m) return;
    if (action === 'claim') this.balance += m.status === 'won' ? m.pot : m.stake;
    const settlement = action === 'claim' ? 'claimed' : action === 'sign' ? 'signed' : 'disputed';
    this.push({ ...m, settlement });
  }
}
