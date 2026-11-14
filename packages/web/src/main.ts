import "./style.css";
import {
  createPublicClient,
  createWalletClient,
  custom,
  defineChain,
  formatEther,
  formatUnits,
  http,
  parseEventLogs,
  parseUnits,
  toHex,
  type Address,
  type Chain,
  type Hex,
  type LocalAccount,
  type PublicClient,
  type WalletClient,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  applyMove,
  chainHash,
  commitmentOf,
  eip712Domain,
  genesisHash,
  initialBoard,
  jinxChain,
  jinxDomain,
  jinxEscrowV2Abi,
  jinxGenesis,
  NO_PICK,
  potEscrowAbi,
  signCommit,
  signJinxResult,
  toContractTurns,
  verifyJinxLog,
  ZERO32,
  type JinxMatchLog,
  type JinxSide,
  type JinxTurnLog,
  replayArgs,
  signMove,
  signResult,
  testTokenAbi,
  toGrid,
  verifyLog,
  type ClientMsg,
  type MatchLog,
  type ServerMsg,
  type StateMatch,
  type StateResponse,
} from "@playpot/game";
import { cellName, clockRemaining, describeTiers, describeTurn, money, pct, rakeBpsFor, replayJinx, RING, type Limits } from "./jinxUi.ts";
import { Practice } from "./practice.ts";

// ------------------------------------------------------------------------------- types & state

interface Config {
  chainId: number;
  escrow: Address;
  token: Address;
  referee: Address;
  rpcUrl: string;
  jinx?: { escrow: Address; token: Address; limits?: Limits };
}
interface Offer {
  bestOf?: number;
  id: bigint;
  creator: Address;
  stake: bigint;
  expiry: bigint;
  open: boolean;
}
interface OnChain {
  bestOf?: number;
  p1: Address;
  p2: Address;
  stake: bigint;
  status: number;
  deadline: bigint;
  windowEnd: bigint;
  proposedResult: number;
  disputer: Address;
  bond: bigint;
  bestLen: number;
}
interface MatchView {
  id: bigint;
  ws: WebSocket | null;
  log: MatchLog | null;
  verify: { ok: boolean; errors: string[] } | null;
  sk: LocalAccount | null;
  resultSent: boolean;
  pending: boolean;
  settled: string;
  error: string;
  step: number | null;
  onchain: OnChain | null;
}

const STATUS = ["none", "active", "proposed (challenge window)", "disputed (replay window)", "settled"];
const RESULT = ["-", "Player 1 (X) wins", "Player 2 (O) wins", "Draw"];

const S = {
  serverUrl: "",
  cfg: null as Config | null,
  chain: null as Chain | null,
  pub: null as PublicClient | null,
  wallet: null as WalletClient | null,
  acct: null as Address | LocalAccount | null,
  addr: null as Address | null,
  burner: false,
  eth: 0n,
  tokens: 0n,
  allowance: 0n,
  claimable: 0n,
  bond: 0n,
  now: 0n,
  offers: [] as Offer[],
  mine: [] as Array<{ id: bigint; m: OnChain }>,
  view: null as MatchView | null,
  msg: "",
  busy: false,
  needAcct: true, // balances are fetched only when something changed
  lastAcct: 0,
  build: "",
  stakeInput: "10",
  game: (localStorage.getItem("playpot:game") === "jinx" ? "jinx" : "ttt") as "ttt" | "jinx",
  bestOfInput: 3 as 3 | 5,
  jview: null as JinxView | null,
  practice: null as Practice | null,
  practiceBestOf: 3 as 3 | 5,
  practiceClock: undefined as ReturnType<typeof setInterval> | undefined,
};

/** The escrow, token and ABI of the game the player is looking at. */
const G = () =>
  S.game === "jinx" && S.cfg?.jinx
    ? { escrow: S.cfg.jinx.escrow, token: S.cfg.jinx.token, abi: jinxEscrowV2Abi as unknown }
    : { escrow: S.cfg!.escrow, token: S.cfg!.token, abi: potEscrowAbi as unknown };

const params = new URLSearchParams(location.search);
const app = document.getElementById("app")!;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const tok = (n: bigint) => formatUnits(n, 6);
const same = (a?: string | null, b?: string | null) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
const wsUrl = (u: string) => u.replace(/^http/, "ws");
const transport = (url: string) => http(url, { timeout: 30_000, retryCount: 2, batch: { wait: 25 } });
const toOnChain = (m: StateMatch): OnChain => ({
  bestOf: m.bestOf,
  p1: m.p1,
  p2: m.p2,
  stake: BigInt(m.stake),
  status: m.status,
  deadline: BigInt(m.deadline),
  windowEnd: BigInt(m.windowEnd),
  proposedResult: m.proposedResult,
  disputer: m.disputer,
  bond: BigInt(m.bond),
  bestLen: m.bestLen,
});

// ----------------------------------------------------------------------------------- chain helpers

const read = <T,>(address: Address, abi: unknown, functionName: string, args: unknown[] = []) =>
  S.pub!.readContract({ address, abi, functionName, args } as never) as Promise<T>;

async function write(address: Address, abi: unknown, functionName: string, args: unknown[]) {
  // The local chain's fees are known, so skip the estimation round trips (each can take seconds over a tunnel).
  const local = S.cfg!.chainId === 31337;
  const hash = await S.wallet!.writeContract({
    chain: S.chain!,
    account: S.acct!,
    address,
    abi,
    functionName,
    args,
    ...(local ? { gas: 1_500_000n, maxFeePerGas: 10_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n } : {}),
  } as never);
  return S.pub!.waitForTransactionReceipt({ hash, pollingInterval: local ? 700 : 2000 });
}
const escrowWrite = (fn: string, args: unknown[]) => write(G().escrow, G().abi, fn, args);

const acctSig = () => `${S.eth}:${S.tokens}:${S.allowance}:${S.claimable}`;

/**
 * After something that changed our balances (our own transaction, a payout), read them again until they actually
 * differ. The server reuses a read younger than a second, so the first look can be the old numbers.
 */
async function refreshAfterChange() {
  const before = acctSig();
  for (let i = 0; i < 4; i++) {
    S.needAcct = true;
    await refresh();
    if (acctSig() !== before) return;
    await new Promise((r) => setTimeout(r, 1200));
  }
}

async function run(label: string, fn: () => Promise<void>) {
  S.busy = true;
  S.msg = `${label}…`;
  render();
  let ok = false;
  try {
    await fn();
    ok = true;
    S.msg = `${label}: done`;
  } catch (e) {
    S.msg = `${label} failed: ${((e as { shortMessage?: string }).shortMessage ?? (e as Error).message).slice(0, 240)}`;
  }
  S.busy = false;
  if (ok) await refreshAfterChange();
  else await refresh();
}

const skKey = (id: bigint) => `playpot:sk:${S.cfg!.chainId}:${G().escrow}:${id}:${S.addr}`.toLowerCase();
const saveSk = (id: bigint, pk: Hex) => localStorage.setItem(skKey(id), pk);
const loadSk = (id: bigint): LocalAccount | null => {
  const pk = localStorage.getItem(skKey(id)) as Hex | null;
  return pk ? privateKeyToAccount(pk) : null;
};

// -------------------------------------------------------------------------------------- bootstrap

