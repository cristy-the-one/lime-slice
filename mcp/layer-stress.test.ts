/**
 * `layer_image` coloured by a sliced stress result: each bead cut where it
 * crosses a cell line, each piece by its own cell. No engine needed.
 */
import assert from "node:assert/strict";
import { inflateSync } from "node:zlib";
import { rampColor, STRESS_RAMP } from "../src/colors.ts";
import type { PreviewPath } from "../src/preview-wire.ts";
import { parseStressCells } from "../src/sim/stress-cells.ts";
import { pathsPng } from "./layer-out.ts";

/** A 20 × 20 part on 10 mm cells, one slab: 1 MPa for x < 10, 9 MPa past it. */
function cellsReply(): string {
  const rows = [
    [0, 0, 0, 1, 1, 5],
    [0, 1, 0, 1, 1, 5],
    [1, 0, 0, 1, 9, 1],
    [1, 1, 0, 1, 9, 1],
  ];
  const buf = Buffer.alloc(rows.length * 24);
  rows.forEach(([i, j, k, phi, stress, safety], n) => {
    buf.writeUInt32LE(i!, n * 24);
    buf.writeUInt32LE(j!, n * 24 + 4);
    buf.writeUInt32LE(k!, n * 24 + 8);
    buf.writeFloatLE(phi!, n * 24 + 12);
    buf.writeFloatLE(stress!, n * 24 + 16);
    buf.writeFloatLE(safety!, n * 24 + 20);
  });
  return JSON.stringify({
    ok: true,
    report: { trust: "usable" },
    cells: {
      partToSlice: [
        [1, 0, 0, 0],
        [0, 1, 0, 0],
        [0, 0, 1, 0],
        [0, 0, 0, 1],
      ],
      originXy: [0, 0],
      hXy: 10,
      slabs: [[0, 1]],
      count: rows.length,
      cellsB64: buf.toString("base64"),
    },
  });
}

/** RGB pixels of an 8-bit truecolour PNG written with filter 0 on every row. */
function pixels(png: Uint8Array): { width: number; height: number; rgb: Uint8Array } {
  const view = Buffer.from(png);
  let at = 8;
  let width = 0;
  let height = 0;
  const idat: Buffer[] = [];
  while (at < view.length) {
    const length = view.readUInt32BE(at);
    const type = view.toString("ascii", at + 4, at + 8);
    const data = view.subarray(at + 8, at + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
    }
    if (type === "IDAT") idat.push(data);
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const rgb = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) rgb.set(raw.subarray(y * (width * 3 + 1) + 1, (y + 1) * (width * 3 + 1)), y * width * 3);
  return { width, height, rgb };
}

const cells = parseStressCells(cellsReply(), "obj");
assert.ok(cells);
/** Two beads the length of the part, each crossing the cell line at x = 10. */
const bead = (y: number): PreviewPath => ({
  kind: "solid",
  strategy: "speed",
  pts: [
    [0, y],
    [20, y],
  ],
  width: 0.45,
  speed: 60,
  effectiveSpeed: 60,
  toughness: 0,
  beadHeight: 0.2,
});
const png = pathsPng([bead(5), bead(15)], 256, "stress", { cells, studied: () => true, layerZ: 0.2 });
const { width, height, rgb } = pixels(png);
const hex = (h: string) => [1, 3, 5].map((o) => parseInt(h.slice(o, o + 2), 16));
const near = (x: number, y: number, h: string) => {
  const at = (y * width + x) * 3;
  const [r, g, b] = hex(h);
  return Math.abs(rgb[at]! - r!) + Math.abs(rgb[at + 1]! - g!) + Math.abs(rgb[at + 2]! - b!) < 30;
};
// Rows of the two beads, scanned across: cool up to the middle, hot past it.
let cool = { left: 0, right: 0 };
let hot = { left: 0, right: 0 };
const coolHex = rampColor(STRESS_RAMP, 1 / 9);
const hotHex = rampColor(STRESS_RAMP, 1);
for (let y = 0; y < height; y++) {
  for (let x = 0; x < width; x++) {
    const side = x < width / 2 - 4 ? "left" : x > width / 2 + 4 ? "right" : null;
    if (!side) continue;
    if (near(x, y, coolHex)) cool = { ...cool, [side]: cool[side] + 1 };
    if (near(x, y, hotHex)) hot = { ...hot, [side]: hot[side] + 1 };
  }
}
assert.ok(cool.left > 100 && cool.right === 0, `cool ${JSON.stringify(cool)}`);
assert.ok(hot.right > 100 && hot.left === 0, `hot ${JSON.stringify(hot)}`);

// Feature colours don't read the cells at all.
const plain = pixels(pathsPng([bead(5)], 256, "feature"));
let anyHot = 0;
for (let p = 0; p < plain.rgb.length; p += 3) {
  const [r, g, b] = hex(hotHex);
  if (Math.abs(plain.rgb[p]! - r!) + Math.abs(plain.rgb[p + 1]! - g!) + Math.abs(plain.rgb[p + 2]! - b!) < 30) anyHot += 1;
}
assert.equal(anyHot, 0);

console.log("layer-stress ok");
