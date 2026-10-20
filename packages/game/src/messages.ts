import type { Hex } from "viem";
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