async function init() {
  S.serverUrl =
    params.get("server") ||
    (import.meta.env.VITE_SERVER_URL as string | undefined) ||
    (import.meta.env.PROD ? location.origin : localStorage.getItem("playpot:server")) ||
    "http://127.0.0.1:8787";
  try {
    const cfg = (await (await fetch(`${S.serverUrl}/config`)).json()) as Config;
    S.cfg = cfg;
    S.chain = defineChain({
      id: cfg.chainId,
      name: cfg.chainId === 84532 ? "Base Sepolia" : `chain ${cfg.chainId}`,
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [cfg.rpcUrl] } },
      contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
    });
    S.pub = createPublicClient({ chain: S.chain, transport: transport(cfg.rpcUrl) });
    localStorage.setItem("playpot:server", S.serverUrl);
    if (S.game === "jinx" && !cfg.jinx) S.game = "ttt";
    fetch(`${S.serverUrl}/manifest.json`).then((r) => r.json()).then((m: { root?: string }) => { S.build = (m.root ?? "").slice(0, 12); render(); }).catch(() => {});
    if (params.has("burner") || !window.ethereum) await connect(true);
  } catch (e) {
    S.msg = `Cannot reach the referee server at ${S.serverUrl}: ${(e as Error).message}`;
  }
  render();
  if (params.has("practice")) startPractice();
  await refresh();
  // The lobby snapshot is cached on the server, so polling it is cheap. Hidden tabs do not poll at all.
  setInterval(() => {
    if (!document.hidden && !S.practice) void refresh();
  }, 5000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      S.needAcct = true;
      void refresh();
    }
  });
}

async function connect(burner: boolean) {
  if (!S.cfg || !S.chain) return;
  if (burner) {
    const name = params.get("burner") || "default";
    const key = `playpot:burner:${name}`;
    let pk = localStorage.getItem(key) as Hex | null;
    if (!pk) {
      pk = generatePrivateKey();
      localStorage.setItem(key, pk);
    }
    const account = privateKeyToAccount(pk);
    S.burner = true;
    S.needAcct = true;
    S.acct = account;
    S.addr = account.address;
    S.wallet = createWalletClient({ account, chain: S.chain, transport: transport(S.cfg.rpcUrl) });
    return;
  }
  const eth = window.ethereum!;
  const [addr] = (await eth.request({ method: "eth_requestAccounts" })) as Address[];
  const hexId = `0x${S.cfg.chainId.toString(16)}`;
  try {
    await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hexId }] });
  } catch (e) {
    if ((e as { code?: number }).code === 4902) {
      await eth.request({
        method: "wallet_addEthereumChain",
        params: [{ chainId: hexId, chainName: S.chain.name, rpcUrls: [S.cfg.rpcUrl], nativeCurrency: S.chain.nativeCurrency }],
      });
    } else throw e;
  }
  S.burner = false;
  S.needAcct = true;
  S.acct = addr;
  S.addr = addr;
  S.wallet = createWalletClient({ account: addr, chain: S.chain, transport: custom(eth) });
}

async function refresh() {
  if (!S.cfg) return;
  try {
    const q = new URLSearchParams();
    if (S.addr) q.set("addr", S.addr);
    const wantAcct = !!S.addr && (S.needAcct || Date.now() - S.lastAcct > 60_000);
    q.set("acct", wantAcct ? "1" : "0");
    if (S.needAcct) q.set("fresh", "1");
    if (S.game === "jinx") q.set("game", "jinx");
    const watching = S.view?.id ?? S.jview?.id;
    if (watching !== undefined) q.set("match", watching.toString());
    const res = await fetch(`${S.serverUrl}/state?${q}`, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`state ${res.status}`);
    const st = (await res.json()) as StateResponse;
    S.now = BigInt(st.now);
    S.bond = BigInt(st.bond);
    if (st.account) {
      S.needAcct = false;
      S.lastAcct = Date.now();
      S.eth = BigInt(st.account.eth);
      S.tokens = BigInt(st.account.tokens);
      S.allowance = BigInt(st.account.allowance);
      S.claimable = BigInt(st.account.claimable);
    }
    S.offers = st.rows
      .filter((r) => r.offer.open)
      .map((r) => ({ id: BigInt(r.id), creator: r.offer.creator, stake: BigInt(r.offer.stake), expiry: BigInt(r.offer.expiry), open: true, bestOf: r.offer.bestOf }))
      .reverse();
    S.mine = st.rows
      .filter((r) => r.match.status !== 0 && S.addr && (same(r.match.p1, S.addr) || same(r.match.p2, S.addr)))
      .map((r) => ({ id: BigInt(r.id), m: toOnChain(r.match) }))
      .reverse();
    if (S.view && st.view) S.view.onchain = toOnChain(st.view);
    if (S.jview && st.view) S.jview.onchain = toOnChain(st.view);
    if (S.msg.startsWith("refresh failed")) S.msg = "";
  } catch (e) {
    S.msg = `refresh failed: ${(e as Error).message.slice(0, 160)}`;
  }
  render();
}

// ------------------------------------------------------------------------------------- actions

const actions: Record<string, (el: HTMLElement) => void | Promise<void>> = {
  connect: () => run("Connect wallet", () => connect(false)),
  burner: () => run("Use burner wallet", () => connect(true)),
  mint: () =>
    run("Mint 1000 test tokens", async () => {
      await write(G().token, testTokenAbi, "mint", [S.addr, 1_000_000_000n]);
    }),
  fund: () =>
    run("Dev fund", async () => {
      await (S.pub as unknown as { request: (a: unknown) => Promise<unknown> }).request({
        method: "anvil_setBalance",
        params: [S.addr, "0x8AC7230489E80000"],
      });
    }),
  claim: () =>
    run("Claim", async () => {
      await escrowWrite("claim", []);
    }),
  create: () =>
    run("Create offer", async () => {
      const stake = parseUnits(S.stakeInput || "0", 6);
      const lim = S.game === "jinx" ? S.cfg?.jinx?.limits : undefined;
      if (lim && stake < BigInt(lim.minStake)) throw new Error(`The minimum stake is ${money(BigInt(lim.minStake))} tPUSD each.`);
      if (lim && stake > BigInt(lim.maxStake)) throw new Error(`The maximum stake is ${money(BigInt(lim.maxStake))} tPUSD each for now.`);
      if (S.allowance < stake) await write(G().token, testTokenAbi, "approve", [G().escrow, 2n ** 256n - 1n]);
      const pk = generatePrivateKey();
      const expiry = S.now + 86_400n;
      const key = privateKeyToAccount(pk).address;
      const jinxGame = S.game === "jinx";
      const rcpt = await escrowWrite("createOffer", jinxGame ? [stake, expiry, key, S.bestOfInput] : [stake, expiry, key]);
      const ev = parseEventLogs({ abi: G().abi as typeof potEscrowAbi, logs: rcpt.logs, eventName: "OfferCreated" })[0];
      saveSk(ev.args.id, pk);
    }),
  cancel: (el) =>
    run("Cancel offer", async () => {
      await escrowWrite("cancelOffer", [BigInt(el.dataset.id!)]);
    }),
  challenge: (el) =>
    run("Challenge", async () => {
      const id = BigInt(el.dataset.id!);
      const stake = BigInt(el.dataset.stake!);
      if (S.allowance < stake) await write(G().token, testTokenAbi, "approve", [G().escrow, 2n ** 256n - 1n]);
      const pk = generatePrivateKey();
      await escrowWrite("challenge", [id, privateKeyToAccount(pk).address]);
      saveSk(id, pk);
      await openMatch(id);
    }),
  open: (el) => openMatch(BigInt(el.dataset.id!)),
  close: () => closeMatch(),
  dispute: () => run("Dispute", async () => void (await escrowWrite("dispute", [activeId()]))),
  finalize: () => run("Finalize", async () => void (await escrowWrite("finalize", [activeId()]))),
  finalizeDispute: () => run("Finalize dispute", async () => void (await escrowWrite("finalizeDispute", [activeId()]))),
  abort: () => run("Abort", async () => void (await escrowWrite("abort", [activeId()]))),
  submitReplay: () =>
    run("Submit replay", async () => {
      const id = activeId();
      if (S.game === "jinx") {
        const log = (await (await fetch(`${S.serverUrl}/jinx-log/${id}`)).json()) as JinxMatchLog;
        await escrowWrite("submitReplay", [id, toContractTurns(log)]);
        return;
      }
      const log = (await (await fetch(`${S.serverUrl}/log/${id}`)).json()) as MatchLog;
      const { cells, sigs } = replayArgs(log);
      await escrowWrite("submitReplay", [id, cells, sigs]);
    }),
  voidMisses: () => run("Contest false misses", () => voidFalseMisses()),
  cell: (el) => playCell(Number(el.dataset.cell)),
  jcell: (el) => void jinxTap(Number(el.dataset.cell)),
  game: (el) => switchGame(el.dataset.game === "jinx" ? "jinx" : "ttt"),
  practice: () => startPractice(),
  ptap: (el) => void S.practice?.tap(Number(el.dataset.cell)),
  pagain: () => startPractice(),
  pleave: () => leavePractice(),
  copyaddr: () => void navigator.clipboard?.writeText(S.addr ?? "").then(() => ((S.msg = "Address copied."), render())).catch(() => {}),
};

