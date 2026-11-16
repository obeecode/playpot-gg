---
title: "STICK DUEL: game spec for the first playable"
---

# STICK DUEL: game spec for the first playable

A tiny real-time 2D stickman duel. Two fighters, one screen, matches of about 2 to 5 minutes, played in the browser. Working title.

This is the whole brief for the first deliverable. Everything marked **(tunable)** is a starting value to be tuned by playing, not a requirement. Numbers are the starting point for the first playtest; the feel of the timing is the product.

## Contents
1. The idea, and what "done" looks like
2. The game rules
3. Order of operations in one tick
4. Determinism rules (non-negotiable)
5. What to build, in order
6. The match log format
7. Testing the design: the bot matrix and playtest metrics
8. Review and handoff
9. Out of scope
10. Open questions
11. Glossary

---

## 1. The idea, and what "done" looks like

We want a game where the skill is **timing, spacing and reading the opponent**: skill that a player develops by feel over many matches. No move is a guaranteed win, a better player wins most of the time but not all of it, and there is nothing to memorise. Think Nidhogg (a one-hit sword duel), Divekick (two buttons, deep mind games), and the basics of fighting games: neutral, spacing, punishing a missed attack.

**Constraints**

- Plays in a phone or desktop browser with no install. A 2D canvas is plenty. Do not use WebGPU.
- A match ends fast: best of 3 rounds takes about 2 minutes, best of 5 never longer than 5.
- Few elements, high dynamism. Two fighters, a floor, two walls, one small platform. Nothing else on screen changes the outcome.
- Steady 60 simulation updates per second on a mid-range phone from the last few years. Measure it.
- **Fully deterministic** (section 4). The result of a match is a pure function of the two players' inputs.

**The first deliverable is done when:**

- [ ] Two people can play a full best-of-3 and best-of-5 match on one keyboard, using the rules in section 2.
- [ ] A match can be replayed from its recorded inputs and gives the identical result.
- [ ] The determinism self-test passes (section 5).
- [ ] The three practice bots work and the bot matrix has been run and reported (section 7).
- [ ] The simulation is a standalone module with tests, runnable in the browser and in Node unchanged.

## 2. The game rules

### 2.1 Arena and fighters
- One screen, logical size **960 x 540 px**. Flat floor, solid walls left and right, and one small centre platform (160 px wide, its top 110 px above the floor; **tunable**, and it may be cut if it hurts balance).
- The platform is one-way: a fighter can jump up through it and lands on top. There is no drop-through. A fighter can walk off its edge and fall.
- Each fighter has **3 hearts**, a **stamina bar** (0 to 1000 internally, shown as a bar), and a body box of 24 x 64 px.
- Fighters start mirrored, 360 px apart (x = 300 and x = 660). Player 1 starts on the left. A fighter always faces the opponent, and the facing is fixed at the start of an action.
- **Fighters are solid against each other.** Their bodies cannot overlap horizontally unless one fighter is high enough that its feet are above the other's head (this is how a jump crosses over). When bodies push each other, split the push evenly between them, and give any odd leftover unit to Player 2.
- **Corner rule:** a fighter hit toward a wall stops at the wall, and the attacker is pushed back by the leftover distance, so nobody can trap the other in a corner.

### 2.2 The seven inputs
**left, right, jump, strike, guard, grab, dash.**

- Jump, strike, grab and dash trigger on the tick the button goes down (the rising edge). Guard is held.
- **Input buffer:** a pressed action is remembered for 4 ticks (**tunable**) and fires as soon as the fighter is free to act.
- Left and right pressed together cancel.
- If several actions are pressed on the same tick, they are chosen in this order: **dash, grab, strike, guard, jump, walk.**

### 2.3 Actions
All times are in ticks (60 per second).

