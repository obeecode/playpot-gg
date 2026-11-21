# PlayPot.GG web UI

Vite + React + TypeScript. Runs today against an in-memory mock, so it needs no chain and no server.

```
cd web
npm install
npm run dev        # http://localhost:5173
npm run build      # typecheck + production build
```

Pages: `/` lobby, `/p/:handle` player profile ("their games"), `/match/:id` play, settle and replay.
`/p/you` is your own games, `/match/demo` opens a fresh practice match.

## Connecting the real games

The UI talks to the backend through one interface: `src/lib/gameClient.ts`.

1. Implement `GameClient` (wallet, `PotEscrow` calls, WebSocket referee). `src/lib/mockClient.ts` is the reference behaviour.
2. In `src/main.tsx`, replace `new MockClient()` with your client.
3. Games render through `src/games/registry.tsx`. Add a game by giving it a title and a `Board` component. Pages do not change.

Shapes the UI expects are in `src/lib/types.ts`. `MatchState.moves` is the signed move list, and replay is just "show the board after N moves", so the same list can feed the on-chain dispute replay.

Notes:
- The tic-tac-toe rules in `src/games/tictactoe.ts` are for the mock opponent and board display only. The shared game library is the source of truth for rules.
- The platform fee is shown as `[RAKE %]` until the real basis points are known.
- Testnet banner is always visible. Remove it only after counsel clears real money.
