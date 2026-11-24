// The Fight game's rules in plain Node: no browser, no graphics. A fake page stands in for the DOM, the sprite sheets load from the
// reference folders (the rules read the game's data files), and the renderer is replaced by an inert stand-in.
//   const { boot } = require("./lib/fight-headless-env.cjs");  const { g, fc } = await boot();
// boot() resolves once the game has finished starting up. Frames are then frozen: they only advance when the caller steps them.
const fs = require("fs"), vm = require("vm"), path = require("path");
const need = (k) => { if (!process.env[k]) throw new Error("set FIGHT_DIR and FIGHT_REF"); return process.env[k]; };
const REF = path.join(need("FIGHT_REF"), "TEMP_REF__site");
const MAIN = path.join(need("FIGHT_DIR"), "fork-core", "src", process.env.FIGHT_MAIN || "main.ws1.js");
const log = (...a) => { if (!process.env.FIGHT_QUIET) console.log(...a); };
const touched = {};
// A universal inert object: any property is another inert object, calling it returns one, and it can be iterated and compared.
function deep(name) {
  const target = function () {};
  return new Proxy(target, {
    get(t, k) {
      if (k === Symbol.toPrimitive) return () => 0;
      if (k === Symbol.iterator) return function* () {};
      if (k === "then") return undefined;
      if (typeof k === "symbol") return undefined;
      if (k === "length") return 0;
      if (k === "prototype") return t.prototype;
      touched[name + "." + String(k)] = (touched[name + "." + String(k)] || 0) + 1;
      return deep(name + "." + String(k));
    },
    set() { return true; },
    apply() { return deep(name + "()"); },
    construct() { return deep("new " + name); },
    has() { return true; },
  });
}
process.on("unhandledRejection", (e) => log("unhandledRejection:", String(e && e.message).slice(0, 160)));
const g = globalThis;
const def = (k, v) => Object.defineProperty(g, k, { value: v, configurable: true, writable: true });
def("self", g); def("window", g);
const store = new Map();
def("localStorage", { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k), clear: () => store.clear(), key: () => null, length: 0 });
class FakeImage {
  constructor() { this._l = {}; this.width = 0; this.height = 0; this.complete = false; this.naturalWidth = 0; this.naturalHeight = 0; this.style = {}; this.crossOrigin = ""; }
  addEventListener(t, fn) { (this._l[t] = this._l[t] || []).push(fn); }
  removeEventListener(t, fn) { this._l[t] = (this._l[t] || []).filter((x) => x !== fn); }
  set src(v) {
    this._src = v;
    setTimeout(() => {
      const p = typeof findAsset === "function" ? findAsset(v) : null;
      if (p) { const b = fs.readFileSync(p); if (b.length > 24) { this.width = this.naturalWidth = b.readUInt32BE(16); this.height = this.naturalHeight = b.readUInt32BE(20); } }
      else { this.width = this.naturalWidth = this.height = this.naturalHeight = 1; }
      this.complete = true;
      const ev = { type: "load", target: this };
      if (this.onload) this.onload(ev);
      for (const fn of this._l.load || []) fn(ev);
    }, 1);
  }
  get src() { return this._src; }
  decode() { return Promise.resolve(); }
  remove() {}
}
const docBase = deep("document");
def("document", new Proxy(docBase, { get(t, k, r) { if (k === "addEventListener") return (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); }; if (k === "removeEventListener") return () => {}; if (k === "createElement") return (tag) => (String(tag).toLowerCase() === "img" ? new FakeImage() : deep("element:" + tag)); if (k === "baseURI" || k === "URL" || k === "documentURI") return "http://localhost/"; if (k === "readyState") return "complete"; if (k === "hidden") return false; if (k === "visibilityState") return "visible"; if (k === "cookie") return ""; return Reflect.get(t, k, r); } }));
def("navigator", { userAgent: "node", appVersion: "5.0 (X11)", vendor: "", maxTouchPoints: 0, onLine: true, platform: "node", language: "en", languages: ["en"], getGamepads: () => [], hardwareConcurrency: 1, sendBeacon: () => true });
def("location", { href: "http://localhost/", origin: "http://localhost", host: "localhost", protocol: "http:", search: "", pathname: "/", hostname: "localhost" });
def("innerWidth", 960); def("innerHeight", 540); def("devicePixelRatio", 1);
g.__rafOn = true; let rafId = 0; def("requestAnimationFrame", (cb) => { if (g.__rafOn) setTimeout(() => { try { cb(performance.now()); } catch (e) {} }, 4); return ++rafId; }); def("cancelAnimationFrame", () => {});
const listeners = {};
def("addEventListener", (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); }); def("removeEventListener", () => {});
g.__fire = (t, ev) => { for (const fn of listeners[t] || []) { try { fn(ev); } catch (e) {} } };
for (const n of ["RTCPeerConnection", "webkitRTCPeerConnection", "HTMLElement", "HTMLCanvasElement", "HTMLImageElement", "OffscreenCanvas", "ResizeObserver", "MutationObserver", "WebGLRenderingContext", "WebGL2RenderingContext", "Worker", "MessageChannel", "XMLHttpRequest", "FontFace", "Path2D", "ImageBitmap", "matchMedia", "screen", "visualViewport", "IntersectionObserver", "SVGElement", "Element", "Node", "Event", "CustomEvent", "KeyboardEvent", "MouseEvent", "PointerEvent", "TouchEvent", "Touch", "DOMParser", "FileReader", "File", "ClipboardEvent", "DragEvent", "WheelEvent", "InputEvent", "FocusEvent", "XMLSerializer", "HTMLVideoElement", "HTMLMediaElement", "DOMException", "CSSStyleDeclaration", "getComputedStyle", "alert"]) if (!(n in g) || n === "Event" || n === "DOMException") { try { def(n, deep(n)); } catch {} }
const ROOTS = [REF, path.join(need("FIGHT_REF"), "TEMP_REF__assets")];
const fetched = [], missing404 = [];
function findAsset(u) {
  const rel = String(u).replace(/^https?:\/\/[^/]+/, "").replace(/\?.*$/, "").replace(/^\/+/, "");
  const dir = path.dirname(rel) === "." ? "" : path.dirname(rel);
  let leaf = path.basename(rel);
  if (leaf.startsWith("TEMP_REF__")) leaf = leaf.slice(10);
  for (const r of ROOTS) for (const name of ["TEMP_REF__" + leaf, "TEMP_REF__" + leaf.replace(/^\.+/, "")]) { const p = path.join(r, dir, name); if (fs.existsSync(p) && fs.statSync(p).isFile()) return p; }
  return null;
}
def("Image", FakeImage);
def("fetch", async (u) => {
  fetched.push(String(u));
  const p = findAsset(u);
  if (!p) { missing404.push(String(u)); }
  if (!p) return { ok: false, status: 404, statusText: "not found", headers: new Map(), json: async () => ({}), text: async () => "", arrayBuffer: async () => new ArrayBuffer(0), blob: async () => ({}) };
  const buf = fs.readFileSync(p);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return { ok: true, status: 200, statusText: "OK", url: String(u), headers: new Map([["content-type", "application/octet-stream"]]), json: async () => JSON.parse(buf.toString("utf8")), text: async () => buf.toString("utf8"), arrayBuffer: async () => ab, blob: async () => ({ size: buf.length, type: "image/png", __buf: buf }), clone() { return this; } };
});
def("createImageBitmap", async (b) => { const buf = b && b.__buf; const w = buf && buf.length > 24 ? buf.readUInt32BE(16) : 1, h = buf && buf.length > 24 ? buf.readUInt32BE(20) : 1; return { width: w, height: h, close() {} }; });
def("WebSocket", class { constructor() { throw new Error("no sockets in harness"); } });
g.IS_HARNESS = true;

