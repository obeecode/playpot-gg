# STICK DUEL: scope for the first playable

Working title. A tiny real-time 2D stickman duel for PlayPot.GG: two fighters, one screen, matches of about 2 to 5 minutes, played in the browser, with a result that is a pure function of the two players' inputs, so a match can be replayed and verified.

This document is the brief for the first deliverable. It is written so the developer can work from it without the chat that produced it. Everything marked **(tunable)** is a starting value to be tuned by playing, not a requirement.

---

## 1. What we are making, and why

PlayPot.GG runs 1v1 games for a pot of money. JINX (shipped) is a perfect-information turn game: skill is calculation. We want a second game with a different kind of skill: **timing, spacing and reading the opponent**. Skill that players develop by feel over many matches, where no move is a guaranteed win and the better player wins most, not all, of the time.

Reference points: Nidhogg (one-hit sword duel, tug of war), Divekick (two buttons, deep mind games), and fighting-game fundamentals (neutral, spacing, punishing whiffs).

**Hard product constraints**
- Plays in a phone or desktop browser. No install. 2D canvas is plenty; do not use WebGPU.
- A match ends fast: best of 3 rounds is about 2 minutes, best of 5 never longer than 5.
- Few elements, high dynamism: two fighters, a floor, two walls, one small platform. Nothing else on screen that changes the outcome.
- Runs smooth on a mid-range phone from the last few years (target: a steady 60 updates per second; measure it).
- **Fully deterministic** (section 3). This is what makes it provable, replayable, and cheap to run.

## 2. The game

### 2.1 Arena and fighters
- One screen, logical size **960 x 540**. Flat floor, solid walls left and right, one small centre platform (160 px wide, 110 px above the floor, **tunable**; may be cut if it hurts balance).
- Each fighter: **3 hearts**, a **stamina bar** (0 to 1000 internally, shown as a bar), body box 24 x 64 px, always faces the opponent.
- The walls close in during a round (2.4): this bounds round length and forces action.

### 2.2 Actions
Seven inputs: **left, right, jump, strike, guard, grab, dash**.

| Action | Rule (starting values, 60 ticks per second, **tunable**) |
|---|---|
| Walk | 2.5 px per tick forward, 2.0 backward. Not while attacking or in stun. |
| Jump | Launch speed 9 px per tick up, gravity 0.45 px per tick squared, about 40 ticks in the air, peak about 90 px. A little air steering (1 px per tick). Cannot guard or grab in the air. |
| **Strike** | Startup 6, active 3, recovery 14 ticks. Reach 70 px. Costs 100 stamina. Hits for 1 heart. Blocked by guard. |
| **Air strike (dive)** | Jump, then strike: a downward diagonal slash. Startup 5, active until landing, then 10 ticks of landing recovery. Blocked by guard. 1 heart. |
| **Guard** | Hold. Startup 4 ticks. Blocks strikes from the front. Each blocked hit costs the guarder 200 stamina; at 0 stamina the guard breaks (40 ticks of stun). **Parry:** a strike that lands in the first 5 ticks of the guard is parried: the attacker is stunned for 24 ticks and the guarder gets 300 stamina back. |
| **Grab** | Startup 10, active 2, recovery **26** if it whiffs. Reach 40 px. Costs 150 stamina. **Guard does not stop a grab.** A grab that connects: 1 heart and a throw (knockback, 30 ticks of stun). Beats guard and dash-recovery; loses to a strike that is already active. |
| **Dash** | Forward or back, startup 2, 14 ticks long, about 120 px. First ticks 3 to 8 are invulnerable to strikes (not to grabs). Costs 250 stamina, 8 ticks of recovery. |

The core triangle is intentionally small: **guard beats strike, grab beats guard, strike beats grab** (it is faster). Dash beats a strike but loses to a grab. Jump and dash are about **spacing**: getting out of range, baiting a whiff, crossing over. Players develop a feel for each other's habits; nothing here is a guaranteed win.

Design rule to keep in mind while tuning: **the first-contact decision should be a read, not a reaction.** Core actions should start faster than a person can see and answer them (people need roughly 12 to 15 ticks), so the choice has to be made before the opponent's move is visible. Whiff punishment (reacting to a mistake) is where a script beats a person; keep the numbers such that a human can win those exchanges by anticipation. The bot matrix test (section 6) is how we check this, so do not skip it.

### 2.3 Stamina
- Regenerates 1 per tick after 30 ticks of not attacking, guarding or dashing. Costs are in the table above. Empty stamina means no dash, no grab, no strike (walking and guarding still work until the guard breaks).
- This is the resource game: spamming anything runs you dry.