app.addEventListener("click", (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>("[data-act]");
  if (!el || el.hasAttribute("disabled")) return;
  void actions[el.dataset.act!]?.(el);
});
app.addEventListener("input", (e) => {
  const t = e.target as HTMLInputElement;
  if (t.id === "stake") {
    S.stakeInput = t.value;
    render(); // the rake preview follows what is typed; render() keeps the cursor where it was
  }
  if (t.id === "bestof") S.bestOfInput = t.value === "5" ? 5 : 3;
  if (t.id === "pbestof") S.practiceBestOf = t.value === "5" ? 5 : 3;
  if (t.id === "jstep" && S.jview) {
    S.jview.step = Number(t.value);
    render();
  }
  if (t.id === "step" && S.view) {
    S.view.step = Number(t.value);
    render();
  }
});

// ------------------------------------------------------------------------------------- match view

const activeId = (): bigint => (S.jview?.id ?? S.view?.id)!;

function switchGame(g: "ttt" | "jinx") {
  if (S.game === g || (g === "jinx" && !S.cfg?.jinx)) return;
  S.needAcct = true;
  closeMatch();
  S.game = g;
  localStorage.setItem("playpot:game", g);
  S.offers = [];
  S.mine = [];
  S.claimable = 0n;
  S.allowance = 0n;
  void refresh();
}

async function openMatch(id: bigint) {
  if (S.game === "jinx") return openJinxMatch(id);
  closeMatch();
  const v: MatchView = {
    id,
    ws: null,
    log: null,
    verify: null,
    sk: loadSk(id),
    resultSent: false,
    pending: false,
    settled: "",
    error: "",
    step: null,
    onchain: null,
  };
  S.view = v;
  await refresh();
  const connectWs = (attempt: number) => {
    const ws = new WebSocket(wsUrl(S.serverUrl));
    v.ws = ws;
    ws.onopen = () => ws.send(JSON.stringify({ type: "join", matchId: id.toString() } satisfies ClientMsg));
    ws.onmessage = (ev) => {
      if (v.error.startsWith("reconnecting")) v.error = "";
      void onServerMsg(v, JSON.parse(ev.data) as ServerMsg);
    };
    ws.onclose = () => {
      if (S.view !== v) return; // we closed it ourselves
      if (!v.settled) {
        v.error = "reconnecting to the referee…";
        setTimeout(() => S.view === v && connectWs(attempt + 1), Math.min(8000, 700 * 2 ** attempt));
      }
      render();
    };
  };
  connectWs(0);
  render();
}

function startPractice() {
  leavePractice(false);
  closeMatch();
  // ?pfast=1 shortens the bot's thinking and the pauses, for automated tests.
  const timing = params.has("pfast") ? { botMinMs: 30, botMaxMs: 120, revealMs: 120, gapMs: 120 } : undefined;
  S.practice = new Practice(S.practiceBestOf, render, Math.random, timing);
  S.practiceClock = setInterval(updateClock, 100);
  render();
}

function leavePractice(redraw = true) {
  S.practice?.destroy();
  S.practice = null;
  clearInterval(S.practiceClock);
  S.practiceClock = undefined;
  if (redraw) render();
}

function closeMatch() {
  S.view?.ws?.close();
  S.view = null;
  if (S.jview) {
    S.jview.ws?.close();
    clearInterval(S.jview.clockTimer);
    S.jview = null;
  }
  render();
}

const mySide = (v: MatchView): 0 | 1 | 2 => {
  const m = v.onchain;
  if (!m || !S.addr) return 0;
  return same(m.p1, S.addr) ? 1 : same(m.p2, S.addr) ? 2 : 0;
};

async function reverify(v: MatchView) {
  if (!v.log) return;
  const r = await verifyLog(v.log);
  v.verify = { ok: r.ok, errors: r.errors };
}

async function onServerMsg(v: MatchView, msg: ServerMsg) {
  if (S.view !== v) return;
  if (msg.type === "state" || msg.type === "event" || msg.type === "error") v.pending = false;
  if (msg.type === "event") v.error = "";
  if (msg.type === "state") {
    v.log = msg.log;
    if (msg.settleTx) v.settled = `${msg.settleMode} settlement, tx ${short(msg.settleTx)}`;
    await reverify(v);
    if (v.log.result !== undefined) await signFinal(v);
  } else if (msg.type === "event") {
    if (v.log && msg.move.index === v.log.moves.length) v.log.moves.push(msg.move);
    await reverify(v);
  } else if (msg.type === "end") {
    if (v.log) {
      v.log.result = msg.result;
      v.log.finalHash = msg.finalHash;
      v.log.refSig = msg.refSig;
    }
    await reverify(v);
    await signFinal(v);
  } else if (msg.type === "settled") {
    v.settled = `${msg.mode} settlement, tx ${short(msg.tx)}`;
    void refreshAfterChange(); // the payout changed our claimable balance
  } else if (msg.type === "error") {
    v.error = msg.message;
  }
  render();
}

/** Client-side check: only co-sign a result that matches our own replay of the log. */
async function signFinal(v: MatchView) {
  const side = mySide(v);
  if (v.resultSent || !side || !v.sk || !v.log || v.log.result === undefined || !S.cfg) return;
  if (!v.verify?.ok) {
    v.error = "refusing to sign: the log does not verify";
    return;
  }
  const matchId = v.id;
  const sig = await signResult(v.sk, eip712Domain(S.cfg.chainId, S.cfg.escrow), {
    matchId,
    result: v.log.result,
    finalHash: v.log.finalHash!,
  });
  v.resultSent = true;
  v.ws?.send(JSON.stringify({ type: "result-sig", matchId: matchId.toString(), side, result: v.log.result, sig } satisfies ClientMsg));
}

async function playCell(cell: number) {
  const v = S.view;
  if (!v?.log || !v.sk || !S.cfg) return;
  const side = mySide(v);
  const i = v.log.moves.length;
  if (v.log.result !== undefined || (i % 2 === 0 ? 1 : 2) !== side) return;
  if (v.pending) return;
  v.pending = true;
  setTimeout(() => {
    if (v.pending) {
      v.pending = false;
      render();
    }
  }, 10_000);
  render();
  const prevHash = i === 0 ? genesisHash(v.id) : v.log.moves[i - 1].hash;
  const sig = await signMove(v.sk, eip712Domain(S.cfg.chainId, S.cfg.escrow), { matchId: v.id, index: i, cell, prevHash });
  v.ws?.send(JSON.stringify({ type: "move", matchId: v.id.toString(), index: i, cell, sig } satisfies ClientMsg));
}

