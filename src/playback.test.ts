import { layerClasses } from "./playback.ts";

let failed = 0;

function eq<T>(name: string, actual: T, expected: T): void {
  if (JSON.stringify(actual) === JSON.stringify(expected)) return;
  failed += 1;
  console.error(`FAIL ${name}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

/** The per-bar classifier the histogram used before it classed a whole result at once, kept as the oracle. */
function layerClass(seconds: number[], index: number, floorS = 8): "slow" | "fast" | "ok" {
  if (seconds.length === 0) return "ok";
  const sorted = [...seconds].sort((a, b) => a - b);
  const mid = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const value = seconds[index] ?? 0;
  if (value > Math.max(mid * 2, mid + 1)) return "slow";
  if (value > 0 && value < floorS) return "fast";
  return "ok";
}

const sample = [12, 3.5, 30, 0, 9, 8, 7.99, 12, 25.1, 100, 12.5];
eq("a hand sample", layerClasses(sample), ["ok", "fast", "slow", "ok", "ok", "ok", "fast", "ok", "slow", "slow", "ok"]);
eq("the oracle agrees on the hand sample", sample.map((_, i) => layerClass(sample, i)), layerClasses(sample));
eq("no layers", layerClasses([]), []);
eq("a small part: slow needs a full second over a sub-second median", layerClasses([0.4, 0.5, 0.45, 1.2, 2.1]), ["fast", "fast", "fast", "fast", "slow"]);

let seed = 0x2545f491;
const rand = () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 2 ** 32;
};
for (let trial = 0; trial < 300; trial++) {
  const length = 1 + Math.floor(rand() * 1100);
  const times = Array.from({ length }, () => {
    const roll = rand();
    if (roll < 0.05) return 0;
    if (roll < 0.15) return 8;
    if (roll < 0.25) return Math.round(rand() * 20);
    return rand() * (roll < 0.9 ? 30 : 400);
  });
  const want = times.map((_, i) => layerClass(times, i));
  eq(`random print ${trial} (${length} layers)`, layerClasses(times), want);
}

if (failed) throw new Error(`${failed} playback check(s) failed`);
console.log("playback: layer classes ok");
