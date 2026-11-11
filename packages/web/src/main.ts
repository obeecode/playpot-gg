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
  eip712Domain,
  genesisHash,
  initialBoard,
  potEscrowAbi,
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

// ------------------------------------------------------------------------------- types & state

interface Config {
  chainId: number;
  escrow: Address;
  token: Address;
  referee: Address;
  rpcUrl: string;
}
interface Offer {
  id: bigint;
  creator: Address;
  stake: bigint;
  expiry: bigint;
  open: boolean;
}
interface OnChain {
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
  stakeInput: "10",
};

const params = new URLSearchParams(location.search);
const app = document.getElementById("app")!;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const tok = (n: bigint) => formatUnits(n, 6);
const same = (a?: string | null, b?: string | null) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
const wsUrl = (u: string) => u.replace(/^http/, "ws");
const transport = (url: string) => http(url, { timeout: 30_000, retryCount: 2, batch: { wait: 25 } });
const toOnChain = (m: StateMatch): OnChain => ({
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
const escrowWrite = (fn: string, args: unknown[]) => write(S.cfg!.escrow, potEscrowAbi, fn, args);

async function run(label: string, fn: () => Promise<void>) {
  S.busy = true;
  S.msg = `${label}…`;
  render();
  try {
    await fn();
    S.msg = `${label}: done`;
  } catch (e) {
    S.msg = `${label} failed: ${((e as { shortMessage?: string }).shortMessage ?? (e as Error).message).slice(0, 240)}`;
  }
  S.busy = false;
  await refresh();
}

const skKey = (id: bigint) => `playpot:sk:${S.cfg!.chainId}:${S.cfg!.escrow}:${id}:${S.addr}`.toLowerCase();
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
    if (params.has("burner") || !window.ethereum) await connect(true);
  } catch (e) {
    S.msg = `Cannot reach the referee server at ${S.serverUrl}: ${(e as Error).message}`;
  }
  render();
  await refresh();
  setInterval(() => void refresh(), 5000);
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
  S.acct = addr;
  S.addr = addr;
  S.wallet = createWalletClient({ account: addr, chain: S.chain, transport: custom(eth) });
}

async function refresh() {
  if (!S.cfg) return;
  try {
    const q = new URLSearchParams();
    if (S.addr) q.set("addr", S.addr);
    if (S.view) q.set("match", S.view.id.toString());
    const res = await fetch(`${S.serverUrl}/state?${q}`, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`state ${res.status}`);
    const st = (await res.json()) as StateResponse;
    S.now = BigInt(st.now);
    S.bond = BigInt(st.bond);
    if (st.account) {
      S.eth = BigInt(st.account.eth);
      S.tokens = BigInt(st.account.tokens);
      S.allowance = BigInt(st.account.allowance);
      S.claimable = BigInt(st.account.claimable);
    }
    S.offers = st.rows
      .filter((r) => r.offer.open)
      .map((r) => ({ id: BigInt(r.id), creator: r.offer.creator, stake: BigInt(r.offer.stake), expiry: BigInt(r.offer.expiry), open: true }))
      .reverse();
    S.mine = st.rows
      .filter((r) => r.match.status !== 0 && S.addr && (same(r.match.p1, S.addr) || same(r.match.p2, S.addr)))
      .map((r) => ({ id: BigInt(r.id), m: toOnChain(r.match) }))
      .reverse();
    if (S.view && st.view) S.view.onchain = toOnChain(st.view);
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
      await write(S.cfg!.token, testTokenAbi, "mint", [S.addr, 1_000_000_000n]);
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
      if (S.allowance < stake) await write(S.cfg!.token, testTokenAbi, "approve", [S.cfg!.escrow, 2n ** 256n - 1n]);
      const pk = generatePrivateKey();
      const expiry = S.now + 86_400n;
      const rcpt = await escrowWrite("createOffer", [stake, expiry, privateKeyToAccount(pk).address]);
      const ev = parseEventLogs({ abi: potEscrowAbi, logs: rcpt.logs, eventName: "OfferCreated" })[0];
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
      if (S.allowance < stake) await write(S.cfg!.token, testTokenAbi, "approve", [S.cfg!.escrow, 2n ** 256n - 1n]);
      const pk = generatePrivateKey();
      await escrowWrite("challenge", [id, privateKeyToAccount(pk).address]);
      saveSk(id, pk);
      await openMatch(id);
    }),
  open: (el) => openMatch(BigInt(el.dataset.id!)),
  close: () => closeMatch(),
  dispute: () => run("Dispute", async () => void (await escrowWrite("dispute", [S.view!.id]))),
  finalize: () => run("Finalize", async () => void (await escrowWrite("finalize", [S.view!.id]))),
  finalizeDispute: () => run("Finalize dispute", async () => void (await escrowWrite("finalizeDispute", [S.view!.id]))),
  abort: () => run("Abort", async () => void (await escrowWrite("abort", [S.view!.id]))),
  submitReplay: () =>
    run("Submit replay", async () => {
      const v = S.view!;
      const log = (await (await fetch(`${S.serverUrl}/log/${v.id}`)).json()) as MatchLog;
      const { cells, sigs } = replayArgs(log);
      await escrowWrite("submitReplay", [v.id, cells, sigs]);
    }),
  cell: (el) => playCell(Number(el.dataset.cell)),
};