// ------------------------------------------------------------------------------------- JINX match view

interface JReceipt {
  turn: number;
  side: 1 | 2;
  commitment: Hex;
  openedMs: string;
  recvMs: string;
  refSig: Hex;
}
interface JinxView {
  id: bigint;
  ws: WebSocket | null;
  sk: LocalAccount | null;
  onchain: OnChain | null;
  base: Omit<JinxMatchLog, "turns"> | null;
  entries: JinxTurnLog[];
  head: Hex;
  phase: "waiting" | "commit" | "reveal" | "gap" | "ended";
  turn: number;
  openedMs: number;
  skewMs: number;
  iLocked: boolean;
  oppLocked: boolean;
  pick: { turn: number; cell: number; salt: Hex } | null;
  receipts: Record<number, JReceipt>;
  pending: boolean;
  resultSent: boolean;
  ended: { result: number; finalHash: Hex; refSig: Hex } | null;
  verify: { ok: boolean; errors: string[] } | null;
  settled: string;
  error: string;
  step: number | null;
  clockTimer: ReturnType<typeof setInterval> | undefined;
  fxUntil: number; // the squares placed on the last turn animate until this time
}

const jKey = (kind: string, id: bigint, extra = "") =>
  `playpot:j${kind}:${S.cfg!.chainId}:${S.cfg!.jinx!.escrow}:${id}:${S.addr}${extra}`.toLowerCase();
const loadReceipts = (id: bigint): Record<number, JReceipt> => {
  try {
    return JSON.parse(localStorage.getItem(jKey("rec", id)) ?? "{}");
  } catch {
    return {};
  }
};
const jmySide = (v: JinxView): 0 | 1 | 2 => {
  const m = v.onchain;
  if (!m || !S.addr) return 0;
  return same(m.p1, S.addr) ? 1 : same(m.p2, S.addr) ? 2 : 0;
};
const jBestOf = (v: JinxView): 3 | 5 => (Number(v.onchain?.bestOf ?? v.base?.bestOf ?? 3) === 5 ? 5 : 3);

function jinxAdvance(id: bigint, head: Hex, turn: number, e: JinxTurnLog): Hex {
  const one = (s: JinxSide) =>
    s.missed
      ? { commitment: s.missKind === 1 ? s.commitment : ZERO32, cell: NO_PICK }
      : { commitment: commitmentOf(id, turn, s.cell, s.salt), cell: s.cell };
  const a = one(e.a);
  const b = one(e.b);
  return jinxChain(head, turn, a.commitment, b.commitment, a.cell, b.cell);
}

async function openJinxMatch(id: bigint) {
  closeMatch();
  const v: JinxView = {
    id,
    ws: null,
    sk: loadSk(id),
    onchain: null,
    base: null,
    entries: [],
    head: jinxGenesis(id),
    phase: "waiting",
    turn: 0,
    openedMs: 0,
    skewMs: 0,
    iLocked: false,
    oppLocked: false,
    pick: null,
    receipts: loadReceipts(id),
    pending: false,
    resultSent: false,
    ended: null,
    verify: null,
    settled: "",
    error: "",
    step: null,
    clockTimer: undefined,
    fxUntil: 0,
  };
  S.jview = v;
  await refresh();
  // If the referee restarts or the connection drops, join again: it resumes the match from its saved log.
  const connectWs = (attempt: number) => {
    const ws = new WebSocket(wsUrl(S.serverUrl));
    v.ws = ws;
    ws.onopen = () => ws.send(JSON.stringify({ type: "jinx-join", matchId: id.toString(), side: jmySide(v) || undefined } satisfies ClientMsg));
    ws.onmessage = (ev) => {
      if (v.error.startsWith("reconnecting")) v.error = "";
      void onJinxMsg(v, JSON.parse(ev.data) as ServerMsg);
    };
    ws.onclose = () => {
      if (S.jview !== v) return; // we closed it ourselves
      if (!v.settled) {
        v.error = "reconnecting to the referee…";
        setTimeout(() => S.jview === v && connectWs(attempt + 1), Math.min(8000, 700 * 2 ** attempt));
      }
      render();
    };
  };
  connectWs(0);
  v.clockTimer = setInterval(updateClock, 100);
  render();
}

function sendReveal(v: JinxView) {
  const raw = v.pick ?? JSON.parse(sessionStorage.getItem(jKey("pick", v.id, `:${v.turn}`)) ?? "null");
  if (!raw || raw.turn !== v.turn) return;
  v.ws?.send(JSON.stringify({ type: "jinx-reveal", matchId: v.id.toString(), turn: v.turn, cell: raw.cell, salt: raw.salt } satisfies ClientMsg));
}

async function onJinxMsg(v: JinxView, msg: ServerMsg) {
  if (S.jview !== v) return;
  const side = jmySide(v);
  if (msg.type === "error") {
    v.pending = false;
    v.error = msg.message;
  } else if (msg.type === "jinx-settled") {
    v.settled = `${msg.mode} settlement, tx ${short(msg.tx)}`;
    void refreshAfterChange(); // the payout changed our claimable balance
  } else if (msg.type === "jinx-state") {
    v.skewMs = msg.nowMs - Date.now();
    const { turns, ...base } = msg.log;
    v.base = base;
    v.entries = turns.slice();
    v.head = v.entries.reduce((h, e, t) => jinxAdvance(v.id, h, t, e), jinxGenesis(v.id));
    if (msg.settleTx) v.settled = `${msg.settleMode} settlement, tx ${short(msg.settleTx)}`;
    const snap = msg.snapshot as
      | { phase: JinxView["phase"]; turn: number; openedMs: number; iCommitted: boolean; iRevealed: boolean; opponentCommitted: boolean }
      | undefined;
    v.phase = msg.started ? (snap?.phase ?? "gap") : "waiting";
    if (snap) {
      v.turn = snap.turn;
      v.openedMs = snap.openedMs;
      v.iLocked = snap.iCommitted;
      v.oppLocked = snap.opponentCommitted;
    }
    if (msg.log.result !== undefined) {
      v.phase = "ended";
      v.ended = { result: msg.log.result, finalHash: msg.log.finalHash!, refSig: msg.log.refSig! };
      await jinxFinish(v);
    } else if (snap?.phase === "reveal" && snap.iCommitted && !snap.iRevealed) {
      sendReveal(v);
    }
  } else if (msg.type === "jinx-event") {
    v.skewMs = msg.nowMs - Date.now();
    const e = msg.event as { type: string; turn?: number; openedMs?: number; side?: 1 | 2; receipt?: JReceipt; entry?: JinxTurnLog; result?: number; finalHash?: Hex; refSig?: Hex };
    if (e.type === "open") {
      v.phase = "commit";
      v.turn = e.turn!;
      v.openedMs = e.openedMs!;
      v.iLocked = false;
      v.oppLocked = false;
      v.pick = null;
      v.pending = false;
      v.error = "";
    } else if (e.type === "locked") {
      if (e.side === side) v.iLocked = true;
      else v.oppLocked = true;
    } else if (e.type === "receipt" && e.receipt) {
      v.receipts[e.receipt.turn] = e.receipt;
      localStorage.setItem(jKey("rec", v.id), JSON.stringify(v.receipts));
    } else if (e.type === "reveal-now") {
      v.phase = "reveal";
      sendReveal(v);
    } else if (e.type === "turn" && e.entry) {
      v.head = jinxAdvance(v.id, v.head, e.turn!, e.entry);
      v.entries.push(e.entry);
      v.fxUntil = Date.now() + 700;
      v.phase = "gap";
      v.iLocked = false;
      v.oppLocked = false;
    } else if (e.type === "end") {
      v.phase = "ended";
      v.ended = { result: e.result!, finalHash: e.finalHash!, refSig: e.refSig! };
      await jinxFinish(v);
    }
  }
  render();
}

