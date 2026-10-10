import { FEATURE_COLOR, hexRgb, OTHER_COLOR, rampColor, SPEED_RAMP, WEIGHT_RAMP, colorForPath, SPEED_RANGE_MM_S } from "./colors.ts";

let failed = 0;

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) return;
  failed += 1;
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}

type Lab = [number, number, number];

const linear = (v: number) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

/** sRGB hex to CIELAB (D65). `cvd` first maps the linear color through a color-vision-deficiency matrix. */
function lab(hex: string, cvd?: number[][]): Lab {
  let rgb = hexRgb(hex).map(linear);
  if (cvd) rgb = cvd.map((row) => row[0] * rgb[0] + row[1] * rgb[1] + row[2] * rgb[2]);
  const [r, g, b] = rgb;
  const x = 0.4124564 * r + 0.3575761 * g + 0.1804375 * b;
  const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const z = 0.0193339 * r + 0.119192 * g + 0.9503041 * b;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
  const fx = f(x / 0.95047);
  const fy = f(y);
  const fz = f(z / 1.08883);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** CIEDE2000 (Sharma, Wu, Dalal 2005). */
function deltaE(p: Lab, q: Lab): number {
  const rad = Math.PI / 180;
  const [L1, a1, b1] = p;
  const [L2, a2, b2] = q;
  const cBar = (Math.hypot(a1, b1) + Math.hypot(a2, b2)) / 2;
  const g = 0.5 * (1 - Math.sqrt(cBar ** 7 / (cBar ** 7 + 25 ** 7)));
  const a1p = (1 + g) * a1;
  const a2p = (1 + g) * a2;
  const C1 = Math.hypot(a1p, b1);
  const C2 = Math.hypot(a2p, b2);
  const hue = (y: number, x: number) => (x === 0 && y === 0 ? 0 : ((Math.atan2(y, x) / rad) + 360) % 360);
  const h1 = hue(b1, a1p);
  const h2 = hue(b2, a2p);
  let dh = 0;
  if (C1 * C2 !== 0) {
    dh = h2 - h1;
    if (dh > 180) dh -= 360;
    else if (dh < -180) dh += 360;
  }
  const dH = 2 * Math.sqrt(C1 * C2) * Math.sin((dh * rad) / 2);
  const Lbar = (L1 + L2) / 2;
  const Cbar = (C1 + C2) / 2;
  let hbar = h1 + h2;
  if (C1 * C2 !== 0) hbar = Math.abs(h1 - h2) <= 180 ? hbar / 2 : (hbar < 360 ? hbar + 360 : hbar - 360) / 2;
  const T = 1 - 0.17 * Math.cos((hbar - 30) * rad) + 0.24 * Math.cos(2 * hbar * rad) + 0.32 * Math.cos((3 * hbar + 6) * rad) - 0.2 * Math.cos((4 * hbar - 63) * rad);
  const Sl = 1 + (0.015 * (Lbar - 50) ** 2) / Math.sqrt(20 + (Lbar - 50) ** 2);
  const Sc = 1 + 0.045 * Cbar;
  const Sh = 1 + 0.015 * Cbar * T;
  const Rt = -2 * Math.sqrt(Cbar ** 7 / (Cbar ** 7 + 25 ** 7)) * Math.sin(60 * Math.exp(-(((hbar - 275) / 25) ** 2)) * rad);
  const dL = (L2 - L1) / Sl;
  const dC = (C2 - C1) / Sc;
  const dHs = dH / Sh;
  return Math.sqrt(dL ** 2 + dC ** 2 + dHs ** 2 + Rt * dC * dHs);
}

// Machado, Oliveira and Fernandes 2009, full severity, on linear RGB.
const PROTAN = [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]];
const DEUTAN = [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.01182, 0.04294, 0.968881]];

const STAGE = "#0b0d11";

near("ΔE00 of identical colors is zero", deltaE(lab("#E0690E"), lab("#E0690E")), 0, 1e-9);
// Pairs from Sharma, Wu and Dalal's published test data.
near("ΔE00 reference pair 1", deltaE([50, 2.6772, -79.7751], [50, 0, -82.7485]), 2.0425, 1e-3);
near("ΔE00 reference pair 2", deltaE([50, 2.5, 0], [73, 25, -18]), 27.1492, 1e-3);

function near(name: string, actual: number, expected: number, tol: number): void {
  check(name, Math.abs(actual - expected) <= tol, `got ${actual}, want ${expected}`);
}

