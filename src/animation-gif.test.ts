import assert from "node:assert/strict";
import { readGif } from "../tools/gif-read.ts";
import { animatedGif } from "./animation-gif.ts";

const size = 64, count = size * size;
const fill = (rgb: [number, number, number]) => { const out = new Uint8Array(count * 3); for (let i = 0; i < count; i++) out.set(rgb, i * 3); return out; };
const pixel = (frame: Uint8Array, i = 0) => [...frame.subarray(i * 3, i * 3 + 3)];

// A background the fixed 3/3/2 palette cannot hold: without the option it shifts, with it it survives in every frame.
const background: [number, number, number] = [0x12, 0xab, 0x56];
const scene = (value: number) => { const out = fill(background); for (let i = 200; i < 900; i++) out.set([value, value, value], i * 3); return out; };
const frames = [10, 120, 240].map((value) => ({ rgb: scene(value), delayCs: 8 }));
const plain = readGif(animatedGif(size, size, frames));
assert.notDeepEqual(pixel(plain.frames[0]!), background, "the plain palette does not hold this colour");
const kept = readGif(animatedGif(size, size, frames, background));
assert.equal(kept.frames.length, 3);
assert.equal(kept.palette.length, 256);
assert.equal(kept.localPalettes, 0, "every frame shares the one palette");
for (const frame of kept.frames) {
  assert.deepEqual(pixel(frame), background, "first corner");
  assert.deepEqual(pixel(frame, count - 1), background, "last corner");
}

// Only that one palette entry changes, and it is the entry the colour falls in.
const changed = plain.palette.flatMap((entry, i) => (entry.join() === kept.palette[i]!.join() ? [] : [i]));
assert.deepEqual(changed, [(0x12 & 0xe0) | ((0xab & 0xe0) >> 3) | (0x56 >> 6)]);
assert.deepEqual(pixel(kept.frames[1]!, 200), pixel(plain.frames[1]!, 200), "a part's pixel keeps its quantised colour");

// Colours at the palette's extremes, and enough varied pixels to fill and clear the LZW table.
for (const edge of [[0, 0, 0], [255, 255, 255], [248, 248, 255], [0x0b, 0x0d, 0x11]] as [number, number, number][]) {
  const noisy = fill(edge), side = 300, big = new Uint8Array(side * side * 3);
  let seed = 7;
  for (let i = 0; i < side * side; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; big.set([seed & 255, (seed >> 8) & 255, (seed >> 16) & 255], i * 3); }
  big.set(edge, 0);
  assert.deepEqual(pixel(readGif(animatedGif(size, size, [{ rgb: noisy, delayCs: 5 }], edge)).frames[0]!), edge);
  const decoded = readGif(animatedGif(side, side, [{ rgb: big, delayCs: 5 }], edge));
  assert.deepEqual(pixel(decoded.frames[0]!), edge, "exact after the LZW table resets");
}
console.log("animation-gif: exact background in one shared palette passed");
