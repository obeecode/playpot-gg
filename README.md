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
npm run test:contracts   # 63 Foundry tests: both escrows, every settlement path, forgery cases, invariants, JINX rules parity
npm run test:game        # rules (exhaustive game count) + log verification
npm run test:server      # the JINX referee room: clock, misses, receipts, rejections
npm run test:verify      # the site verifier
npm run typecheck
npm run e2e              # tic-tac-toe: local anvil + referee + two signing clients, all settlement paths
npm run e2e:jinx         # JINX: real matches over WebSocket, the false-miss dispute, clock forfeits, refund
npm run ui-test          # headless Chromium plays a full tic-tac-toe game through the web client
npm run ui-test:jinx     # headless Chromium plays a full JINX best-of-3 through the web client
npm test                 # all of the above
```

`ui-test` needs Chromium: set `CHROMIUM=/path/to/chrome` if it is not at `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`.

## Play locally in your browser

```bash
npm run dev     # shell 1: anvil + contracts + referee on :8787
npm run web     # shell 2: Vite on :5173
```

Open `http://localhost:5173/?burner=alice` and `http://localhost:5173/?burner=bob` in two windows (use two different browser profiles or a private window for one). The `burner` flag uses a local throwaway key instead of a wallet. On a local chain, use **Dev: 10 ETH**, **Mint 1000 test tokens**, then create an offer in one window and challenge it in the other.

## Play with a friend in one command (no faucet, no server)

Runs a throwaway local chain on your computer and shares it through a free Cloudflare quick tunnel.

```bash
winget install --id Cloudflare.cloudflared   # Windows (Mac: brew install cloudflared); then open a NEW terminal
cd contracts && forge build && cd ..
npm run live
```

It prints a `https://<random>.trycloudflare.com` link. Open it yourself and send it to your friend. Each of you gets a burner wallet automatically (if you have MetaMask installed, click **Use burner wallet**). Click **Dev: 10 ETH**, then **Mint 1000 test tokens**; one creates an offer and the other clicks **Challenge**.

The referee serves the site and a restricted chain proxy on that one address, so nothing else needs to be reachable. The link changes every run, the chain resets when you stop, and anyone with the link can play, so share it privately. The anvil dev keys are public, so this mode generates fresh random keys for the deployer and referee.

### Same thing on Base Sepolia, with no server to rent

Deploy the contracts once (below), then run the referee on your own computer and share it through the same tunnel:

```powershell
$env:ESCROW = "0x<escrow address>"
$env:REFEREE_PK = "0x<referee private key>"
npm run live
```

Games and balances live on Base Sepolia, so they survive restarts; the link changes each run. Each player needs a little Base Sepolia ETH for gas (copy the address from the Wallet box into a faucet) and then clicks **Mint 1000 test tokens**. MetaMask works here.

### A permanent address on your own domain (free Cloudflare named tunnel)

The quick tunnel's link changes every run. To serve the same game at `https://app.playpot.gg` (or any hostname) with no server to rent:

1. **Put the domain's DNS on Cloudflare (free plan).** Your registrar (for example Namecheap) can stay as it is. In Cloudflare choose *Add a site*, enter the domain, pick the Free plan, and copy the two nameservers it shows. In Namecheap: Domain List, Manage, Nameservers, Custom DNS, paste both, save. Cloudflare marks the site *Active* once it has settled (minutes to hours).
2. **Create the tunnel, once:**
   ```powershell
   cloudflared tunnel login                       # a browser opens: pick your domain
   cloudflared tunnel create playpot
   cloudflared tunnel route dns playpot app.playpot.gg
   ```
3. **Run the game with the tunnel name and host** (plus the `ESCROW`, `JINX_ESCROW` and `REFEREE_PK` settings above):
   ```powershell
   $env:TUNNEL_NAME = "playpot"
   $env:TUNNEL_HOST = "app.playpot.gg"
   npm run live
   ```

