(function () {
  // Replacements for the Math functions that JavaScript engines are allowed to compute a little differently (sin, cos, atan2, pow,
  // exp, log, hypot), built only from + - * /, comparisons, floor, sqrt and %. Those operations are exactly
  // specified by IEEE 754 and the language, so every browser, and Node on any system, gives the same bits for the same input.
  // Accurate to about 1e-15 (relative), which is far finer than the game needs. This file is one expression: scripts/harden-game-math.mjs
  // pastes it into the game build, and the server's tests load it to check accuracy.
  var PI = 3.141592653589793;
  var PIO2 = 1.5707963267948966;
  var TWO_PI = 6.283185307179586;
  var INV_PIO2 = 0.6366197723675814;
  // pi/2 split so that n * piece is exact for the small n used below (fdlibm's constants)
  var PIO2_1 = 1.57079632673412561417e+00;
  var PIO2_2 = 6.07710050630396597660e-11;
  var PIO2_3 = 2.02226624871116645580e-21;
  var LN2_HI = 6.93147180369123816490e-01;
  var LN2_LO = 1.90821492927058770002e-10;
  var LOG2E = 1.4426950408889634;

  var SC = [], CC = [], AC = [], EC = [], LC = [];
  (function () {
    var f = 1, k;
    var fact = [1];
    for (k = 1; k <= 24; k++) fact[k] = fact[k - 1] * k;
    for (k = 0; k < 12; k++) {
      SC[k] = (k % 2 === 0 ? 1 : -1) / fact[2 * k + 1];
      CC[k] = (k % 2 === 0 ? 1 : -1) / fact[2 * k];
    }
    for (k = 0; k < 22; k++) EC[k] = 1 / fact[k];
    for (k = 0; k < 20; k++) AC[k] = (k % 2 === 0 ? 1 : -1) / (2 * k + 1);
    for (k = 0; k < 16; k++) LC[k] = 1 / (2 * k + 1);
  })();

  function sinKernel(r) {
    var r2 = r * r, p = SC[11];
    for (var k = 10; k >= 0; k--) p = p * r2 + SC[k];
    return r * p;
  }
  function cosKernel(r) {
    var r2 = r * r, p = CC[11];
    for (var k = 10; k >= 0; k--) p = p * r2 + CC[k];
    return p;
  }
  // the quarter turn the angle falls in, and the remainder within it
  var reducedN = 0;
  function reduce(x) {
    if (x > 100000 || x < -100000) x = x % TWO_PI; // % is exact (fmod) by the language definition
    var n = Math.floor(x * INV_PIO2 + 0.5);
    reducedN = ((n % 4) + 4) % 4;
    return ((x - n * PIO2_1) - n * PIO2_2) - n * PIO2_3;
  }
  function sin(x) {
    x = +x;
    if (x !== x || x === Infinity || x === -Infinity) return NaN;
    if (x === 0) return x;
    var r = reduce(x), q = reducedN;
    return q === 0 ? sinKernel(r) : q === 1 ? cosKernel(r) : q === 2 ? -sinKernel(r) : -cosKernel(r);
  }
  function cos(x) {
    x = +x;
    if (x !== x || x === Infinity || x === -Infinity) return NaN;
    var r = reduce(x), q = reducedN;
    return q === 0 ? cosKernel(r) : q === 1 ? -sinKernel(r) : q === 2 ? -cosKernel(r) : sinKernel(r);
  }
  // arctangent of t in [0, 1]: halve the angle twice (atan t = 2 atan(t / (1 + sqrt(1 + t t)))), then a series
  function atanUnit(t) {
    t = t / (1 + Math.sqrt(1 + t * t));
    t = t / (1 + Math.sqrt(1 + t * t));
    var t2 = t * t, p = AC[19];
    for (var k = 18; k >= 0; k--) p = p * t2 + AC[k];
    return 4 * t * p;
  }
  function atan2(y, x) {
    y = +y;
    x = +x;
    if (y !== y || x !== x) return NaN;
    if (y === 0) {
      if (x > 0 || (x === 0 && 1 / x > 0)) return y;
      return 1 / y > 0 ? PI : -PI;
    }
    if (x === 0) return y > 0 ? PIO2 : -PIO2;
    var ax = x < 0 ? -x : x, ay = y < 0 ? -y : y, a;
    if (ax === Infinity && ay === Infinity) a = PI / 4;
    else if (ax === Infinity) a = 0;
    else if (ay === Infinity) a = PIO2;
    else if (ay <= ax) a = atanUnit(ay / ax);
    else a = PIO2 - atanUnit(ax / ay);
    if (x < 0) a = PI - a;
    return y < 0 ? -a : a;
  }
  function exp(x) {
    x = +x;
    if (x !== x) return NaN;
    if (x > 709.782712893384) return Infinity;
    if (x < -745.2) return 0;
    var k = Math.floor(x * LOG2E + 0.5);
    var r = (x - k * LN2_HI) - k * LN2_LO;
    var p = EC[21];
    for (var i = 20; i >= 0; i--) p = p * r + EC[i];
    while (k > 0) {
      p *= 2;
      k--;
    }
    while (k < 0) {
      p *= 0.5;
      k++;
    }
    return p;
  }
  function log(x) {
    x = +x;
    if (x !== x || x < 0) return NaN;
    if (x === 0) return -Infinity;
    if (x === Infinity) return Infinity;
    var e = 0;
    while (x >= 1.4142135623730951) {
      x *= 0.5;
      e++;
    }
    while (x < 0.7071067811865476) {
      x *= 2;
      e--;
    }
    var s = (x - 1) / (x + 1), s2 = s * s, p = LC[15];
    for (var k = 14; k >= 0; k--) p = p * s2 + LC[k];
    return e * LN2_HI + (2 * s * p + e * LN2_LO);
  }
  function pow(x, y) {
    x = +x;
    y = +y;
    if (y === 0) return 1;
    if (x !== x || y !== y) return NaN;
    if (y === 1) return x;
    if (y === 2) return x * x;
    if (y === 0.5 && x >= 0) return Math.sqrt(x);
    if (y === Math.floor(y) && y >= -1024 && y <= 1024) {
      var n = y < 0 ? -y : y, result = 1, b = x;
      while (n > 0) {
        if (n % 2 === 1) result *= b;
        b *= b;
        n = Math.floor(n / 2);
      }
      return y < 0 ? 1 / result : result;
    }
    if (x === 0) return y > 0 ? 0 : Infinity;
    if (x < 0) return NaN; // a negative base with a fractional exponent
    if (x === Infinity) return y > 0 ? Infinity : 0;
    return exp(y * log(x));
  }
  function hypot(a, b) {
    return Math.sqrt(a * a + b * b);
  }
  return { sin: sin, cos: cos, atan2: atan2, pow: pow, exp: exp, log: log, hypot: hypot };
})()