function load(file) {
  let code = fs.readFileSync(file, "utf8");
  if (file === MAIN) code = code.replace("async function __step(name, fn) { try { await fn(); }", "async function __step(name, fn) { console.log(\"[boot step]\", name); try { await fn(); }").replace('await __step("renderer", () => Renderer.onEnter());', 'Renderer = __stub("Renderer"); /* harness: no renderer */').replace("window.__fc = {", "window.__fc = { get onlineSession(){return onlineSession;}, get RemotePeer(){return RemotePeer;}, get InputHistory(){return InputHistory;}, get InputState(){return InputState;}, fn_ftK: ()=>fn_ftK, fn_ft8: ()=>fn_ft8, ").replace("Promise.all([INSTANCE_fQk.Qat(), SoundManager.dat(true)]).then(", "console.log(\"[boot] waiting for first assets\"); Promise.all([INSTANCE_fQk.Qat(), SoundManager.dat(true)]).then(");
  vm.runInThisContext(code, { filename: path.basename(file) });
}

let booted;
/** Loads the game's scripts and waits for it to finish starting up. Safe to call once per process. */
function boot() {
  if (booted) return booted;
  booted = (async () => {
    const files = fs.readdirSync(REF).filter((f) => /^TEMP_REF__(vendor|\d+)\.[0-9a-f]+\.js$/.test(f));
    for (const f of files) { try { load(path.join(REF, f)); log("loaded", f); } catch (e) { log("FAILED", f, String(e.message).slice(0, 160)); } }
    load(MAIN);
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 300 && !(g.__fc && g.__fc.CM && g.__fc.CM.handlers); i++) await sleep(100);
    g.__rafOn = false; // from here on frames only advance when the caller steps them
    if (!(g.__fc && g.__fc.CM && g.__fc.CM.handlers)) throw new Error("the game did not finish starting up");
    return { g, fc: g.__fc, fetched, deep };
  })();
  return booted;
}
module.exports = { boot, deep };