/** Client-side check: only co-sign a result that matches our own replay of the whole log. */
async function jinxFinish(v: JinxView) {
  if (!v.base || !v.ended) return;
  const r = await verifyJinxLog({ ...v.base, turns: v.entries, result: v.ended.result, finalHash: v.ended.finalHash, refSig: v.ended.refSig });
  v.verify = { ok: r.ok, errors: r.errors };
  const side = jmySide(v);
  if (v.resultSent || !side || !v.sk || !S.cfg?.jinx) return;
  if (!r.ok) {
    v.error = "refusing to sign: the log does not verify";
    return;
  }
  const sig = await signJinxResult(v.sk, jinxDomain(S.cfg.chainId, S.cfg.jinx.escrow), { matchId: v.id, result: v.ended.result, finalHash: v.ended.finalHash });
  v.resultSent = true;
  v.ws?.send(JSON.stringify({ type: "jinx-result-sig", matchId: v.id.toString(), side, result: v.ended.result, sig } satisfies ClientMsg));
}

async function jinxTap(cell: number) {
  const v = S.jview;
  if (!v || !S.cfg?.jinx) return;
  const side = jmySide(v);
  if (!side || !v.sk || v.phase !== "commit" || v.iLocked || v.pending) return;
  if (replayJinx(v.entries, jBestOf(v)).game.cells[cell] !== 0) return;
  v.pending = true;
  const turn = v.turn;
  const salt = toHex(crypto.getRandomValues(new Uint8Array(32)));
  const commitment = commitmentOf(v.id, turn, cell, salt);
  const sig = await signCommit(v.sk, jinxDomain(S.cfg.chainId, S.cfg.jinx.escrow), { matchId: v.id, turn, commitment, prevHash: v.head });
  v.pick = { turn, cell, salt };
  sessionStorage.setItem(jKey("pick", v.id, `:${turn}`), JSON.stringify(v.pick));
  v.iLocked = true;
  v.pending = false;
  v.ws?.send(JSON.stringify({ type: "jinx-commit", matchId: v.id.toString(), turn, commitment, sig } satisfies ClientMsg));
  render();
}

/** Voids every "no commitment" miss for which we hold the referee's own signed receipt. */
async function voidFalseMisses() {
  const v = S.jview!;
  const side = jmySide(v);
  for (const r of Object.values(v.receipts)) {
    if (r.side !== side) continue;
    await escrowWrite("voidMiss", [v.id, r.turn, side, r.commitment, BigInt(r.openedMs), BigInt(r.recvMs), r.refSig]);
  }
}

function updateClock() {
  const v = S.practice ?? S.jview;
  const el = document.getElementById("clock");
  if (!v || !el) return;
  const active = v.phase === "commit";
  if (S.practice && S.practice.myPick !== null) return void setClockIdle(el);
  const rem = active ? clockRemaining(v.openedMs, v.skewMs, Date.now()) : 10;
  const n = Math.ceil(rem);
  const lvl = !active ? "idle" : n <= 3 ? "crit" : n <= 5 ? "warn" : "";
  el.className = "clock" + (lvl ? ` ${lvl}` : "");
  document.getElementById("clock-prog")?.setAttribute("stroke-dashoffset", (RING * (1 - rem / 10)).toFixed(1));
  const num = document.getElementById("clock-num");
  if (num) num.textContent = active ? String(n) : "–";
}

function setClockIdle(el: HTMLElement) {
  el.className = "clock idle";
  const num = document.getElementById("clock-num");
  if (num) num.textContent = "–";
}

// ------------------------------------------------------------------------------------ rendering

function boardAt(cells: number[]) {
  let b = initialBoard();
  for (const c of cells) b = applyMove(b, c).board;
  return b;
}

function renderMatch(v: MatchView): string {
  const m = v.onchain;
  const log = v.log;
  const side = mySide(v);
  const cells = log ? log.moves.map((x) => x.cell) : [];
  const total = cells.length;
  const step = v.step ?? total;
  const live = v.step === null || v.step === total;
  const grid = toGrid(boardAt(cells.slice(0, step)));
  const over = log?.result !== undefined;
  const myTurn = !!log && !over && (total % 2 === 0 ? 1 : 2) === side && !!v.sk && live;
  const finished = over ? RESULT[log!.result!] : "";
  const youWon = over && side && ((log!.result === 1 && side === 1) || (log!.result === 2 && side === 2));

  const status = m ? m.status : 0;
  const past = m ? S.now > m.deadline : false;
  const inWindow = m ? S.now < m.windowEnd : false;
  const btn = (act: string, label: string, enabled = true) =>
    `<button data-act="${act}" ${enabled && !S.busy ? "" : "disabled"}>${label}</button>`;
  const chainActions: string[] = [];
  if (m && status === 1 && past) chainActions.push(btn("abort", "Abort & refund both"));
  if (m && status === 2) {
    if (side) chainActions.push(btn("dispute", `Dispute (bond ${tok(S.bond)})`, inWindow));
    chainActions.push(btn("finalize", "Finalize payout", !inWindow));
  }
  if (m && status === 3) {
    chainActions.push(btn("submitReplay", "Submit signed-move replay", inWindow));
    chainActions.push(btn("finalizeDispute", "Finalize dispute", !inWindow));
  }

  return `
  <section id="match">
    <div class="row"><h2 style="margin:0">Match #${v.id}</h2><button data-act="close">Back</button></div>
    <div class="dim">${m ? `${short(m.p1)} (X) vs ${short(m.p2)} (O) &middot; stake ${tok(m.stake)} each &middot; on-chain: <b id="chain-status">${STATUS[status]}</b>` : ""}
      ${side ? `&middot; you are ${side === 1 ? "X" : "O"}` : "&middot; spectating"}</div>
    <div class="board">${grid
      .map(
        (c, i) =>
          `<button class="cell ${myTurn ? "mine" : ""}" data-act="cell" data-cell="${i}" ${myTurn && !c && !v.pending ? "" : "disabled"}>${c ?? ""}</button>`,
      )
      .join("")}</div>
    <div id="turn">${over ? `<b>${finished}</b>${youWon ? " &mdash; you won" : ""}` : myTurn ? "Your move" : log ? "Waiting for opponent" : "Connecting…"}</div>
    ${total > 0 ? `<div class="row"><span class="dim">Replay</span><input id="step" type="range" min="0" max="${total}" value="${step}" style="width:220px" /> <span class="dim">${step}/${total}</span></div>` : ""}
    <div class="dim" id="verify">${v.verify ? (v.verify.ok ? '<span class="ok">log verified: signatures, hash chain and rules all check out</span>' : `<span class="bad">log does not verify: ${esc(v.verify.errors.join("; "))}</span>`) : ""}</div>
    <div class="dim" id="settled">${v.settled ? `<span class="ok">${esc(v.settled)}</span>` : over ? "Waiting for settlement…" : ""}</div>
    ${v.error ? `<div class="bad">${esc(v.error)}</div>` : ""}
    <div class="row">${chainActions.join(" ")}</div>
    ${m && status === 2 ? `<div class="dim">Proposed: ${RESULT[m.proposedResult]}. ${inWindow ? `Window closes in ${m.windowEnd - S.now}s` : "Window closed"}.</div>` : ""}
    <div class="log mono dim">${(log?.moves ?? []).map((x) => `${x.index}: ${x.index % 2 ? "O" : "X"}→${x.cell} <span title="${x.hash}">${x.hash.slice(0, 10)}</span>`).join("<br/>")}</div>
  </section>`;
}