| Action | Rule (starting values, **tunable**) |
|---|---|
| **Walk** | 2.5 px per tick forward, 2.0 backward. Not while attacking or in stun. |
| **Jump** | Launch speed 9 px per tick up, gravity 0.45 px per tick squared. About 40 ticks in the air, peak about 90 px. A little air steering (1 px per tick). No guard or grab in the air. |
| **Strike** | Startup 6, active 3, recovery 14. Reach 70 px in front. Costs 100 stamina. Hits for 1 heart. Blocked by a guard. |
| **Air strike (dive)** | Press strike in the air: a downward diagonal slash. Startup 5, active until landing, then 10 ticks of landing recovery. Costs 100 stamina. 1 heart. Blocked by a guard. |
| **Guard** | Hold. Active from tick 5 (a startup of 4). Blocks strikes and dives from the front. Each blocked hit costs the guarder 200 stamina and leaves them in 10 ticks of block-stun. At 0 stamina the guard breaks: 40 ticks of stun. **Parry:** a hit that lands during the first 5 ticks the guard is active (ticks 5 to 9) is parried. The attacker is stunned for 24 ticks and the guarder gets 300 stamina back. |
| **Grab** | Startup 10, active 2, recovery **26** if it misses. Reach 40 px. Costs 150 stamina. **A guard does not stop a grab.** A grab that connects: 1 heart and a throw (knockback, 30 ticks of stun for the victim). A grab loses to any strike that is already active. |
| **Dash** | Forward or back. Startup 2, lasts 14 ticks, covers about 120 px, then 8 ticks of recovery. Costs 250 stamina. Ticks 3 to 8 are invulnerable to strikes and dives (not to grabs). |

**The core triangle:** guard beats strike, grab beats guard, strike beats grab (it is faster). Dash beats a strike but loses to a grab. Jump and dash are about **spacing**: getting out of range, baiting a missed attack, crossing over. Nothing is a guaranteed win, so players develop a feel for each other's habits.

**Design rule to keep in mind while tuning:** the first-contact decision should be a **read, not a reaction**. Core actions start faster than a person can see and answer them (people need roughly 12 to 15 ticks), so the choice has to be made before the opponent's move is visible. Punishing a missed attack is where a script beats a person, so keep the numbers such that a human can win those exchanges by anticipation. The bot matrix (section 7) is how we check this. Do not skip it.

### 2.4 Stamina
- Regenerates 2 per tick, after 30 ticks without attacking, guarding or dashing (**tunable**). Costs are in the table above. Parries give stamina back.
- With empty stamina there is no dash, grab, strike or dive. Walking and jumping still work, and guarding works until the guard breaks.
- This is the resource game: spamming anything runs you dry.

### 2.5 Hits, hearts, rounds and the match
- A hit removes 1 heart, causes hit-stun (18 ticks, **tunable**) and knockback (a short push away; **tunable**), and a **hit-stop** freeze of 3 ticks. Hit-stop is part of the simulation because it changes timing, so it is not a visual effect.
- When two hits land on the same tick, both fighters lose a heart (a trade).
- After hit-stun ends, a fighter has 8 ticks of protection from being hit again, so there are no endless chains.
- **A round ends** when a fighter reaches 0 hearts or when the timer runs out.
- **Round timer: 45 seconds (2700 ticks).** From tick 1800 the walls close in at 0.5 px per tick each, down to a minimum arena width of 240 px (reached at about tick 2520). Stalling stops working.
- **Timer end:** the fighter with more hearts wins. Tied on hearts: more stamina wins. Still tied: the round is replayed once; if tied again it is a draw round and counts for nobody. If both fighters reach 0 hearts on the same tick, use the same tie-break (stamina, then a replay).
- **Match:** the default is best of 3 rounds (first to 2). Best of 5 (first to 3) is an option. There are 3 seconds of intro before each round and 3 seconds of break. A best-of-5 match cannot run past about 5 minutes by construction.
- There is **no randomness** anywhere. Spawn positions are fixed.

### 2.6 Controls (desktop prototype)

| | Player 1 | Player 2 |
|---|---|---|
| Move | A, D | Left, Right |
| Jump | W | Up |
| Strike, Guard, Grab | J, K, L | `,` `.` `/` |
| Dash | S | Down |

Any other mapping is fine if it is shown on screen. Gamepad is optional. For later, touch controls: left and right pad bottom-left, jump above it, four large buttons (strike, guard, grab, dash) bottom-right, no swipe gestures for core actions.

### 2.7 Look and feel
Minimal stickmen (a head, a body, limbs drawn from a few lines), flat colours, one accent colour per fighter, and posed animation per action. Screen shake, particles and sound are **visual only** and must never touch the simulation. It must read clearly at phone size. The first version can be ugly if the timing is clear.

