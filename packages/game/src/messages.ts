import type { Address, Hex } from "viem";
import type { LoggedMove, MatchLog } from "./protocol.ts";

// Client -> server
export type ClientMsg =
  | { type: "join"; matchId: string }
  | { type: "move"; matchId: string; index: number; cell: number; sig: Hex }
  | { type: "result-sig"; matchId: string; side: 1 | 2; result: number; sig: Hex };

// Server -> client
export type ServerMsg =
  | { type: "state"; log: MatchLog; status: "active" | "ended" | "settled"; settleTx?: Hex; settleMode?: string }
  | { type: "event"; matchId: string; move: LoggedMove }
  | { type: "end"; matchId: string; result: number; finalHash: Hex; refSig: Hex }
  | { type: "settled"; matchId: string; tx: Hex; mode: "instant" | "window" }
  | { type: "error"; message: string };

// One snapshot of everything the client lists, so a refresh is a single request. Big numbers are decimal strings.
export interface StateOffer {
  creator: Address;
  sessionKey: Address;
  stake: string;
  expiry: string;
  open: boolean;
}
export interface StateMatch {
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