The link is announced only after the tunnel has really connected. Your computer has to stay on; to move the referee to a rented server later, run the same tunnel (or a normal DNS record) from there. Players' balances are read through one batched call that clients only request after something changes, so the RPC bill follows games played rather than tabs left open.

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
   REFEREE=<referee address> TREASURY=<address you control> forge script script/Deploy.s.sol \
     --rpc-url https://sepolia.base.org --account deployer --broadcast
   ```
   To publish the verified source on the block explorer (so anyone can read exactly what the contract does), get a free Etherscan API key and add `--verify --etherscan-api-key <key>` to that command. The compiler settings are pinned in `contracts/foundry.toml` (solc 0.8.28, optimizer 200 runs, cancun). Note the printed `ESCROW` address. `TREASURY` receives the rake and cannot be changed later. Optional env: `RAKE_BPS` (max 1000), `CHALLENGE_WINDOW`, `MATCH_DURATION`, `ABORT_GRACE`, `DISPUTE_BOND`.
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

## JINX

Simultaneous-move tic-tac-toe on a 5x5 board: both players pick a square at the same moment, and if you pick the same square it is jinxed and dead. Three in a row wins; a best-of-3 or best-of-5 is one pot. The rules, clock and match structure are in the design doc; `packages/game/src/jinx.ts` is the executable version and `contracts/src/JinxRules.sol` its on-chain twin. 600 seeded games (about 5,000 turns) are generated from the TypeScript rules and replayed in Solidity, comparing the whole board after every turn.

**How picks stay secret and provable.** Each turn a player signs a commitment to their pick (`keccak(match, turn, square, salt)`), the referee returns a signed receipt for it, and only after both have committed are the picks revealed together. A hostile server cannot leak a pick early (it only ever sees a hash first), and a player cannot swap a pick after seeing the other (the commitment binds it). Turns are hash-chained, and each commitment signs the chain head, so a log cannot be reordered or spliced.

**Settlement** follows the tic-tac-toe escrow (`JinxEscrow`): everyone signs for an instant payout, the referee plus one player opens a 30 minute window, and a dispute freezes funds while anyone replays the signed turns on-chain. The contract checks every signature and receipt and runs the rules. A match is capped at 120 turns, and a double forfeit (both players stop picking) refunds both stakes. Worst case replay is about 5.1M gas, under Base's 16.7M cap.

**What is still trusted: the referee's clock.** "You missed the clock" is the referee's word. The one provable fraud is a miss the referee contradicts with its own receipt: if it signed "received your pick at 6.2s" and also "you missed turn 4", the contract voids the miss (`voidMiss`). A pick the referee silently drops cannot be proven. A hardware-attested referee is what closes that.

Play it locally with `npm run live` (the JINX tab). To deploy it next to the existing contracts on Base Sepolia:

```powershell
cd contracts
$env:TOKEN = "0x<existing test token>"; $env:REFEREE = "0x<referee>"; $env:TREASURY = "0x<address you control>"
forge script script/DeployJinx.s.sol --rpc-url https://sepolia.base.org --private-key 0x<deployer key> --broadcast
```
then add `$env:JINX_ESCROW = "0x<printed address>"` to the `npm run live` command above.

## Open source and verifying what is live

The code is MIT licensed (`LICENSE`). Contracts are immutable and, once verified on the explorer (above), anyone can read them. The web client is a reproducible build: every built file is hashed into `manifest.json`, with one **site hash** for the whole thing.

Anyone can check that a live site serves exactly the build you published:
```bash
git clone -b <release tag or commit> https://github.com/obeecode/playpot-gg && cd playpot-gg
npm ci && npm run build:web                      # prints the site hash
npm run verify:site -- https://app.playpot.gg    # compares what is live to your own build
npm run verify:site -- https://app.playpot.gg --expect <published hash>
```
It re-hashes every file as the site actually serves it, and fails on a modified script, an unlisted file, an injected inline or external script, or a hash that differs from your build. Line endings are pinned to LF (`.gitattributes`) and Node to `22.22.0` (`.nvmrc`, Dockerfile) so builds match across machines. The official hash is the Linux build, so compare on Linux or in the Docker image.

When you deploy a release, publish its site hash next to the git commit (for example in the release notes), so users have something to compare against.

**What this does not prove yet:** that the referee server is running the published code. It runs on a machine you control, so for now players trust it for ordering and timing. A hardware-attested referee (Phase 2) is what closes that, and an on-chain engine registry will pin the rules each match uses.

## Live testnet deployment (Base Sepolia, chain 84532)

| | Address |
|---|---|
| Escrow (`PotEscrow`) | [`0x558f479c8de7019AA26893e743e4e9FF3F989FfD`](https://sepolia.basescan.org/address/0x558f479c8de7019AA26893e743e4e9FF3F989FfD#code) |
| JINX escrow (`JinxEscrow`) | [`0x3cF2006B19758b9c5143Eb71022E7D7cD48c70F4`](https://sepolia.basescan.org/address/0x3cF2006B19758b9c5143Eb71022E7D7cD48c70F4#code) |
| Test token (`TestToken`) | [`0x43aD88593cFE37567Aa6385812260446168E2eb7`](https://sepolia.basescan.org/address/0x43aD88593cFE37567Aa6385812260446168E2eb7#code) |
| Referee signer | `0xC3Abd6eD23D0b57dCBB0fA0C6F4f45eD745d2DB5` |
| Treasury (receives the rake) | `0x25f2c0C83a53B95De574836671bd9aBB3df77c37` |

Source is verified on Basescan. Parameters: 3% rake (immutable cap 10%), 30 minute challenge window, 1 hour match time plus 10 minutes grace before `abort`, dispute bond 5 test tokens. Also in `deployments/base-sepolia.json`. Test tokens only, no real value.

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