### 2.4 Hits, hearts, rounds, match
- A hit removes 1 heart, causes hit-stun (18 ticks, **tunable**) and knockback, and a **hit-stop** freeze of 3 ticks. Hit-stop is part of the simulation (it changes timing), not a visual effect.
- After recovering from hit-stun a fighter has 8 ticks of protection so there are no infinite chains.
- A round ends when a fighter reaches 0 hearts, or when the timer ends.
- **Round timer: 45 seconds (2700 ticks).** From tick 1800 the walls move in 0.25 px per tick each, down to a minimum arena width of 240 px, so stalling stops working.
- **Timer end:** more hearts wins. Tied hearts: more stamina wins. Still tied: the round is replayed once; if tied again it is a draw round and counts for nobody.
- **Match:** best of 3 rounds is the default (first to 2). Best of 5 (first to 3) is an option. Intro and break between rounds: 3 seconds each. A best-of-5 match cannot run past about 5 minutes by construction.
- No randomness anywhere. Spawn positions are fixed (fighters start 360 px apart, mirrored).

### 2.5 Controls (desktop prototype)
| | Player 1 | Player 2 |
|---|---|---|
| Move | A, D | Left, Right |
| Jump | W | Up |
| Strike / Guard / Grab | J / K / L | , / . / / |
| Dash | S | Down |

Any other mapping is fine if it is shown on screen. Gamepad is optional. **Mobile layout (later phase):** left and right pad bottom-left, jump above it, four large buttons (strike, guard, grab, dash) bottom-right; no swipe gestures for core actions.

### 2.6 Look and feel
Minimal stickmen (head, body, limbs from a few lines), flat colours, one accent colour per fighter. Posed animation per action. Screen shake, particles and sound are **visual only** and must not touch the simulation. Readable at phone size. Keep the first version ugly-but-clear; the feel of the timing is the product.

---

## 3. The determinism rules (non-negotiable)

The simulation must be a pure function: `step(state, inputsP1, inputsP2) -> state`. The same inputs from the same start must give the same result on every device and in the referee's Node process, forever. Everything later (replays, verification, disputes, running it cheaply) depends on this.