### 2.8 Constants in integer units
Fixed point with 8 fractional bits: **1 px = 256 units.** These follow from the table above, so the code and the spec agree.

| Value | In px | In units |
|---|---|---|
| Walk forward / backward | 2.5 / 2.0 per tick | 640 / 512 per tick |
| Jump launch speed | 9 per tick | 2304 per tick |
| Gravity | 0.45 per tick squared | 115 per tick squared |
| Air steering | 1 per tick | 256 per tick |
| Wall closing speed | 0.5 per tick | 128 per tick |
| Arena width | 960 | 245760 |

---

## 3. Order of operations in one tick

Two implementations of the game must agree on every tick, so the order is part of the rules.

1. Read both players' inputs and update the input buffers.
2. Decide each fighter's next action state (the priority order in 2.2), and advance action timers.
3. If a hit-stop freeze is active, count it down and stop here (nothing else moves).
4. Apply movement and gravity, then collide with the floor, walls and platform.
5. Detect hits for both fighters **at the same time**, against the positions from step 4. Apply guard, parry, damage, stun, knockback, hit-stop and stamina changes together, so a trade is symmetric.
6. Push the two bodies apart (the push rule in 2.1) and apply the corner rule.
7. Regenerate stamina, advance the wall-closing and the round timer, and check whether the round or match has ended.

## 4. Determinism rules (non-negotiable)

The simulation is a pure function: `step(state, inputsP1, inputsP2) -> state`. The same inputs from the same start give the same result on every device and in a Node process, every time.

