# PlayPot.GG: wallets and payments

Status: design decision, not yet built. Testnet today uses MetaMask or a burner wallet. Legal review is parked (see "Open questions").

## The decision

**Wallets first, hidden behind a normal sign-in. No PlayPot balance.**

Each player gets their own USDC wallet on Base. That wallet is their balance. Money comes in through a regulated third-party on-ramp (or a direct USDC transfer) and goes straight to the player's wallet. PlayPot never receives, holds or forwards player money, other than the rake the contracts pay to the treasury.

## Why not a PlayPot balance

- **It breaks the promise.** The pitch is "the pot sits in a contract nobody can touch". A balance on our servers makes us the custodian. Signed logs, on-chain disputes and a referee that cannot steal would then protect a pot we could still run off with.
- **It is the heaviest legal category.** Holding user money for wagers usually means money-transmission rules plus gambling licensing. Escrowing a player's own stake in a contract is a much lighter claim.
- **It is a lot of work to own.** Ledgers, reconciliation, fraud, chargebacks, withdrawals and support all become ours.

## Why not MetaMask-only

Most players do not have it. "Install an extension, buy ETH for gas, bridge, approve, sign" loses nearly everyone before their first game. Wallets stay in the product, but the player should not have to know that.

## How it works for a player

1. **Sign in** with email, Google or a passkey (Face ID or fingerprint). An embedded smart wallet is created for them on Base. No seed phrase. They can export or recover it later.
2. **Get USDC in** by any of these:
   - **On-ramp widget** inside the app (card or bank transfer). The provider does ID checks and takes the payment, and USDC lands in the player's wallet. We never touch the money.
   - **Send USDC directly** to their wallet address (crypto-savvy players). It must be **USDC on Base**; the app shows a clear wrong-network warning.
   - **P2P or local exchange** (important in markets like Nigeria where card on-ramps often decline): buy USDC elsewhere, then send it to the wallet address. From our side this is the same as sending directly.
3. **Play.** Creating or accepting an offer moves the stake from their wallet into the escrow contract for that match. Their wallet balance is what the app shows as "balance".
4. **Get paid.** Winnings appear as claimable in the escrow. The app claims for them, with gas sponsored, so the money shows up in their wallet.
5. **Cash out** by sending USDC to an exchange, or through an off-ramp provider (same providers, reverse direction).

## What we pay for and what we never do

| | |
|---|---|
| Gas | Sponsored by a paymaster. A fraction of a cent per transaction on Base, so cents per game. Paid by us, small next to the rake. |
| On-ramp fees | Paid by the player to the provider, typically 1-4%. Separate from our rake. We may earn a small share. |
| Holding player money | **Never.** The wallet is the player's. The escrow contract holds stakes during a match only. |
| Selling crypto to players | **Never directly.** If we took card payments and then sent USDC ourselves, we would be selling crypto, which is the licensed activity we are avoiding. |

## What stays the same in the contracts

No wallet changes are needed in contracts v2:

- Stakes are pulled by `createOffer` and `challenge` from whoever sends the transaction, which works from a smart wallet.
- Winnings are collected with `claim`, which pays the caller.
- Per-match result signing uses the per-match session keys, not the wallet.

## Build order

1. **Now (testnet):** keep MetaMask and burner wallets for friends and testers.
2. **Before any public beta:** embedded-wallet sign-in with sponsored gas, still on testnet. Biggest improvement for first-time players. Provider options: Coinbase Smart Wallet (free, built for Base), Privy, Dynamic. Choice to be made together.
3. **Capped mainnet launch:** real USDC, stake caps, direct USDC deposit and withdraw. On-ramp and off-ramp providers added afterwards, once the legal review has said they are allowed.

## Open questions (to resolve before real money)

- **Gambling restrictions.** Some on-ramps and card networks ban or restrict gambling-related use in their terms. A provider might refuse us, or require the product to be treated as a skill game. Needs a real answer before integrating anyone.
- **Country coverage.** Card and bank on-ramps differ widely by country. Nigeria in particular leans on P2P and exchange routes (for example Binance P2P or Yellow Card). A local partner may be needed.
- **Legal status of the product itself** (skill game vs wagering, by country). Parked for now, flagged for later.
- **Account recovery.** Passkey or email wallets need a recovery story that does not make us a custodian.
- **Audit.** Contracts need an audit before any real value, regardless of the wallet design.