/** Features whose beads sit next to each other in a print, or one over the other, so the eye has to split them. */
const TOUCHING: [string, string][] = [
  ["outer", "inner"],
  ["outer", "skirt"],
  ["inner", "sparse"],
  ["inner", "solid"],
  ["sparse", "solid"],
  ["solid", "top"],
  ["top", "outer"],
  ["top", "inner"],
  ["top", "ironing"],
  ["top", "support"],
  ["bridge", "solid"],
  ["bridge", "sparse"],
  ["bridge", "outer"],
  ["bridge", "inner"],
  ["bridge", "support-interface"],
  ["support", "support-interface"],
  ["support", "outer"],
  ["support", "sparse"],
  ["support-interface", "top"],
  ["support-interface", "solid"],
  ["gap-fill", "outer"],
  ["gap-fill", "inner"],
  ["gap-fill", "solid"],
  ["gap-fill", "sparse"],
  ["thin-wall", "outer"],
  ["thin-wall", "inner"],
  ["thin-wall", "gap-fill"],
  ["thin-wall", "bridge"],
  ["thin-wall", "top"],
  ["wall", "outer"],
  ["wall", "sparse"],
];

const MIN_TOUCHING = 25;
const MIN_TOUCHING_CVD = 10;
const MIN_STAGE = 30;

for (const [a, b] of TOUCHING) {
  const ca = FEATURE_COLOR[a];
  const cb = FEATURE_COLOR[b];
  check(`${a} and ${b} have colors`, !!ca && !!cb);
  if (!ca || !cb) continue;
  const normal = deltaE(lab(ca), lab(cb));
  check(`${a} / ${b} stay apart`, normal >= MIN_TOUCHING, `ΔE00 ${normal.toFixed(1)}`);
  for (const [name, matrix] of [["protan", PROTAN], ["deutan", DEUTAN]] as const) {
    const seen = deltaE(lab(ca, matrix), lab(cb, matrix));
    check(`${a} / ${b} stay apart for ${name} viewers`, seen >= MIN_TOUCHING_CVD, `ΔE00 ${seen.toFixed(1)}`);
  }
}

for (const [kind, color] of Object.entries({ ...FEATURE_COLOR, other: OTHER_COLOR })) {
  const stage = deltaE(lab(color), lab(STAGE));
  if (kind === "travel") {
    check("travel stays dim", lab(color)[0] < 45, `L* ${lab(color)[0].toFixed(0)}`);
    check("travel still shows on the stage", stage >= 15, `ΔE00 ${stage.toFixed(1)}`);
    continue;
  }
  check(`${kind} reads on the stage`, stage >= MIN_STAGE, `ΔE00 ${stage.toFixed(1)}`);
  const L = lab(color)[0];
  // Gap fill is the one pale feature: a sliver of it has to show between two colored walls.
  const ceiling = kind === "gap-fill" ? 93 : 82;
  check(`${kind} is mid-tone`, L >= 40 && L <= ceiling, `L* ${L.toFixed(0)}`);
}

for (const [name, ramp] of [["speed", SPEED_RAMP], ["weight", WEIGHT_RAMP]] as const) {
  for (let i = 0; i <= 10; i++) {
    const color = rampColor(ramp, i / 10);
    const stage = deltaE(lab(color), lab(STAGE));
    check(`${name} ramp at ${i / 10} reads on the stage`, stage >= MIN_STAGE, `ΔE00 ${stage.toFixed(1)}`);
  }
  check(`${name} ramp starts on its first stop`, rampColor(ramp, 0) === ramp[0].toLowerCase());
  check(`${name} ramp passes through its middle stop`, rampColor(ramp, 0.5) === ramp[1].toLowerCase());
  check(`${name} ramp ends on its last stop`, rampColor(ramp, 1) === ramp[2].toLowerCase());
  const ends = deltaE(lab(ramp[0]), lab(ramp[2]));
  check(`${name} ramp ends are far apart`, ends >= 40, `ΔE00 ${ends.toFixed(1)}`);
}

const speedL = [0, 0.25, 0.5, 0.75, 1].map((t) => lab(rampColor(SPEED_RAMP, t))[0]);
check("the speed ramp gets lighter as it speeds up", speedL.every((v, i) => i === 0 || v > speedL[i - 1]), speedL.map((v) => v.toFixed(0)).join(" "));

const [slow, fast] = SPEED_RANGE_MM_S;
check("path color follows the mode", colorForPath("outer", "feature") === FEATURE_COLOR.outer);
check("travel keeps its color in any mode", colorForPath("travel", "speed", 0, fast) === FEATURE_COLOR.travel);
check("speed mode starts on the slow stop", colorForPath("outer", "speed", 0, slow) === SPEED_RAMP[0].toLowerCase());
check("weight mode ends on the heavy stop", colorForPath("outer", "weight", 1) === WEIGHT_RAMP[2].toLowerCase());

if (failed) {
  console.error(`${failed} check(s) failed`);
  process.exit(1);
}
console.log("colors.test.ts ok");
