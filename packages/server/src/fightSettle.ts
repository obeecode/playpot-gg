// Settling staked Fight matches: the basic rules for deciding an outcome from a replay, the referee's EIP-712 result signature for
// FightEscrow, and the adapter that reads matches from the chain and submits the result. The rules below are the interim ones;
// the launch rules will replace decideOutcome without touching the rest.
import { hashTypedData, type Address, type Hex, type LocalAccount } from "viem";
import { fightEscrowAbi } from "@playpot/game";
import { Chain } from "./chain.ts";
import { recoverJoin, type FightReplay } from "./fightLog.ts";

export const OUTCOME_P1 = 1; // the host (player 1, the offer's creator) wins
export const OUTCOME_P2 = 2; // the guest (player 2, the challenger) wins
export const OUTCOME_VOID = 3; // both stakes back, no rake
export type FightOutcome = typeof OUTCOME_P1 | typeof OUTCOME_P2 | typeof OUTCOME_VOID;

/** A player who leaves a match that has really started forfeits it. Before this much play, a leaver just voids the match. */
export const MIN_PLAYED_FRAMES = 600; // ten seconds of fighting, or a whole round finished

export interface Decision {
  outcome: FightOutcome;
  reason: string;
}

/**
 * The interim rules, applied to what the referee's replay found and to why the record closed ("host left", "guest left"):
 *  1. A finished match whose replay is clean is won by whoever won it.
 *  2. A replay that disagrees with a state hash a client reported is voided: both stakes come back and the details are kept for
 *     review. (Naming the liar automatically comes later, once the replay has been soaked on many matches.)
 *  3. An unfinished match where one player left after real play (at least a round finished or ten seconds of fighting) is a
 *     forfeit: the player who stayed wins.
 *  4. Anything else is voided.
 */
export function decideOutcome(replay: FightReplay & { confirmedFrame?: number }, closedReason: string): Decision {
  const mismatch = replay.desync || replay.stampMismatches > 0;
  if (mismatch) return { outcome: OUTCOME_VOID, reason: "the replay disagreed with a reported state hash: refunded for review" };
  if (replay.finished && replay.winner && replay.stampsChecked > 0) {
    return { outcome: replay.winner === "host" ? OUTCOME_P1 : OUTCOME_P2, reason: "completed" };
  }
  const leaver = /^(host|guest) left/.exec(closedReason)?.[1];
  const played = replay.rounds >= 2 || replay.score[0] + replay.score[1] > 0 || (replay.confirmedFrame ?? 0) >= MIN_PLAYED_FRAMES;
  if (leaver && played) return { outcome: leaver === "host" ? OUTCOME_P2 : OUTCOME_P1, reason: `forfeit: the ${leaver} left an unfinished match` };
  return { outcome: OUTCOME_VOID, reason: leaver ? `the ${leaver} left before the match got going: refunded` : "the match did not finish: refunded" };
}

// ---- the signature the contract checks ----

export const fightDomain = (chainId: number, escrow: Address) => ({ name: "PlayPotFight", version: "1", chainId, verifyingContract: escrow }) as const;

export const FIGHT_RESULT_TYPES = {
  FightResult: [
    { name: "matchId", type: "uint256" },
    { name: "outcome", type: "uint8" },
    { name: "record", type: "bytes32" },
    { name: "p1Score", type: "uint8" },
    { name: "p2Score", type: "uint8" },
  ],
} as const;

export interface FightResultMsg {
  matchId: bigint;
  outcome: FightOutcome;
  record: Hex;
  p1Score: number;
  p2Score: number;
}

export const signFightResult = (a: LocalAccount, domain: ReturnType<typeof fightDomain>, m: FightResultMsg) =>
  a.signTypedData({ domain, types: FIGHT_RESULT_TYPES, primaryType: "FightResult", message: m });

export const fightResultDigest = (domain: ReturnType<typeof fightDomain>, m: FightResultMsg) =>
  hashTypedData({ domain, types: FIGHT_RESULT_TYPES, primaryType: "FightResult", message: m });

// ---- rooms for staked matches ----

/** A staked match's relay room: M plus the match id in seven digits, e.g. match 42 is room M0000042. */
export const roomForMatch = (id: bigint): string => `M${id.toString().padStart(7, "0")}`;
export const matchOfRoom = (room: string): bigint | undefined => (/^M\d{7}$/.test(room) ? BigInt(room.slice(1)) : undefined);

export type StakeStatus = "none" | "active" | "proposed" | "disputed" | "settled";
const STATUSES: StakeStatus[] = ["none", "active", "proposed", "disputed", "settled"];

export interface StakedMatch {
  id: bigint;
  p1: Address;
  p2: Address;
  key1: Address; // the host's per-match key: it signs the host's join to the relay
  key2: Address;
  referee: Address;
  status: StakeStatus;
  windowEnd: number;
}

