import type { Address, Hex } from "viem";
import type { LoggedMove, MatchLog } from "./protocol.ts";
import type { JinxMatchLog } from "./jinxProtocol.ts";

// Client -> server
export type ClientMsg =
  | { type: "join"; matchId: string }
  | { type: "move"; matchId: string; index: number; cell: number; sig: Hex }
  | { type: "result-sig"; matchId: string; side: 1 | 2; result: number; sig: Hex }
  | { type: "jinx-join"; matchId: string; side?: 1 | 2 }
  | { type: "jinx-commit"; matchId: string; turn: number; commitment: Hex; sig: Hex }
  | { type: "jinx-reveal"; matchId: string; turn: number; cell: number; salt: Hex }
  | { type: "jinx-result-sig"; matchId: string; side: 1 | 2; result: number; sig: Hex };

// Server -> client
export type ServerMsg =
  | { type: "state"; log: MatchLog; status: "active" | "ended" | "settled"; settleTx?: Hex; settleMode?: string }
  | { type: "event"; matchId: string; move: LoggedMove }
  | { type: "end"; matchId: string; result: number; finalHash: Hex; refSig: Hex }
  | { type: "settled"; matchId: string; tx: Hex; mode: "instant" | "window" }
  | { type: "error"; message: string }
  | {
      type: "jinx-state";
      matchId: string;
      nowMs: number;
      log: JinxMatchLog;
      snapshot?: unknown;
      started: boolean;
      settleTx?: Hex;
      settleMode?: string;
    }
  | { type: "jinx-event"; matchId: string; nowMs: number; event: unknown }
  | { type: "jinx-settled"; matchId: string; tx: Hex; mode: "instant" | "window" };

// One snapshot of everything the client lists, so a refresh is a single request. Big numbers are decimal strings.
export interface StateOffer {
  bestOf?: number; // JINX offers
  creator: Address;
  sessionKey: Address;
  stake: string;
  expiry: string;
  open: boolean;
}
export interface StateMatch {
  bestOf?: number;
  p1: Address;
  p2: Address;
  stake: string;
  status: number;
  deadline: string;
  windowEnd: string;
  proposedResult: number;
  disputer: Address;
  bond: string;
  bestLen: number;
}
export interface StateResponse {
  now: string;
  bond: string;
  nextId: string;
  rows: Array<{ id: string; offer: StateOffer; match: StateMatch }>;
  account?: { eth: string; tokens: string; allowance: string; claimable: string };
  view?: StateMatch;
}