function renderJinxMatch(v: JinxView): string {
  const m = v.onchain;
  const side = jmySide(v);
  const bestOf = jBestOf(v);
  const rep = replayJinx(v.entries, bestOf);
  const total = rep.snaps.length;
  const step = v.step ?? total;
  const live = v.step === null || v.step === total;
  const last = step > 0 ? rep.snaps[step - 1] : undefined;
  const over = v.phase === "ended";
  const finalBoard = !!last && last.outcome !== "ongoing" && (v.phase === "gap" || over || !live);
  const board = !live || finalBoard ? last : undefined;
  const cells = board ? board.cells : live ? rep.game.cells : (last?.cells ?? rep.game.cells);
  const age = board ? board.age : rep.game.age;
  const death = board ? board.death : rep.game.death;
  const wins = last ? last.wins : ([0, 0] as [number, number]);
  const draws = last ? last.draws : 0;
  const target = (bestOf + 1) / 2;
  const gameNo = live ? rep.gameNumber : (last?.gameNumber ?? 1);

  const canTap = live && v.phase === "commit" && !v.iLocked && !v.pending && !!side && !!v.sk && !over;
  const lastPicks = last ? last.picks.filter((p): p is number => p !== null) : [];
  const myMark = side || 1;
  const names: [string, string] = side === 0 ? ["Player 1", "Player 2"] : side === 1 ? ["You", "Opponent"] : ["Opponent", "You"];
  const aLocked = side === 2 ? v.oppLocked : v.iLocked;
  const bLocked = side === 2 ? v.iLocked : v.oppLocked;

  let prompt = { msg: "", sub: "" };
  const lastDesc = last ? describeTurn(last, side) : undefined;
  if (over) {
    const r = v.ended?.result ?? rep.result;
    prompt =
      r === 3
        ? { msg: "Match abandoned. Both stakes are refunded.", sub: lastDesc?.sub ?? "" }
        : { msg: side === 0 ? `Player ${r} wins the match.` : r === side ? "You win the match." : "They win the match.", sub: lastDesc?.sub ?? "" };
  } else if (v.phase === "waiting") prompt = { msg: "Waiting for the other player to join…", sub: "The clock starts when you are both here." };
  else if (v.phase === "commit") {
    prompt = v.iLocked
      ? { msg: "Locked in.", sub: v.oppLocked ? "Both locked in. Revealing…" : "Waiting for the other player." }
      : { msg: death ? "Death match. Tap a square." : "Tap a square.", sub: death ? "Jinxed squares reopen after two turns, so this game cannot end in a draw." : "You both pick at the same moment. Neither of you can see the other's pick." };
  } else if (v.phase === "reveal") prompt = { msg: "Revealing both picks…", sub: "" };
  else if (lastDesc) prompt = { msg: lastDesc.msg, sub: lastDesc.sub };

  const status = m ? m.status : 0;
  const past = m ? S.now > m.deadline : false;
  const inWindow = m ? S.now < m.windowEnd : false;
  const btn = (act: string, label: string, enabled = true) => `<button data-act="${act}" ${enabled && !S.busy ? "" : "disabled"}>${label}</button>`;
  const heldReceipts = Object.values(v.receipts).filter((r) => r.side === side).length;
  const chainActions: string[] = [];
  if (m && status === 1 && past) chainActions.push(btn("abort", "Abort & refund both"));
  if (m && status === 2) {
    if (side) chainActions.push(btn("dispute", `Dispute (bond ${tok(S.bond)})`, inWindow));
    chainActions.push(btn("finalize", "Finalize payout", !inWindow));
  }
  if (m && status === 3) {
    chainActions.push(btn("submitReplay", "Submit signed-turn replay", inWindow));
    if (side && heldReceipts) chainActions.push(btn("voidMisses", `Contest false misses (${heldReceipts} receipts)`, inWindow));
    chainActions.push(btn("finalizeDispute", "Finalize dispute", !inWindow));
  }

  const cellHtml = cells
    .map((c, i) => {
      const cls = ["jcell"];
      if (c === 1) cls.push("a");
      else if (c === 2) cls.push("b");
      else if (c === 3) cls.push("dead");
      if (v.pick && v.pick.turn === v.turn && (v.phase === "commit" || v.phase === "reveal") && v.pick.cell === i && live) cls.push("locked");
      if (live && !(v.phase === "commit" || v.phase === "reveal") && lastPicks.includes(i)) cls.push("last");
      if (live && Date.now() < v.fxUntil && lastPicks.includes(i)) cls.push("pop");
      if (board && board.winLine.includes(i)) cls.push("win");
      const dis = !(canTap && c === 0);
      const ageAttr = death && c === 3 ? ` data-age="${age[i]}"` : "";
      return `<button class="${cls.join(" ")}" data-act="jcell" data-cell="${i}" aria-label="${cellName(i)}"${ageAttr} ${dis ? "disabled" : ""}><span class="mark"></span></button>`;
    })
    .join("");
  void myMark;

  return `
  <section id="match">
    <div class="row"><h2 style="margin:0">JINX &middot; match #${v.id}</h2><button data-act="close">Back</button></div>
    <div class="dim">${m ? `${short(m.p1)} &#9679; vs ${short(m.p2)} &#9670; &middot; stake ${tok(m.stake)} each &middot; best of ${bestOf} &middot; on-chain: <b id="chain-status">${STATUS[status]}</b>` : ""}
      ${side ? `&middot; you are ${side === 1 ? "&#9679;" : "&#9670;"}` : "&middot; spectating"}</div>
    <div class="jscore">
      <div class="jside a"><span class="jchip a"></span><span>${names[0]}</span><span class="n" id="jscore-a">${wins[0]}</span></div>
      <div class="clock idle" id="clock" role="timer" aria-label="Seconds left to pick">
        <svg viewBox="0 0 64 64" aria-hidden="true"><circle class="track" cx="32" cy="32" r="27"></circle><circle class="prog" id="clock-prog" cx="32" cy="32" r="27" transform="rotate(-90 32 32)" stroke-dasharray="${RING}" stroke-dashoffset="0"></circle></svg>
        <span class="num" id="clock-num">10</span>
      </div>
      <div class="jside b"><span class="n" id="jscore-b">${wins[1]}</span><span>${names[1]}</span><span class="jchip b"></span></div>
      <span class="jlock ${aLocked ? "on" : ""}" id="jlock-a">locked in</span><span></span><span class="jlock ${bLocked ? "on" : ""}" id="jlock-b" style="justify-self:end">locked in</span>
    </div>
    <div class="dim" id="jmeta">Game ${gameNo} &middot; first to ${target} games &middot; drawn games ${draws}${death && !over ? ' &middot; <span class="death">death match</span>' : ""}</div>
    <div class="jboard${v.phase === "reveal" ? " revealing" : ""}" id="jboard">${cellHtml}</div>
    <div class="jstatus" id="jstatus">${esc(prompt.msg)}${prompt.sub ? `<small>${esc(prompt.sub)}</small>` : ""}</div>
    ${total > 0 ? `<div class="row"><span class="dim">Replay</span><input id="jstep" type="range" min="0" max="${total}" value="${step}" style="width:220px" /> <span class="dim">turn ${step}/${total}</span></div>` : ""}
    <div class="dim" id="verify">${v.verify ? (v.verify.ok ? '<span class="ok">log verified: signatures, receipts, hash chain and rules all check out</span>' : `<span class="bad">log does not verify: ${esc(v.verify.errors.join("; "))}</span>`) : ""}</div>
    <div class="dim" id="settled">${v.settled ? `<span class="ok">${esc(v.settled)}</span>` : over ? "Waiting for settlement…" : ""}</div>
    ${v.error ? `<div class="bad">${esc(v.error)}</div>` : ""}
    <div class="row">${chainActions.join(" ")}</div>
    ${m && status === 2 ? `<div class="dim">Proposed: ${["-", "Player 1 wins", "Player 2 wins", "Refund"][m.proposedResult]}. ${inWindow ? `Window closes in ${m.windowEnd - S.now}s` : "Window closed"}.</div>` : ""}
  </section>`;
}

function renderPractice(p: Practice): string {
  const rep = p.rep;
  const total = rep.snaps.length;
  const last = total > 0 ? rep.snaps[total - 1] : undefined;
  const over = p.phase === "ended";
  const bestOf = p.bestOf;
  const board = last && last.outcome !== "ongoing" && (p.phase === "gap" || over) ? last : undefined;
  const cells = board ? board.cells : rep.game.cells;
  const age = board ? board.age : rep.game.age;
  const death = board ? board.death : rep.game.death;
  const wins = last ? last.wins : ([0, 0] as [number, number]);
  const draws = last ? last.draws : 0;
  const target = (bestOf + 1) / 2;
  const canTap = p.phase === "commit" && p.myPick === null;
  const lastPicks = last ? last.picks.filter((x): x is number => x !== null) : [];
  const showLast = p.phase === "gap" || over;
  const lastDesc = last ? describeTurn(last, 1) : undefined;

  let prompt = { msg: "", sub: "" };
  if (over) {
    const r = p.result;
    prompt =
      r === 3
        ? { msg: "Match abandoned.", sub: lastDesc?.sub ?? "" }
        : { msg: r === 1 ? "You win the match." : "The bot wins the match.", sub: lastDesc?.sub ?? "" };
  } else if (p.phase === "commit") {
    prompt =
      p.myPick !== null
        ? { msg: "Locked in.", sub: p.botLocked ? "Both locked in. Revealing…" : "Waiting for the bot." }
        : {
            msg: death ? "Death match. Tap a square." : "Tap a square.",
            sub: death ? "Jinxed squares reopen after two turns, so this game cannot end in a draw." : "You both pick at the same moment. Neither of you can see the other's pick.",
          };
  } else if (p.phase === "reveal") prompt = { msg: "Revealing both picks…", sub: "" };
  else if (lastDesc) prompt = lastDesc;

  const cellHtml = cells
    .map((c, i) => {
      const cls = ["jcell"];
      if (c === 1) cls.push("a");
      else if (c === 2) cls.push("b");
      else if (c === 3) cls.push("dead");
      if (p.myPick === i && (p.phase === "commit" || p.phase === "reveal")) cls.push("locked");
      if (showLast && lastPicks.includes(i)) cls.push("last");
      if (Date.now() < p.fxUntil && lastPicks.includes(i)) cls.push("pop");
      if (board && board.winLine.includes(i)) cls.push("win");
      const ageAttr = death && c === 3 ? ` data-age="${age[i]}"` : "";
      return `<button class="${cls.join(" ")}" data-act="ptap" data-cell="${i}" aria-label="${cellName(i)}"${ageAttr} ${canTap && c === 0 ? "" : "disabled"}><span class="mark"></span></button>`;
    })
    .join("");

  return `
  <section id="match" class="practice">
    <div class="row"><h2 style="margin:0">JINX &middot; practice vs bot</h2><button data-act="pleave" id="pleave">Leave</button></div>
    <div class="dim">Best of ${bestOf} &middot; nothing is staked and nothing goes on-chain. Same rules as the real game.</div>
    <div class="jscore">
      <div class="jside a"><span class="jchip a"></span><span>You</span><span class="n" id="jscore-a">${wins[0]}</span></div>
      <div class="clock idle" id="clock" role="timer" aria-label="Seconds left to pick">
        <svg viewBox="0 0 64 64" aria-hidden="true"><circle class="track" cx="32" cy="32" r="27"></circle><circle class="prog" id="clock-prog" cx="32" cy="32" r="27" transform="rotate(-90 32 32)" stroke-dasharray="${RING}" stroke-dashoffset="0"></circle></svg>
        <span class="num" id="clock-num">10</span>
      </div>
      <div class="jside b"><span class="n" id="jscore-b">${wins[1]}</span><span>Bot</span><span class="jchip b"></span></div>
      <span class="jlock ${p.myPick !== null ? "on" : ""}" id="jlock-a">locked in</span><span></span><span class="jlock ${p.botLocked ? "on" : ""}" id="jlock-b" style="justify-self:end">locked in</span>
    </div>
    <div class="dim" id="jmeta">Game ${over ? (last?.gameNumber ?? 1) : rep.gameNumber} &middot; first to ${target} games &middot; drawn games ${draws}${death && !over ? ' &middot; <span class="death">death match</span>' : ""}</div>
    <div class="jboard${p.phase === "reveal" ? " revealing" : ""}" id="jboard">${cellHtml}</div>
    <div class="jstatus" id="jstatus">${esc(prompt.msg)}${prompt.sub ? `<small>${esc(prompt.sub)}</small>` : ""}</div>
    ${over ? `<div class="row"><button class="primary" data-act="pagain" id="pagain">Play again</button><button data-act="pleave">Back to the lobby</button></div>` : ""}
  </section>`;
}

/** What a JINX stake means: the allowed range, the rake for the pot typed in, and any referee collateral problem. */
function limitsHint(): string {
  const lim = S.cfg?.jinx?.limits;
  if (!lim) return "";
  let stake = 0n;
  try {
    stake = parseUnits(S.stakeInput || "0", 6);
  } catch {
    /* not a number yet */
  }
  const pot = stake * 2n;
  const bps = rakeBpsFor(lim.tiers, pot);
  const fee = (pot * BigInt(bps)) / 10_000n;
  const bad = stake > 0n && (stake < BigInt(lim.minStake) || stake > BigInt(lim.maxStake));
  const warn = BigInt(lim.refereeBond) < BigInt(lim.refereeBondFloor) ? '<div class="bad">The referee has not posted its collateral yet, so new matches cannot start.</div>' : "";
  return `<div class="dim" id="limits">Each player stakes ${money(BigInt(lim.minStake))} to ${money(BigInt(lim.maxStake))} tPUSD${bad ? ' <span class="bad">(outside that range)</span>' : ""}.
    ${stake > 0n ? `Pot ${money(pot)}, rake ${pct(bps)} (${money(fee)}), winner receives ${money(pot - fee)}.` : ""}
    <span title="The rate depends on the size of the pot">Rake: ${esc(describeTiers(lim.tiers))}.</span></div>${warn}`;
}

/** A short checklist for a first-time player, shown until the wallet has gas and test tokens. */
function getStarted(cfg: Config): string {
  const hasWallet = !!S.addr;
  const hasGas = S.eth > 0n;
  const hasTokens = S.tokens > 0n;
  if (hasWallet && hasGas && hasTokens) return "";
  const mark = (ok: boolean) => (ok ? '<span class="ok">&#10003;</span>' : '<span class="dim">&#9675;</span>');
  const faucet =
    cfg.chainId === 84532
      ? `Get free Base Sepolia ETH from a faucet, for example <a href="https://www.alchemy.com/faucets/base-sepolia" target="_blank" rel="noopener">Alchemy</a> or <a href="https://portal.cdp.coinbase.com/products/faucet" target="_blank" rel="noopener">Coinbase</a>, and paste your address there. ${S.addr ? '<button data-act="copyaddr" id="copyaddr">Copy my address</button>' : ""}`
      : "Your wallet needs a little ETH for gas.";
  return `<section id="start"><h2>Get started</h2>
    <ol class="steps">
      <li>${mark(hasWallet)} <b>Pick a wallet.</b> Use MetaMask, or the burner wallet that lives in this browser.</li>
      <li>${mark(hasGas)} <b>Get gas.</b> ${faucet}</li>
      <li>${mark(hasTokens)} <b>Mint test tokens.</b> They have no value. Press &ldquo;Mint 1000 test tokens&rdquo; in the Wallet box.</li>
      <li class="dim">Then create an offer, or challenge someone. Want to learn JINX first? Try the practice game: it needs no wallet.</li>
    </ol></section>`;
}

function render() {
  const focus = document.activeElement as HTMLInputElement | null;
  const keep = focus && focus.id === "stake" ? { start: focus.selectionStart, end: focus.selectionEnd } : null;
  const cfg = S.cfg;
  const jinxGame = (S.game === "jinx" && !!cfg?.jinx) || !!S.practice;
  let html = `<h1>PlayPot.GG <span class="dim">${jinxGame ? "JINX" : "tic-tac-toe"} &middot; testnet only</span></h1>
    <div class="banner">Test tokens only, no real money. ${cfg ? `chain ${cfg.chainId} &middot; escrow ${short(G().escrow)} &middot; referee ${short(cfg.referee)}` : ""}</div>`;
  if (cfg?.jinx) {
    html += `<div class="row tabs"><button data-act="game" data-game="ttt" class="${jinxGame ? "" : "primary"}">Tic-tac-toe</button><button data-act="game" data-game="jinx" class="${jinxGame ? "primary" : ""}">JINX</button></div>`;
  }
  if (S.msg) html += `<div id="msg" class="${S.msg.includes("failed") ? "bad" : "dim"}" style="margin-bottom:8px">${S.busy ? '<span class="spin"></span>' : ""}${esc(S.msg)}</div>`;

  if (S.practice) {
    app.innerHTML = html + renderPractice(S.practice);
    updateClock();
    return;
  }

  if (!cfg) {
    const loading = S.msg ? "" : '<div class="loading"><span class="spin"></span> Connecting to the referee…</div>';
    return void (app.innerHTML = html + loading);
  }

  if (!S.jview && !S.view) {
    html += getStarted(cfg);
    html += `<section id="practice-card"><h2>Practice</h2><div class="row"><select id="pbestof"><option value="3" ${S.practiceBestOf === 3 ? "selected" : ""}>Best of 3</option><option value="5" ${S.practiceBestOf === 5 ? "selected" : ""}>Best of 5</option></select><button class="primary" data-act="practice" id="practice">Play JINX against the bot</button><span class="dim">no wallet, no stake</span></div></section>`;
  }
  html += `<section><h2>Wallet</h2>`;
  if (!S.addr) {
    html += `<div class="row">${window.ethereum ? '<button class="primary" data-act="connect">Connect wallet</button>' : ""}<button data-act="burner">Use burner wallet</button></div>`;
  } else {
    html += `<div class="row mono" id="addr">${S.addr}${S.burner ? ' <span class="dim">(burner)</span>' : ""}</div>
      <div class="row"><span>ETH <b id="eth">${Number(formatEther(S.eth)).toFixed(4)}</b></span>
      <span>tPUSD <b id="tokens">${tok(S.tokens)}</b></span>
      <span>Claimable <b id="claimable">${tok(S.claimable)}</b></span></div>
      <div class="row">${[
        `<button data-act="mint" ${S.busy ? "disabled" : ""}>Mint 1000 test tokens</button>`,
        `<button data-act="claim" ${S.busy || S.claimable === 0n ? "disabled" : ""}>Claim winnings</button>`,
        cfg.chainId === 31337 ? `<button data-act="fund">Dev: 10 ETH</button>` : "",
      ].join("")}</div>`;
  }
  html += `</section>`;

  if (S.jview) {
    app.innerHTML = html + renderJinxMatch(S.jview) + `<div class="dim mono" id="build" style="margin-top:12px">${S.build ? `site build ${S.build} &middot; check it with: npm run verify:site -- ${esc(location.origin)}` : ""}</div>`;
    updateClock();
    return;
  }

  if (S.view) {
    app.innerHTML = html + renderMatch(S.view) + `<div class="dim mono" id="build" style="margin-top:12px">${S.build ? `site build ${S.build} &middot; check it with: npm run verify:site -- ${esc(location.origin)}` : ""}</div>`;
    return;
  }

  html += `<section><h2>Their games${jinxGame ? " &middot; JINX" : ""}</h2>
    <div class="row"><label class="dim">Stake (tPUSD)</label><input id="stake" value="${esc(S.stakeInput)}" />
    ${jinxGame ? `<select id="bestof"><option value="3" ${S.bestOfInput === 3 ? "selected" : ""}>Best of 3</option><option value="5" ${S.bestOfInput === 5 ? "selected" : ""}>Best of 5</option></select>` : ""}
    <button class="primary" data-act="create" ${S.busy || !S.addr ? "disabled" : ""}>Create offer</button>
    <span class="dim">locks your stake until someone challenges or you cancel</span></div>
    ${jinxGame ? limitsHint() : ""}
    <table id="offers"><tr><th>#</th><th>Creator</th><th>Stake</th>${jinxGame ? "<th>Format</th>" : ""}<th></th></tr>${
      S.offers.length === 0
        ? '<tr><td colspan="5" class="dim">no open offers</td></tr>'
        : S.offers
            .map((o) => {
              const mineOffer = same(o.creator, S.addr);
              const expired = o.expiry < S.now;
              return `<tr><td>${o.id}</td><td class="mono">${short(o.creator)}${mineOffer ? " (you)" : ""}</td><td>${tok(o.stake)}</td>${jinxGame ? `<td>Bo${o.bestOf ?? 3}</td>` : ""}<td>${
                mineOffer
                  ? `<button data-act="cancel" data-id="${o.id}" ${S.busy ? "disabled" : ""}>Cancel</button>`
                  : `<button class="primary" data-act="challenge" data-id="${o.id}" data-stake="${o.stake}" ${S.busy || !S.addr || expired ? "disabled" : ""}>Challenge</button>`
              }</td></tr>`;
            })
            .join("")
    }</table></section>`;

  html += `<section><h2>My matches</h2><table id="matches"><tr><th>#</th><th>Opponent</th><th>Stake</th><th>State</th><th></th></tr>${
    S.mine.length === 0
      ? '<tr><td colspan="5" class="dim">none yet</td></tr>'
      : S.mine
          .map(({ id, m }) => {
            const opp = same(m.p1, S.addr) ? m.p2 : m.p1;
            return `<tr><td>${id}</td><td class="mono">${short(opp)}</td><td>${tok(m.stake)}</td><td>${STATUS[m.status]}</td><td><button data-act="open" data-id="${id}">Open</button></td></tr>`;
          })
          .join("")
  }</table></section>`;

  app.innerHTML = html + `<div class="dim mono" id="build" style="margin-top:12px">${S.build ? `site build ${S.build} &middot; check it with: npm run verify:site -- ${esc(location.origin)}` : ""}</div>`;
  if (keep) {
    const el = document.getElementById("stake") as HTMLInputElement | null;
    el?.focus();
    el?.setSelectionRange(keep.start, keep.end);
  }
}

declare global {
  interface Window {
    ethereum?: { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> };
  }
}

void init();
