import assert from "node:assert/strict";
import { colorForReading, OTHER_COLOR, rampColor, SAFETY_RAMP, STRESS_RAMP } from "../colors.ts";
import { cellAt, cellPieces, clearStressCells, onStressCells, parseStressCells, rememberStressCells, stressCellsFor } from "./stress-cells.ts";

/** `u32 i, j, slab, f32 fraction, stress, safety` per cell. */
function cellsB64(cells: [number, number, number, number, number, number][]): string {
  const buf = Buffer.alloc(cells.length * 24);
  cells.forEach(([i, j, k, phi, stress, safety], n) => {
    buf.writeUInt32LE(i, n * 24);
    buf.writeUInt32LE(j, n * 24 + 4);
    buf.writeUInt32LE(k, n * 24 + 8);
    buf.writeFloatLE(phi, n * 24 + 12);
    buf.writeFloatLE(stress, n * 24 + 16);
    buf.writeFloatLE(safety, n * 24 + 20);
  });
  return buf.toString("base64");
}

/** The part 50 mm along X in the slice frame, on 2 mm cells and two slabs. */
const reply = JSON.stringify({
  ok: true,
  report: { trust: "usable" },
  cells: {
    partToSlice: [
      [1, 0, 0, 50],
      [0, 1, 0, 0],
      [0, 0, 1, 0],
      [0, 0, 0, 1],
    ],
    originXy: [50, 0],
    hXy: 2,
    slabs: [
      [0, 0.8],
      [0.8, 1.8],
    ],
    count: 3,
    cellsB64: cellsB64([
      [0, 0, 0, 1, 4, 5],
      [1, 0, 0, 0.5, 12, 1.5],
      [0, 0, 1, 1, 2, 9],
    ]),
  },
});

const cells = parseStressCells(reply, "obj-1");
assert.ok(cells);
assert.equal(cells.peakMpa, 12);
assert.equal(cells.trust, "usable");

// Part (1, 1, 0.4) is slice (51, 1, 0.4): the first cell of the first slab.
assert.deepEqual(cellAt(cells, 1, 1, 0.4), { stressMpa: 4, safety: 5 });
assert.equal(cellAt(cells, 3, 1, 0.4)?.stressMpa, 12);
// The second slab starts at 0.8, so z 0.8 is in it.
assert.equal(cellAt(cells, 1, 1, 0.8)?.stressMpa, 2);
// Off the solved cells, and outside the slabs.
assert.equal(cellAt(cells, 5, 1, 0.4), null);
assert.equal(cellAt(cells, -1, 1, 0.4), null);
assert.equal(cellAt(cells, 1, 1, 2.5), null);

// A bead across the first two cells is cut at their line, slice x = 52, part x = 2.
const pieces = cellPieces(cells, [0.5, 1], [3.5, 1], 0.4);
assert.equal(pieces.length, 2);
assert.ok(Math.abs(pieces[0].t1 - 0.5) < 1e-12, String(pieces[0].t1));
assert.deepEqual(pieces.map((p) => p.reading?.stressMpa), [4, 12]);
// One running out of the solved cells ends in a piece with no reading.
assert.equal(cellPieces(cells, [3, 1], [6, 1], 0.4).at(-1)?.reading, null);

// The colours: stress over the peak, safety worst first, grey with no cell.
assert.equal(colorForReading("stress", { stressMpa: 12, safety: 1 }, 12), rampColor(STRESS_RAMP, 1));
assert.equal(colorForReading("stress", { stressMpa: 0, safety: 1 }, 12), rampColor(STRESS_RAMP, 0));
assert.equal(colorForReading("safety", { stressMpa: 0, safety: 0.5 }, 12), rampColor(SAFETY_RAMP, 0));
assert.equal(colorForReading("safety", { stressMpa: 0, safety: 3 }, 12), rampColor(SAFETY_RAMP, 1));
assert.equal(colorForReading("stress", null, 12), OTHER_COLOR);

// A failed or older reply has no cells.
assert.equal(parseStressCells(JSON.stringify({ ok: false, reason: "No." }), null), null);
assert.equal(parseStressCells(JSON.stringify({ ok: true, report: {} }), null), null);

// The store keeps the last solve for its object and tells the Preview.
let told = 0;
const off = onStressCells(() => {
  told += 1;
});
rememberStressCells("obj-1", reply);
assert.equal(told, 1);
assert.equal(stressCellsFor("obj-1")?.peakMpa, 12);
assert.equal(stressCellsFor("obj-2"), null);
assert.equal(stressCellsFor()?.objectId, "obj-1");
rememberStressCells("obj-1", JSON.stringify({ ok: false }));
assert.equal(told, 1, "a failed solve keeps the last cells");
clearStressCells();
assert.equal(stressCellsFor(), null);
assert.equal(told, 2);
off();

console.log("stress-cells ok");