/** What the relay needs from the chain. Tests inject a fake. */
export interface FightStakes {
  match(id: bigint): Promise<StakedMatch | undefined>;
  /** Submits the referee's result for a match; the contract opens its challenge window. */
  settle(args: { matchId: bigint; outcome: FightOutcome; record: Hex; p1Score: number; p2Score: number }): Promise<{ tx: Hex }>;
}

export interface FightChain extends FightStakes {
  /** Finalizes every proposed match whose challenge window has ended. Call it now and then. */
  finalizeDue(): Promise<bigint[]>;
  /** Looks through recent matches for results that were proposed but not yet finalized (after a restart). */
  recover(lookBack?: number): Promise<number>;
  escrow: Address;
  chainId: number;
}

/** Reads matches from, and submits the referee's results to, a deployed FightEscrow. The relayer pays gas. */
export async function createFightChain(opts: { rpcUrl: string; escrow: Address; referee: LocalAccount; relayer?: LocalAccount; now?: () => number }): Promise<FightChain> {
  const relayer = opts.relayer ?? opts.referee;
  const chain = new Chain(opts.rpcUrl, opts.escrow, relayer, fightEscrowAbi);
  await chain.init();
  const domain = fightDomain(chain.chainId, opts.escrow);
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  const pending = new Map<bigint, number>(); // proposed matches by id, with the time their window ends

  const read = async (id: bigint): Promise<StakedMatch | undefined> => {
    const m = (await chain.pub.readContract({ address: opts.escrow, abi: fightEscrowAbi, functionName: "getMatch", args: [id] })) as {
      p1: Address; p2: Address; key1: Address; key2: Address; referee: Address; status: number; windowEnd: bigint;
    };
    if (m.status === 0) return undefined;
    return { id, p1: m.p1, p2: m.p2, key1: m.key1, key2: m.key2, referee: m.referee, status: STATUSES[m.status] ?? "none", windowEnd: Number(m.windowEnd) };
  };

  return {
    escrow: opts.escrow,
    chainId: chain.chainId,
    match: read,
    async settle({ matchId, outcome, record, p1Score, p2Score }) {
      const m = await read(matchId);
      if (!m || m.status !== "active") throw new Error(`match ${matchId} is not active on the chain`);
      if (m.referee.toLowerCase() !== opts.referee.address.toLowerCase()) throw new Error(`match ${matchId} has a different referee`);
      const sigRef = await signFightResult(opts.referee, domain, { matchId, outcome, record, p1Score, p2Score });
      const tx = await chain.wallet.writeContract({
        chain: null,
        account: relayer,
        address: opts.escrow,
        abi: fightEscrowAbi,
        functionName: "settle",
        args: [matchId, { outcome, record, p1Score, p2Score }, "0x", "0x", sigRef],
      } as never);
      await chain.pub.waitForTransactionReceipt({ hash: tx });
      const after = await read(matchId);
      if (after?.status === "proposed") pending.set(matchId, after.windowEnd);
      return { tx };
    },
    async finalizeDue() {
      const done: bigint[] = [];
      if (pending.size === 0) return done;
      // the chain's clock decides when a window has ended; the wall clock is only a fallback for a chain that has been idle
      const chainNow = Number((await chain.pub.getBlock()).timestamp);
      const t = Math.max(chainNow, now());
      for (const [id, end] of [...pending]) {
        if (t < end) continue;
        const m = await read(id);
        if (!m || m.status !== "proposed") {
          pending.delete(id); // settled, disputed or finalized by someone else
          continue;
        }
        try {
          const tx = await chain.wallet.writeContract({ chain: null, account: relayer, address: opts.escrow, abi: fightEscrowAbi, functionName: "finalize", args: [id] } as never);
          await chain.pub.waitForTransactionReceipt({ hash: tx });
          pending.delete(id);
          done.push(id);
        } catch {
          // too early by the chain's own clock, someone else finalized it first, or the node hiccuped: look again next time
        }
      }
      return done;
    },
    async recover(lookBack = 200) {
      const next = (await chain.pub.readContract({ address: opts.escrow, abi: fightEscrowAbi, functionName: "nextId" })) as bigint;
      let found = 0;
      for (let id = next - 1n; id >= 1n && next - id <= BigInt(lookBack); id--) {
        const m = await read(id);
        if (m?.status === "proposed" && m.referee.toLowerCase() === opts.referee.address.toLowerCase()) {
          pending.set(id, m.windowEnd);
          found++;
        }
      }
      return found;
    },
  };
}

/** Which relay role a join signature belongs to for a staked match: the host's per-match key signs for the host, the guest's for the guest. */
export async function stakedJoinOk(m: StakedMatch, role: "host" | "guest", room: string, sig: Hex): Promise<Address | undefined> {
  if (m.status !== "active") return undefined;
  const who = await recoverJoin(room, role, sig);
  const want = role === "host" ? m.key1 : m.key2;
  return who && who.toLowerCase() === want.toLowerCase() ? who : undefined;
}
