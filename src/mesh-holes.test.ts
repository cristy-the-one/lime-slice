import assert from "node:assert/strict";
import { closeHoles, edgeReport } from "./mesh-check.ts";

type V = [number, number, number];

/** A box of the given size as twelve outward triangles. */
function box(size: V): number[] {
  const [x, y, z] = size;
  const c: V[] = [[0, 0, 0], [x, 0, 0], [x, y, 0], [0, y, 0], [0, 0, z], [x, 0, z], [x, y, z], [0, y, z]];
  const quads = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];
  return quads.flatMap(([a, b, d, e]) => [c[a!]!, c[b!]!, c[d!]!, c[a!]!, c[d!]!, c[e!]!].flat());
}

/** Six times the volume a closed soup encloses; positive when it faces outward. */
function volume(p: ArrayLike<number>): number {
  let six = 0;
  for (let i = 0; i + 8 < p.length; i += 9) {
    six += p[i]! * (p[i + 4]! * p[i + 8]! - p[i + 5]! * p[i + 7]!) - p[i + 1]! * (p[i + 3]! * p[i + 8]! - p[i + 5]! * p[i + 6]!) + p[i + 2]! * (p[i + 3]! * p[i + 7]! - p[i + 4]! * p[i + 6]!);
  }
  return six / 6;
}

const whole = box([10, 20, 30]);

// A closed mesh comes back closed, with nothing added.
{
  const { positions, report } = closeHoles(whole);
  assert.equal(positions.length, whole.length);
  assert.deepEqual({ holes: report.holes, added: report.added, openBefore: report.openBefore, openAfter: report.openAfter }, { holes: 0, added: 0, openBefore: 0, openAfter: 0 });
}

// One triangle missing: a three-edge hole, filled facing outward.
{
  const { positions, report } = closeHoles(whole.slice(9));
  assert.deepEqual({ holes: report.holes, added: report.added, openBefore: report.openBefore, openAfter: report.openAfter }, { holes: 1, added: 1, openBefore: 3, openAfter: 0 });
  assert.equal(edgeReport(positions).open, 0);
  assert.ok(Math.abs(volume(positions) - 6000) < 1e-3, `volume ${volume(positions)}`);
}

// A whole side missing: a four-edge hole takes two triangles.
{
  const { positions, report } = closeHoles(whole.slice(18));
  assert.deepEqual({ holes: report.holes, added: report.added, openAfter: report.openAfter }, { holes: 1, added: 2, openAfter: 0 });
  assert.equal(report.largestLoopMm, 60);
  assert.ok(Math.abs(volume(positions) - 6000) < 1e-3, `volume ${volume(positions)}`);
}

// Two holes on opposite sides are two loops.
{
  const { positions, report } = closeHoles([...whole.slice(18, 36 - 9), ...whole.slice(36)]);
  assert.equal(report.holes, 2);
  assert.equal(report.openAfter, 0);
  assert.ok(Math.abs(volume(positions) - 6000) < 1e-3, `volume ${volume(positions)}`);
}

// A loop over the length limit stays open, and is counted.
{
  const { positions, report } = closeHoles(whole.slice(18), { maxLoopMm: 50 });
  assert.deepEqual({ holes: report.holes, skipped: report.skipped, openAfter: report.openAfter }, { holes: 0, skipped: 1, openAfter: 4 });
  assert.equal(positions.length, whole.length - 18);
}

// An L-shaped hole is concave: its fill must stay inside the L. Volume says so.
{
  // A 30 x 30 x 10 plate whose top is nine 10 mm squares; three of them (an L) are left out.
  const top: number[] = [];
  const cell = (i: number, j: number) => [[i * 10, j * 10, 10], [i * 10 + 10, j * 10, 10], [i * 10 + 10, j * 10 + 10, 10], [i * 10, j * 10 + 10, 10]] as V[];
  for (let i = 0; i < 3; i += 1) for (let j = 0; j < 3; j += 1) {
    if ((i === 0 && j === 0) || (i === 1 && j === 0) || (i === 0 && j === 1)) continue;
    const [a, b, c, d] = cell(i, j);
    top.push(...a!, ...b!, ...c!, ...a!, ...c!, ...d!);
  }
  const plate = box([30, 30, 10]);
  // Everything but the plate's own top (triangles 2 and 3), with sides cut at the cell corners by closeCracks.
  const soup = [...plate.slice(0, 18), ...plate.slice(36), ...top];
  const { positions, report } = closeHoles(soup);
  assert.equal(report.holes, 1);
  assert.equal(report.openAfter, 0);
  assert.ok(Math.abs(volume(positions) - 9000) < 1e-3, `volume ${volume(positions)}`);
}

console.log("mesh-holes ok");
