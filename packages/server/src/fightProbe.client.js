// Cross-browser determinism probe. Served only when the Fight page is opened with ?probe=SEED,FRAMES (for example
// /g/fight/?probe=7,1500). It plays a scripted match with seeded inputs, stepping frames by hand, and prints a short fingerprint of
// the game's own per-frame state hashes. Open it in different browsers: the same fingerprint means they computed the same match.
// It also fingerprints the browser's math functions on their own, so a difference can be traced to the function that causes it.
(function () {
  var q = new URLSearchParams(location.search).get("probe");
  if (q === null) return;
  var parts = q.split(",");
  var SEED = Number(parts[0]) || 7;
  var N = Number(parts[1]) || 1500;

  // frames only advance when this script says so
  var rafOn = true;
  var raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = function (cb) {
    return rafOn ? raf(cb) : 0;
  };

  var box;
  function show(lines) {
    if (!box) {
      box = document.createElement("pre");
      box.style.cssText = "position:fixed;left:8px;top:8px;z-index:2147483647;margin:0;padding:10px;max-width:96vw;max-height:94vh;overflow:auto;background:#fff;color:#000;font:13px/1.45 monospace;white-space:pre-wrap;border:2px solid #000";
      document.body.appendChild(box);
    }
    box.textContent = lines.join("\n");
  }
  function hex(n) {
    return ("00000000" + (n >>> 0).toString(16)).slice(-8);
  }
  // FNV-1a over UTF-16 code units, twice with different starting values (64 bits in all); strings are joined by a newline
  function Fp() {
    this.a = 2166136261;
    this.b = 3735928559;
    this.n = 0;
  }
  Fp.prototype.feed = function (s) {
    if (this.n++ > 0) s = "\n" + s;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      this.a = Math.imul(this.a ^ c, 16777619) >>> 0;
      this.b = Math.imul(this.b ^ c, 16777619) >>> 0;
    }
  };
  Fp.prototype.hex = function () {
    return hex(this.a) + hex(this.b);
  };

  // ---- the browser's own math, with no game involved ----
  function mathFingerprints() {
    var fns = {
      sin: function (x) { return Math.sin(x); },
      cos: function (x) { return Math.cos(x); },
      tan: function (x) { return Math.tan(x / 7); },
      atan: function (x) { return Math.atan(x / 9); },
      atan2: function (x, i) { return Math.atan2(x, 3.7 + (i % 11)); },
      pow: function (x, i) { return Math.pow(1.0007 + i * 0.0001, i * 0.5); },
      exp: function (x) { return Math.exp(x / 90); },
      log: function (x, i) { return Math.log(1 + i * 3.3); },
      sqrt: function (x, i) { return Math.sqrt(i * 1.7); },
    };
    var out = {};
    Object.keys(fns).forEach(function (k) {
      var f = new Fp();
      for (var i = 0; i < 2000; i++) f.feed(String(fns[k](i * 0.37 - 300, i)));
      out[k] = f.hex();
    });
    return out;
  }

  // the fixed replacements the hardened game build uses (window.__DM), fingerprinted the same way: these must match in every browser
  function dmFingerprints() {
    var D = window.__DM;
    if (!D) return null;
    var fns = {
      sin: function (x) { return D.sin(x); },
      cos: function (x) { return D.cos(x); },
      atan2: function (x, i) { return D.atan2(x, 3.7 + (i % 11)); },
      pow: function (x, i) { return D.pow(1.0007 + i * 0.0001, i * 0.5); },
      exp: function (x) { return D.exp(x / 90); },
      log: function (x, i) { return D.log(1 + i * 3.3); },
      hypot: function (x, i) { return D.hypot(x, i * 0.7); },
    };
    var out = {};
    Object.keys(fns).forEach(function (k) {
      var f = new Fp();
      for (var i = 0; i < 2000; i++) f.feed(String(fns[k](i * 0.37 - 300, i)));
      out[k] = f.hex();
    });
    return out;
  }

  function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }
  var result = { seed: SEED, frames: N, ua: navigator.userAgent, math: mathFingerprints(), dm: null, done: false };
  window.__probe = result;

  async function run() {
    if (!document.body) await new Promise(function (r) { document.addEventListener("DOMContentLoaded", r); }); // this script runs in the page head
    show(["probe " + SEED + "," + N, "math fingerprints:", JSON.stringify(result.math), "", "waiting for the game to start up (the first load can take a minute)..."]);
    for (var i = 0; i < 3000 && !(window.__fc && window.__fc.CM && window.__fc.CM.handlers); i++) await sleep(100);
    if (!(window.__fc && window.__fc.CM && window.__fc.CM.handlers)) {
      result.error = "the game did not start";
      result.done = true;
      show(["probe failed: the game did not start up"]);
      return;
    }
    rafOn = false;
    await sleep(300);
    var fc = window.__fc, GS = fc.GameSession;
    await fc.CM.startMatch();
    await sleep(500);
    for (i = 0; i < 400 && GS.executionFrame < 200; i++) GS.tick(); // every browser starts the script from the same frame
    var s = SEED | 0 || 1;
    function rnd() {
      s ^= s << 13;
      s ^= s >>> 17;
      s ^= s << 5;
      return (s >>> 0) / 4294967296;
    }
    // The stepping loop below must never yield to the browser: the game keeps a timer of its own, and any frame it ran in a gap would
    // change the result. Hence no progress display inside it.
    show(["probe " + SEED + "," + N, "playing " + N + " frames (the page may freeze for a few seconds)..."]);
    await sleep(50);
    var KEYS = [["KeyA", "a", 65], ["KeyD", "d", 68], ["KeyW", "w", 87], ["KeyF", "f", 70], ["KeyG", "g", 71], ["KeyE", "e", 69], ["ArrowLeft", "ArrowLeft", 37], ["ArrowRight", "ArrowRight", 39], ["Period", ".", 190], ["Slash", "/", 191]];
    var down = {};
    var fp = new Fp();
    result.hashes = []; // kept so a difference between two browsers can be traced to the first frame where they part
    var errors = 0, unavailable = 0, first = "";
    result.checkpoints = [];
    for (var f = 0; f < N; f++) {
      if (f % 8 === 0) {
        for (var k = 0; k < KEYS.length; k++) {
          var code = KEYS[k][0], want = rnd() < 0.3;
          var init = { code: code, key: KEYS[k][1], keyCode: KEYS[k][2], which: KEYS[k][2], bubbles: true };
          if (want && !down[code]) { down[code] = true; document.dispatchEvent(new KeyboardEvent("keydown", init)); }
          else if (!want && down[code]) { down[code] = false; document.dispatchEvent(new KeyboardEvent("keyup", init)); }
        }
      }
      try { GS.tick(); } catch (e) { errors++; }
      var h;
      try { h = String(GS.getFrameSnapshot(GS.executionFrame).G2()); } catch (e) { h = "err"; }
      if (h.indexOf("err") === 0) { h = "err"; unavailable++; }
      if (f === 0) first = h;
      result.hashes.push(h);
      if (f > 0) fp.feed(h); // the first frame carries a start-up counter that depends on when the page began, not on the math
      if ((f + 1) % 250 === 0) result.checkpoints.push((f + 1) + ":" + fp.hex());
    }
    result.dm = dmFingerprints();
    result.fingerprint = fp.hex();
    result.tickErrors = errors;
    result.framesUnavailable = unavailable;
    result.firstFrame = first;
    result.done = true;
    document.title = "probe " + result.fingerprint;
    show([
      "PROBE " + SEED + "," + N + "   (open the same address in each browser; the fingerprints must match)",
      "",
      "GAME FINGERPRINT: " + result.fingerprint,
      "frames: " + N + ", tick errors: " + errors + ", frames without a snapshot: " + unavailable,
      "checkpoints (cumulative): " + result.checkpoints.join("  "),
      "",
      result.dm ? "DETERMINISTIC MATH the game uses (must be identical in every browser):\n" + Object.keys(result.dm).map(function (m) { return "  " + m + ": " + result.dm[m]; }).join("\n") : "(this game build does not carry the deterministic math)",
      "",
      "THE BROWSER'S OWN MATH (no game involved; these may differ between browsers, which is why the game no longer uses them):",
      Object.keys(result.math).map(function (m) { return "  " + m + ": " + result.math[m]; }).join("\n"),
      "",
      "browser: " + navigator.userAgent,
    ]);
  }
  run().catch(function (e) {
    result.error = String(e && e.message);
    result.done = true;
    show(["probe failed: " + result.error]);
  });
})();
