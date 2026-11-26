import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const src = readFileSync(fileURLToPath(new URL("../../../scripts/lib/deterministic-math.src.js", import.meta.url)), "utf8");
const DM = new Function(`return ${src}`)() as Record<"sin" | "cos" | "atan2" | "pow" | "exp" | "log" | "hypot", (...a: number[]) => number>;

// a fixed pseudo-random sequence, so the test is repeatable
let seed = 12345;
const rnd = () => {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return (seed >>> 0) / 4294967296;
};
const rel = (a: number, b: number) => (a === b ? 0 : Math.abs(a - b) / Math.max(Math.abs(b), 1e-300));
const worst = (n: number, f: (i: number) => [number, number]) => {
  let w = 0;
  for (let i = 0; i < n; i++) {
    const [got, want] = f(i);
    w = Math.max(w, Math.abs(got - want) <= 1e-15 ? 0 : rel(got, want));
  }
  return w;
};

describe("deterministic math", () => {
  it("sin and cos agree with the engine's to within a couple of units in the last digit over a wide range, and keep their zeros", () => {
    const maxAbs = (n: number, span: number, f: (x: number) => [number, number]) => {
      let w = 0;
      for (let i = 0; i < n; i++) {
        const [got, want] = f((rnd() - 0.5) * span);
        w = Math.max(w, Math.abs(got - want));
      }
      return w;
    };
    for (const span of [20, 2000, 90000]) {
      const ws = maxAbs(20000, span, (x) => [DM.sin(x), Math.sin(x)]);
      assert.ok(ws < 5e-16, `sin over +-${span / 2}: worst ${ws}`);
      assert.ok(maxAbs(20000, span, (x) => [DM.cos(x), Math.cos(x)]) < 5e-16, `cos over +-${span / 2}`);
    }
    assert.equal(Object.is(DM.sin(-0), -0), true);
    assert.equal(DM.cos(0), 1);
    assert.ok(Math.abs(DM.sin(Math.PI)) < 1e-15);
    assert.ok(Number.isNaN(DM.sin(Infinity)) && Number.isNaN(DM.cos(NaN)));
  });
  it("atan2 matches in every quadrant and at the axes and zeros", () => {
    assert.ok(worst(20000, () => { const y = (rnd() - 0.5) * 400, x = (rnd() - 0.5) * 400; return [DM.atan2(y, x), Math.atan2(y, x)]; }) < 1e-13);
    for (const [y, x] of [[0, 1], [0, -1], [1, 0], [-1, 0], [0, 0], [-0, 0], [0, -0], [-0, -0], [1, 1], [-1, -1], [1, -1], [-1, 1], [5, Infinity], [Infinity, 5], [Infinity, Infinity], [-Infinity, -Infinity]]) {
      const got = DM.atan2(y, x), want = Math.atan2(y, x);
      assert.ok(Object.is(got, want) || Math.abs(got - want) < 1e-15, `atan2(${y}, ${x}): ${got} vs ${want}`);
    }
  });
  it("pow is exact for whole exponents of two and three and close for fractional ones", () => {
    for (let i = 0; i < 2000; i++) {
      const x = rnd() * 200 - 100;
      assert.equal(DM.pow(x, 2), x * x);
    }
    for (let e = -20; e <= 40; e++) assert.equal(DM.pow(2, e), Math.pow(2, e));
    assert.ok(worst(20000, () => { const x = rnd() * 100 + 1e-3, y = (rnd() - 0.5) * 12; return [DM.pow(x, y), Math.pow(x, y)]; }) < 1e-12);
    assert.ok(worst(5000, () => { const x = rnd() * 60 + 0.5, y = 0.95; return [DM.pow(x, y), Math.pow(x, y)]; }) < 1e-13); // the exponent the game's tumble formula uses
    assert.ok(worst(5000, () => { const x = (rnd() - 0.5) * 8; return [DM.pow(x, 3), Math.pow(x, 3)]; }) < 1e-13);
    assert.equal(DM.pow(5, 0), 1);
    assert.equal(DM.pow(0, 3), 0);
    assert.equal(DM.pow(0, -1), Infinity);
    assert.ok(Number.isNaN(DM.pow(-2, 0.5)) && Number.isNaN(DM.pow(NaN, 2)));
    assert.equal(DM.pow(4, 0.5), 2);
  });
  it("exp and log agree with the engine's and undo each other", () => {
    assert.ok(worst(20000, () => { const x = (rnd() - 0.5) * 100; return [DM.exp(x), Math.exp(x)]; }) < 1e-12);
    assert.ok(worst(20000, () => { const x = rnd() * 1000 + 1e-6; return [DM.log(x), Math.log(x)]; }) < 1e-12);
    assert.ok(worst(2000, () => { const x = rnd() * 50 + 0.1; return [DM.exp(DM.log(x)), x]; }) < 1e-13);
    assert.equal(DM.exp(0), 1);
    assert.equal(DM.log(1), 0);
    assert.equal(DM.exp(1000), Infinity);
    assert.equal(DM.exp(-1000), 0);
    assert.equal(DM.log(0), -Infinity);
    assert.ok(Number.isNaN(DM.log(-1)));
  });
  it("hypot is the square root of the sum of squares", () => {
    assert.equal(DM.hypot(3, 4), 5);
    assert.ok(worst(2000, () => { const a = rnd() * 100, b = rnd() * 100; return [DM.hypot(a, b), Math.hypot(a, b)]; }) < 1e-14);
  });
  it("uses nothing an engine is free to compute differently", () => {
    // the source may only call Math.floor, Math.abs and Math.sqrt: everything else it needs it builds from + - * /
    const used = [...src.matchAll(/Math\.([A-Za-z0-9_]+)/g)].map((m) => m[1]);
    for (const name of used) assert.ok(["floor", "sqrt"].includes(name), `uses Math.${name}`);
  });
});