- **Integers only.** All positions, speeds, timers and stamina are integers. Use fixed point with 8 fractional bits for positions and velocities (1 px = 256 units). Multiply by integers and shift right; do not divide, and do not use floating-point maths in the simulation at all.
- **No `Math.random`, `Date.now`, `performance.now`, `Math.sin` and friends, object key order, or `Map`/`Set` iteration order** inside the simulation. A small seeded integer generator is allowed if ever needed, but v1 does not need one.
- **Fixed time step:** 60 ticks per second, regardless of the screen's refresh rate. Rendering interpolates; the simulation never reads the clock.
- **State is small and serializable.** `serialize(state)` and `deserialize(bytes)` must round-trip exactly (needed for rollback later). Keep the whole state to a few dozen integers.
- **A state hash** (for example FNV-1a over the state's int32 fields) can be computed after any tick. Checkpoints are taken every 60 ticks.
- **Keep it small enough to be written in Solidity later.** Roughly tens of integer operations per fighter per tick, no loops over unbounded data. We may one day settle disputes on-chain by narrowing a disagreement to a single tick and running that tick in a contract. That only works if the step function stays tiny. Treat this as a design budget.
- Inputs are a 7-bit mask per player per tick. Input buffering (4 ticks, **tunable**) is part of the simulation.
- Visual effects live outside the simulation and may use floats and randomness freely.

## 4. Deliverables, in order

### Phase 1: the feel prototype (this brief)
No network, no chain, no money. The goal is to find out whether it is fun, and to prove determinism.

1. **A single playable page** (one HTML file is fine) for two players on one keyboard, with:
   - the full match flow (rounds, timer, closing walls, best of 3 and best of 5);
   - **three practice bots** (6): a frame-perfect reactor, a human-like reactor (12-tick delay, occasional mistakes), and a random-mix bot;
   - **replay**: every match records its input log; a "watch replay" button plays it back and the result must be identical;
   - **a determinism self-test button**: run the same recorded input log twice (and once in a Web Worker if feasible) and show that the final state hashes match;
   - **a debug view**: toggle hitboxes, show current state/frame numbers, slow motion and single-step;
   - **export** of the match log as JSON (see 5).
2. **The simulation as a standalone, dependency-free TypeScript module** that does not touch the DOM, so it can run in the browser and in Node unchanged. Suggested location in the repo: `packages/game/src/duel.ts`, mirroring how `jinx.ts` is organised: pure rules, `newMatch`, `step`, `hash`, serialization, plus a `duelBot.ts` like `jinxBot.ts`.
3. **Tests** (Node's built-in test runner, like the other packages): golden input logs with their expected final hashes; round-trip serialization; a fuzz test (a few thousand random input logs) that runs the simulation twice and compares hashes; rule unit tests for each row of the table in 2.2 (frame counts, damage, parry, guard break, stamina limits, timer, closing walls, tie-breaks).

Share the prototype as a **claude.ai artifact** the same way the JINX prototype was shared (see 7), so it can be reviewed in place.

### Later phases (not part of this brief; listed so the design leaves room)
2. **Online**: the PlayPot referee relays both players' inputs (not peer to peer); inputs go about 20 times a second with the last few repeated to survive packet loss; adaptive input delay first, rollback after. Connection check and match rules before the game (6.3).
3. **Wagering**: a new escrow for the game that reuses the v2 money layer (stake limits, rake tiers, bonded referee). Settlement by both players' signatures, otherwise a challenge window. Players sign a chained hash of their inputs about once per second, and the referee issues receipts.
4. **Closed beta with low stake caps**, then external audit and legal review before real money.

## 5. The log format (so phase 2 slots in)

A match log is plain JSON:

```json
{
  "game": "duel",
  "version": 1,
  "rules": { "tickRate": 60, "bestOf": 3 },
  "inputs": [[0, 0], [1, 0], [1, 4]],
  "checkpoints": [{ "tick": 60, "hash": "0x..." }],
  "result": { "winner": 1, "rounds": [1, 2, 1] }
}
```

`inputs[t]` is `[maskP1, maskP2]` for tick `t` (run-length compressing repeats is welcome). Replaying `inputs` from `newMatch` must reproduce every checkpoint hash and the result. Version the rules: any change to a number in the table in 2.2 is a new `version`.

## 6. How we know the design works

### 6.1 Bot matrix (the key test)
Fast-reaction games favour scripts, so we measure it before building anything on top. Build these bots and run each against the others for a few thousand matches:

| Bot | Behaviour |
|---|---|
| **Reactor-0** | Perfect: answers anything visible with the correct counter on the very next tick |
| **Reactor-12** | The same, with a 12-tick delay and a 10% chance to pick the wrong answer |
| **Mixer** | Chooses actions at random with sensible weights (no reading) |
| **Pattern reader** | Tracks what the opponent did in the last 10 situations and counters the most common choice |

**Pass condition (starting values, adjust once real people have played):** no single bot beats all the others by more than 70% over a long run, and Reactor-0 must not beat Pattern reader and Mixer both above 85%. If perfect reactions dominate, the game fails the "reads over reflexes" rule. Fix it by changing startup and recovery numbers, not by adding rules. Report the full matrix with each tuning pass.

### 6.2 Playtest metrics to log per match (all computable from the input log)
- Round length: target median **35 to 45 s**; at most 15% of rounds decided by the timer.
- Heart loss by cause (strike, air strike, grab, parry punish), and how often each action is chosen.
- Stalemate time: ticks with no attack from either side.
- Whiff rates per action; guard-break frequency; stamina-empty frequency.
- Win rate of the first-player side (should be about 50%; there is no side advantage by design).

### 6.3 Human-feel checks
- Hit-stop and reactions feel responsive at 60 ticks per second, with no input lag from the page itself (measure input to screen on a mid-range phone and a laptop).
- A new player understands guard, strike and grab within a minute of the practice mode. Add a short on-screen explanation of the triangle.

## 7. Handoff and review

- The dev builds the Phase 1 prototype and publishes it as a **claude.ai artifact**. Share it so the project owner's account can open it (Share menu, then give access), and send the link.
- The owner will ask Claude to open the artifact and review it against this document. It will check: that the controls and match flow work; the numbers in 2.2 match the code (frame counts in particular); the determinism rules in section 3 are followed in the code (no floats, no clock, no randomness in the simulation); the self-test, replay and export features work; the bot matrix results are reported; and the code is dependency-free and runnable in Node.
- Then the simulation module and tests move into the repo (`packages/game/src/duel.ts` and tests), and Phase 2 starts.

## 8. Explicitly out of scope for the first playable
Networking, accounts and wallets, any money or on-chain contracts, matchmaking, ranking, spectating, characters or cosmetics, sound design, mobile touch controls (design only), and the legal and audit work. Do not add moves or mechanics beyond section 2; if the game feels thin, say so in the playtest notes and we will change the design deliberately.

## 9. Open questions for the dev and the owner
1. Does the closing-walls rule feel fair, or does it reward running away? (Tune the timing and the speed.)
2. Is the centre platform worth its complexity? (Cut it if balance suffers.)
3. Is a 3-heart round the right length, or should it be 4? Aim for a round median of 35 to 45 seconds.
4. Should a dash cost a heart-sized chunk of stamina, or less?
5. Are grabs too strong? (They beat guard and dash.) The bot matrix will say.

## 10. Where this lives in the PlayPot codebase
Existing pieces to mirror: `packages/game/src/jinx.ts` (pure rules), `jinxBot.ts` (bots), `jinxProtocol.ts` (signed logs), `packages/server/src/jinxRoom.ts` (referee state machine), `packages/web/src/practice.ts` (a practice mode vs a bot). The duel should be organised the same way so the referee can run the same simulation code the browser runs.
