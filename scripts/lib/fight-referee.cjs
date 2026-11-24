// The Fight referee: replays a recorded match through the game's own network code and reports who won.
//
// The record holds every message the relay forwarded, in order, each tagged with who sent it. The referee boots the game headless
// (no browser, no graphics) as a match in which BOTH players are remote: the host's messages feed one remote peer and the
// guest's feed the other, so the game's own decoder rebuilds each player's inputs exactly as a real opponent's client would. The
// game's own match logic then plays the rounds and decides each KO, and its own desync check compares the referee's state with
// the state hashes the two real clients sent every 60 frames. Nothing about the rules is reimplemented here.
const { boot, deep } = require("./fight-headless-env.cjs");

const tick = () => new Promise((r) => setImmediate(r));

async function replayRecord(record, opts = {}) {
  const { fc } = await boot();
  const { CM, NET, GameSession: GS, onlineSession, RemotePeer, InputHistory, InputState, PlayerSlot, InputSettingsComponent, PlayerProfile } = fc;
  const fn_ftK = fc.fn_ftK(), fn_ft8 = fc.fn_ft8();
  const warn = [];
  if (!CM.ui) CM.ui = deep("ui");

  const settings = [null, null];
  const rdBy = [-1, -1];
  const queued = new Map(); // messages that arrive for a round the referee has not reached yet: tag -> [[side, text]]
  const remotes = [null, null];
  const own = new Map(); // the referee's own state hash for each stamped frame: tag -> Map(frame -> hash), as the game itself computed it
  let roundLive = false;
  let started = false;
  const rounds = [];

  // ---- the referee's version of the two network hooks the game calls at the start of a round ----
  NET.active = true;
  NET.host = false;
  NET.myIdx = 0;
  NET.send = () => {};
  NET.makePlayers = () =>
    [0, 1].map((i) => {
      const rs = settings[i] ? InputSettingsComponent.fromSettingsString(settings[i]) : new InputSettingsComponent();
      const p = new PlayerSlot(NET.ids[i], "P" + (i + 1), i, i + 1, null, CM.loadout(i), rs);
      p.isRemote = true;
      p.inputHistory = new InputHistory(10);
      p.accountId = NET.ids[i];
      return p;
    });
  NET.setupRound = (players) => {
    NET.tag += 1;
    const S = GS;
    S.qq = 0; S.targetFrameDelay = 2; S.inputFrame = S.targetFrameDelay; S.executionFrame = 0; S.lastSyncedFrame = 0; S.rollbacks = [];
    onlineSession.flag_rV = false; onlineSession.mV = Date.now(); onlineSession.flag__Q = false; onlineSession.flag_WQ = false;
    onlineSession.Rb = true; onlineSession.isSpectator = false; onlineSession.teamId = 1;
    for (const i of [0, 1]) {
      if (!remotes[i]) {
        const rp = (remotes[i] = new RemotePeer(NET.ids[i]));
        rp.Xq = 1; rp.displayName = "P" + (i + 1); rp.teamId = i + 1; rp.isHost = i === 0;
        rp.connection = { connected: true, send() {} }; // the referee never answers
      }
      const r = remotes[i];
      r.num_XK = -1; r.num_VK = -1; r.num_QK = 0; r.map_KK = new Map(); r.map_lQ = new Map(); r.num_AQ = 0; r.CQ = [];
    }
    onlineSession.remotes = [remotes[0], remotes[1]];
    onlineSession.EQ();
    fn_ftK();
    players.forEach((p) => { p.rQ = []; });
    fn_ft8(players);
    S.inputBuffers.Mb();
    S.currentWorld.worldState.entityIdGenerator.Mb();
    players.forEach((p) => S.inputBuffers.Pb(p));
    for (let f = 0; f < S.inputFrame + 1; f++) for (const p of players) S.inputBuffers.$b(p.playerIndex, f, new InputState());
    S.setSeed(NET.seed);
    roundLive = true;
    checkedUpTo = -1;
    rounds.push({ tag: NET.tag, startedAtEntry: cursor });
    for (const [side, text] of queued.get(NET.tag) || []) remotes[side].CQ.push(text);
    queued.delete(NET.tag);
  };
  NET.install(); // the game's own rule that screen changes are applied only at the top of a frame

  const STAMP = /(?:^|\|)g(\d+)\$([^|]*)/g;
  // The game stamps frame 59, 119, 179... with a hash of its state. As the referee's game confirms frames (all inputs known, no
  // prediction), record the hash it computes for each stamped frame, while that frame's snapshot is still in its 100-frame window.
  let checkedUpTo = -1;
  function recordOwn() {
    if (!own.has(NET.tag)) own.set(NET.tag, new Map());
    const m = own.get(NET.tag);
    for (let f = checkedUpTo + 1; f <= GS.lastSyncedFrame; f++) {
      if (f % 60 !== 59) continue;
      const sn = GS.getFrameSnapshot(f);
      if (sn && !m.has(f)) m.set(f, String(sn.G2()));
    }
    checkedUpTo = GS.lastSyncedFrame;
  }
  let cursor = 0;
  /** Steps the game until it cannot go further with the messages it has. */
  async function pump() {
    if (!roundLive) return;
    let idle = 0;
    for (let i = 0; i < 20000 && idle < 3; i++) {
      const tagBefore = NET.tag;
      const before = GS.executionFrame * 1e7 + GS.lastSyncedFrame * 10 + NET.tag;
      try { GS.tick(); } catch (e) { warn.push("tick: " + String(e.message).slice(0, 120)); if (warn.length > 20) throw e; }
      if (NET.tag === tagBefore) recordOwn(); // a tick that changed rounds has no frames of its own to stamp
      const after = GS.executionFrame * 1e7 + GS.lastSyncedFrame * 10 + NET.tag;
      idle = after === before ? idle + 1 : 0;
      if (i % 200 === 199) await tick();
    }
    await tick();
  }

  async function control(side, m) {
    if (m.t === "hello") settings[side] = m.settings;
    else if (m.t === "sel") {
      CM.sel[side] = m.sel;
      CM.ready[side] = m.ready;
      if (side === 0 && m.fmt) CM.fmt = m.fmt;
    } else if (m.t === "start" && side === 0 && !started) {
      started = true;
      NET.seed = m.seed;
      CM.fmt = m.fmt;
      PlayerProfile.profileData.stageId = m.stage;
      CM.mode = "select";
      await CM.startMatch();
      for (let i = 0; i < 50 && !roundLive; i++) { GS.tick(); await tick(); }
    } else if (m.t === "rd") {
      rdBy[side] = Math.max(rdBy[side], m.n);
      NET.peerRd = Math.min(rdBy[0], rdBy[1]);
      CM.netBarrier();
      for (let i = 0; i < 5; i++) { await tick(); }
    }
  }

  const entries = record.entries;
  for (cursor = 0; cursor < entries.length; cursor++) {
    const e = entries[cursor];
    const text = e.payload;
    if (text.charAt(0) === "c") {
      let m;
      try { m = JSON.parse(text.slice(1)); } catch { warn.push("bad control message at " + cursor); continue; }
      await control(e.side, m);
    } else if (text.charAt(0) === "r") {
      const k = text.indexOf(":");
      const tag = Number(text.slice(1, k));
      const body = text.slice(k + 1);
      if (roundLive && tag === NET.tag) remotes[e.side].CQ.push(body);
      else if (!roundLive || tag > NET.tag) { if (!queued.has(tag)) queued.set(tag, []); queued.get(tag).push([e.side, body]); }
      // an older round's message: the real clients drop it too
    }
    if (cursor % 4 === 3 || cursor === entries.length - 1) await pump();
  }
  // everything the players sent has been delivered: let the game finish confirming frames
  for (let i = 0; i < 20; i++) { await pump(); if (CM.phase === "over") break; }

  // Audit: every state hash a client reported, in every copy the relay forwarded, must equal the hash the referee's game computed
  // for the same frame of the same round. (The game's own check skips stamps for frames that have left its snapshot window.)
  let checked = 0, withoutOwn = 0;
  const mismatches = [];
  const seen = new Set();
  for (const e of entries) {
    const t = e.payload;
    if (t.charAt(0) !== "r") continue;
    const k = t.indexOf(":");
    const tag = Number(t.slice(1, k));
    for (const x of t.slice(k + 1).matchAll(STAMP)) {
      const frame = Number(x[1]), key = tag + "/" + e.side + "/" + frame + "/" + x[2];
      if (seen.has(key)) continue;
      seen.add(key);
      const mine = own.get(tag) && own.get(tag).get(frame);
      if (mine === undefined) { withoutOwn++; continue; }
      checked++;
      if (mine !== x[2] && mismatches.length < 10) mismatches.push({ round: tag, side: e.side === 0 ? "host" : "guest", frame, reported: x[2], referee: mine });
      else if (mine !== x[2]) mismatches.push(null);
    }
  }
  const need = Math.floor(CM.fmt / 2) + 1;
  const done = CM.score[0] >= need || CM.score[1] >= need;
  return {
    finished: CM.phase === "over" && done,
    phase: CM.phase,
    score: [CM.score[0], CM.score[1]],
    winner: !done ? null : CM.score[0] >= need ? "host" : "guest",
    bestOf: CM.fmt,
    rounds: CM.round,
    framesInLastRound: GS.executionFrame,
    confirmedFrame: GS.lastSyncedFrame,
    refereeStampsByRound: [...own].map(([t, m]) => [t, m.size, [...m.keys()].slice(0, 3)]),
    stampsChecked: checked,
    stampsWithoutRefereeHash: withoutOwn,
    stampMismatches: mismatches.length,
    firstMismatches: mismatches.filter(Boolean).slice(0, 3),
    desync: !!onlineSession.flag_YQ || mismatches.length > 0, // the game's own check, or any reported hash that differs from the referee's // the game's own check found a state hash from a real client that does not match the referee's
    warnings: warn,
    messages: entries.length,
  };
}

module.exports = { replayRecord };
