# PlayPot.GG

Winner-takes-the-pot tic-tac-toe with on-chain escrow. **Testnet only: test tokens, no real money.**
Tic-tac-toe is the v0 used to prove the mechanics; chess comes after.

## How it works

1. **Offer.** Alice creates an offer: her stake is locked in `PotEscrow` immediately.
2. **Challenge.** Bob hits Challenge: one transaction pulls his matching stake and starts the match. Each player registers a throwaway per-match *session key*.
3. **Play.** The game runs on the referee server in real time. Every move is signed silently by the mover's session key and chained to the previous move's hash, so the final hash commits to the whole game. The referee countersigns each move with its receive time.
4. **Settle.** Everyone signs `Result(matchId, result, finalHash)`:
   - Alice + Bob + referee: **instant payout**.
   - A player stays silent: referee + one player opens a **30-minute window** (`challengeWindow`), then anyone calls `finalize`.
   - Someone disputes inside the window (posting a bond): funds freeze, and anyone submits the players' own signed moves to `submitReplay`. The contract re-checks every signature, the hash chain and the rules. The longest valid terminal log decides; no log means both stakes are refunded.
   - Nothing settled by the deadline: anyone calls `abort` for a full refund, no rake.
5. **Claim.** Payouts are credited, then pulled with `claim()`.

A draw refunds both stakes with no rake. The rake is a fixed bps with an immutable on-chain cap (10%). A guardian pause only stops new offers and challenges; it can never block cancel, settle, dispute, abort or claim.

```
contracts/   PotEscrow.sol, TicTacToe.sol (on-chain replay), TestToken.sol, Foundry tests + invariants
packages/game/    shared rules + hash chain + EIP-712 signing + log verifier (server, e2e and web use the same code)
packages/server/  WebSocket referee: validates, orders, countersigns, relays settlement
packages/web/     Vite client: wallet, offers, challenge, play, replay viewer, dispute actions
scripts/          e2e.ts (anvil), ui-test.ts (headless browser), dev.ts (local playground)
```

## Prerequisites

Node 22.18+ (TypeScript runs natively), and Foundry (`forge`, `anvil`):

```bash
curl -L https://foundry.paradigm.xyz | bash && foundryup
npm install
cd contracts && forge build && cd ..
```

## Run the tests

```bash
npm run test:contracts   # 33 Foundry tests: every settlement path, forgery cases, invariants
npm run test:game        # rules (exhaustive game count) + log verification
npm run typecheck
npm run e2e              # local anvil + referee + two signing clients, all settlement paths
npm run ui-test          # headless Chromium plays a full game through the web client
npm test                 # all of the above
```

`ui-test` needs Chromium: set `CHROMIUM=/path/to/chrome` if it is not at `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`.

## Play locally in your browser

```bash
npm run dev     # shell 1: anvil + contracts + referee on :8787
npm run web     # shell 2: Vite on :5173
```

Open `http://localhost:5173/?burner=alice` and `http://localhost:5173/?burner=bob` in two windows (use two different browser profiles or a private window for one). The `burner` flag uses a local throwaway key instead of a wallet. On a local chain, use **Dev: 10 ETH**, **Mint 1000 test tokens**, then create an offer in one window and challenge it in the other.

## Deploy to Base Sepolia (play with a friend)

You need a normal browser and internet access for the faucet steps.

1. **Keys (testnet only, never reuse a real key).**
   ```bash
   cast wallet new            # deployer
   cast wallet new            # referee
   cast wallet import deployer --interactive
   ```
2. **ETH for gas.** Fund the deployer *and* the referee address from the Coinbase CDP faucet (Base Sepolia). The referee key also relays settlement transactions.
3. **Deploy.**
   ```bash
   cd contracts
   REFEREE=<referee address> forge script script/Deploy.s.sol \
     --rpc-url https://sepolia.base.org --account deployer --broadcast
   ```
   Note the printed `ESCROW` address. Optional env: `TREASURY`, `RAKE_BPS` (max 1000), `CHALLENGE_WINDOW`, `MATCH_DURATION`, `ABORT_GRACE`, `DISPUTE_BOND`.
4. **Run the referee** somewhere your friend can reach it:
   ```bash
   RPC_URL=https://sepolia.base.org ESCROW=<escrow> REFEREE_PK=<referee private key> \
     PORT=8787 npm run server
   ```
   If the web client is served over https, the referee must be reachable over https/wss too (for example behind a Cloudflare tunnel or a reverse proxy).
5. **Serve the client.** `npm run build:web` and host `packages/web/dist` on any static host, or run `npm run web`. Open it with `?server=<referee url>`.
6. **Play.** Each player connects a wallet (the client switches to Base Sepolia), clicks **Mint 1000 test tokens**, and needs a little Base Sepolia ETH for gas.

## Host it on playpot.gg (one small VPS)

`deploy/` runs the referee and the web client behind Caddy, which gets HTTPS certificates automatically.

1. Point DNS `A` records for `app.playpot.gg` and `api.playpot.gg` at the VPS IP (DNS only, no proxy, until it works).
2. On the VPS (Docker + Compose installed): `git clone` this branch, then
   ```bash
   cd playpot-gg/deploy
   cp .env.example .env     # fill in ESCROW, REFEREE_PK, RPC_URL (testnet keys only)
   docker compose up -d --build
   ```
3. Open `https://app.playpot.gg`. The client is built to talk to `https://api.playpot.gg`.

Use a keyed RPC (Alchemy, QuickNode) in `RPC_URL` for the server, and keep it out of the browser by setting a different `PUBLIC_RPC_URL`.

## Known limits of v0

- **Mock referee.** One plain key signs as the referee. Phase 2 moves it into an attested enclave; until then, the referee can only affect settlement by colluding with a player, and the dispute path above overturns that.
- **No clocks.** Tic-tac-toe v0 has no timeouts. A stalled game ends at the match deadline via `abort`. Clock handling is the part a real referee must be trusted for, and comes with chess.
- **A referee signature is required to open the window path.** If the referee is down and both players agree, they cannot settle early; `abort` refunds after the deadline.
- **Session keys are registered by the transaction itself** (`createOffer` / `challenge` record the key), so no separate EIP-712 authorization is needed on-chain.
- **Referee state is in memory plus JSON logs on disk.** One server, no HA.
- **Engine-assisted cheating cannot be solved on-chain** (relevant for chess).
- **Unaudited.** Do not point real value at it.

## Legal

Engineering is not the hard part. A stake on your own game may count as betting (UK), online money games are banned in India, and US state law varies. **No real money until counsel has cleared specific jurisdictions.**