- **Integers only.** Every position, speed, timer and stamina value is an integer. Use fixed point (section 2.8). Multiply by integers and shift right. Do not divide, and do not use floating-point numbers or maths functions in the simulation at all.
- **No `Math.random`, `Date.now`, `performance.now`, `Math.sin` and friends, object key order, or `Map`/`Set` iteration order** in the simulation. This version does not need randomness.
- **Fixed time step:** 60 ticks per second regardless of the screen's refresh rate. The renderer interpolates. The simulation never reads a clock.
- **Small, serializable state.** `serialize(state)` and `deserialize(bytes)` must round-trip exactly. Keep the whole state to a few dozen integers.
- **A state hash** (for example FNV-1a over the state's int32 fields) can be computed after any tick. Take a checkpoint every 60 ticks.
- **Keep the step function small and simple:** roughly tens of integer operations per fighter per tick, no loops over unbounded data, no clever tricks. It may need to be re-implemented in a different environment later, and that only works if it stays tiny.
- Inputs are a 7-bit mask per player per tick. The input buffer (2.2) is part of the simulation state.
- Visual effects live outside the simulation and may use floats and randomness freely.

## 5. What to build, in order

No network, no accounts, no money. The goal is to find out whether the game is fun, and to prove it is deterministic.

1. **A single playable page** (one HTML file is fine) for two players on one keyboard, with:

   - the full match flow: rounds, timer, closing walls, best of 3 and best of 5;
   - **three practice bots** (section 7) that can play either side;
   - **replay:** every match records its inputs. A "watch replay" button plays it back, and the result must be identical;
   - **a determinism self-test button:** run the same recorded input log twice (and once inside a Web Worker if feasible) and show that the final state hashes match;
   - **a debug view:** toggle hitboxes, show each fighter's current state and frame number, slow motion and single-step;
   - **export** of the match log as JSON (section 6).
2. **The simulation as a standalone, dependency-free TypeScript module** that does not touch the DOM, so it runs unchanged in the browser and in Node. Suggested location in this repo: `packages/game/src/duel.ts`, organised like `jinx.ts` (pure rules, `newMatch`, `step`, `hash`, serialization), plus `duelBot.ts` like `jinxBot.ts`.
3. **Tests** (Node's built-in test runner, like the other packages):

   - golden input logs with their expected final hashes;
   - serialization round-trip;
   - a fuzz test that runs a few thousand random input logs twice and compares hashes;
   - a unit test for each row of the table in 2.3: frame counts, damage, parry window, guard break, stamina limits, timer, closing walls, tie-breaks, trades, the corner rule.

## 6. The match log format

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

`inputs[t]` is `[maskP1, maskP2]` for tick `t` (run-length compressing repeated entries is welcome). Replaying `inputs` from `newMatch` must reproduce every checkpoint hash and the result. Version the rules: changing any number in the tables is a new `version`.

## 7. Testing the design: the bot matrix and playtest metrics

### 7.1 Bot matrix (the key test)
Fast-reaction games favour scripts, so we measure that before building anything on top. Build these bots, run each against the others for a few thousand matches, and report the matrix of win rates after every tuning pass.

| Bot | Behaviour |
|---|---|
| **Reactor-0** | Perfect: answers anything visible with the correct counter on the very next tick |
| **Reactor-12** | The same, with a 12-tick delay and a 10% chance of choosing the wrong answer |
| **Mixer** | Picks actions at random with sensible weights (no reading) |
| **Pattern reader** | Tracks what the opponent did in its last 10 situations and counters the most common choice |

**Pass condition (starting values, adjust once real people have played):** no single bot beats all the others by more than 70% over a long run, and Reactor-0 must not beat both the Pattern reader and the Mixer above 85%. If perfect reactions dominate, the game fails the "reads over reflexes" rule. Fix it by changing startup and recovery numbers, not by adding rules.

The three practice bots in the prototype are Reactor-0, Reactor-12 and Mixer. The Pattern reader is used in the matrix test.

### 7.2 Playtest metrics, logged per match (all computable from the input log)
- Round length: target median **35 to 45 seconds**, with at most 15% of rounds decided by the timer.
- Heart loss by cause (strike, dive, grab, parry punish), and how often each action is chosen.
- Stalemate time: ticks in which neither fighter attacks.
- Miss rates per action, guard-break frequency, and how often stamina hits empty.
- The win rate of the Player 1 side (it should be about 50%; there is no side advantage by design).

### 7.3 Human-feel checks
- Hits and reactions feel responsive at 60 ticks per second, with no input lag from the page itself. Measure input-to-screen time on a mid-range phone and on a laptop.
- A new player understands guard, strike and grab within a minute of the practice mode. Add a short on-screen explanation of the triangle.

## 8. Review and handoff
- Build the prototype and publish it as a **claude.ai artifact**, the same way the JINX prototype was shared. Share it so the project owner can open it, and send them the link.
- The owner will ask Claude to open the artifact and review it against this spec. It will check that the controls and match flow work; that the numbers in 2.3 match the code (frame counts in particular); that the determinism rules in section 4 are followed in the code (no floats, no clock, no randomness in the simulation); that the self-test, replay and export work; and that the bot matrix results are reported.
- After the review, the simulation module and tests go into the repo.

## 9. Out of scope
Networking, accounts and wallets, anything involving payments or contracts, matchmaking, ranking, spectating, characters and cosmetics, sound design, touch controls (design only), and all legal work. Do not add moves or mechanics beyond section 2. If the game feels thin, say so in the playtest notes and the design will be changed deliberately.

## 10. Open questions
1. Does the closing-walls rule feel fair, or does it reward running away? (Tune the timing and speed.)
2. Is the centre platform worth its complexity? (Cut it if balance suffers.)
3. Is a 3-heart round the right length, or should it be 4? Aim for a median round of 35 to 45 seconds.
4. Is the dash's stamina cost right?
5. Are grabs too strong? (They beat guard and dash.) The bot matrix will say.

## 11. Glossary
- **Tick:** one step of the simulation, 1/60 of a second.
- **Startup, active, recovery:** the three phases of an attack. Startup is the wind-up, active is when it can hit, recovery is the time you cannot act afterwards.
- **Whiff / miss:** an attack that hits nothing, which leaves you in recovery.
- **Punish:** hitting an opponent during their recovery.
- **Parry:** a guard timed to the first few ticks, which turns the attack back on the attacker.
- **Hit-stun / block-stun:** time a fighter cannot act after being hit or after blocking.
- **Hit-stop:** a tiny freeze when a hit lands, which makes it feel solid.
- **Trade:** both fighters hit each other on the same tick.
- **Neutral, spacing:** the part of a fight before anyone has landed a hit: choosing where to stand and when to commit.
- **Read:** guessing what the opponent will do next from how they have been playing.