app.addEventListener("click", (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>("[data-act]");
  if (!el || el.hasAttribute("disabled")) return;
  void actions[el.dataset.act!]?.(el);
});
app.addEventListener("input", (e) => {
  const t = e.target as HTMLInputElement;
  if (t.id === "stake") S.stakeInput = t.value;
  if (t.id === "step" && S.view) {
    S.view.step = Number(t.value);
    render();
  }
});

// ------------------------------------------------------------------------------------- match view

async function openMatch(id: bigint) {
  closeMatch();
  const v: MatchView = {
    id,
    ws: null,
    log: null,
    verify: null,
    sk: loadSk(id),
    resultSent: false,
    settled: "",
    error: "",
    step: null,
    onchain: null,
  };
  S.view = v;
  await refresh();
  const ws = new WebSocket(wsUrl(S.serverUrl));
  v.ws = ws;
  const send = (m: ClientMsg) => ws.send(JSON.stringify(m));
  ws.onopen = () => send({ type: "join", matchId: id.toString() });
  ws.onmessage = (ev) => void onServerMsg(v, JSON.parse(ev.data) as ServerMsg);
  ws.onclose = () => {
    if (S.view === v && !v.settled) v.error = v.error || "disconnected from referee";
    render();
  };
  render();
}

function closeMatch() {
  S.view?.ws?.close();
  S.view = null;
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
    void refresh();
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
  const prevHash = i === 0 ? genesisHash(v.id) : v.log.moves[i - 1].hash;
  const sig = await signMove(v.sk, eip712Domain(S.cfg.chainId, S.cfg.escrow), { matchId: v.id, index: i, cell, prevHash });
  v.ws?.send(JSON.stringify({ type: "move", matchId: v.id.toString(), index: i, cell, sig } satisfies ClientMsg));
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
          `<button class="cell ${myTurn ? "mine" : ""}" data-act="cell" data-cell="${i}" ${myTurn && !c ? "" : "disabled"}>${c ?? ""}</button>`,
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

function render() {
  const focus = document.activeElement as HTMLInputElement | null;
  const keep = focus && focus.id === "stake" ? { start: focus.selectionStart, end: focus.selectionEnd } : null;
  const cfg = S.cfg;
  let html = `<h1>PlayPot.GG <span class="dim">tic-tac-toe &middot; testnet only</span></h1>
    <div class="banner">Test tokens only, no real money. ${cfg ? `chain ${cfg.chainId} &middot; escrow ${short(cfg.escrow)} &middot; referee ${short(cfg.referee)}` : ""}</div>`;
  if (S.msg) html += `<div id="msg" class="${S.msg.includes("failed") ? "bad" : "dim"}" style="margin-bottom:8px">${esc(S.msg)}</div>`;

  if (!cfg) return void (app.innerHTML = html);

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

  if (S.view) {
    app.innerHTML = html + renderMatch(S.view);
    return;
  }

  html += `<section><h2>Their games</h2>
    <div class="row"><label class="dim">Stake (tPUSD)</label><input id="stake" value="${esc(S.stakeInput)}" />
    <button class="primary" data-act="create" ${S.busy || !S.addr ? "disabled" : ""}>Create offer</button>
    <span class="dim">locks your stake until someone challenges or you cancel</span></div>
    <table id="offers"><tr><th>#</th><th>Creator</th><th>Stake</th><th></th></tr>${
      S.offers.length === 0
        ? '<tr><td colspan="4" class="dim">no open offers</td></tr>'
        : S.offers
            .map((o) => {
              const mineOffer = same(o.creator, S.addr);
              const expired = o.expiry < S.now;
              return `<tr><td>${o.id}</td><td class="mono">${short(o.creator)}${mineOffer ? " (you)" : ""}</td><td>${tok(o.stake)}</td><td>${
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

  app.innerHTML = html;
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
