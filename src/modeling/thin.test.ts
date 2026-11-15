/**
 * The thin-wall scan (docs/plan-mcp-reliability.md, item 3). A wall's two sides face each other, as a knife edge's do;
 * a facet that leans off a rim, as the kernel meshes a curved wall near its rim, makes a corner the solid does not have,
 * and the scan read every ray beside it as a knife edge.
 */
import assert from "node:assert/strict";
import { thinWalls, WALL_FACING_DEG } from "./thin.ts";

type P = [number, number, number];

/** A closed solid from its faces, each a convex polygon; every triangle is turned to face away from `inside`. */
function solid(faces: P[][], inside: P): Float32Array {
  const out: number[] = [];
  for (const face of faces) {
    for (let k = 1; k + 1 < face.length; k += 1) {
      let [a, b, c] = [face[0]!, face[k]!, face[k + 1]!];
      const n = [(b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]), (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]), (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])];
      const centre = [0, 1, 2].map((i) => (a[i]! + b[i]! + c[i]!) / 3 - inside[i]!);
      if (n[0]! * centre[0]! + n[1]! * centre[1]! + n[2]! * centre[2]! < 0) [b, c] = [c, b];
      out.push(...a, ...b, ...c);
    }
  }
  return new Float32Array(out);
}

/** A box from the origin, `dx` by `dy` by `dz`. */
const box = (dx: number, dy: number, dz: number) => solid([
  [[0, 0, 0], [dx, 0, 0], [dx, dy, 0], [0, dy, 0]], [[0, 0, dz], [dx, 0, dz], [dx, dy, dz], [0, dy, dz]],
  [[0, 0, 0], [dx, 0, 0], [dx, 0, dz], [0, 0, dz]], [[0, dy, 0], [dx, dy, 0], [dx, dy, dz], [0, dy, dz]],
  [[0, 0, 0], [0, dy, 0], [0, dy, dz], [0, 0, dz]], [[dx, 0, 0], [dx, dy, 0], [dx, dy, dz], [dx, 0, dz]],
], [dx / 2, dy / 2, dz / 2]);

// A plate 10 mm square and 4 mm thick whose +X wall meets the top through a facet 0.02 mm tall that leans out 25°, as
// the kernel's mesh of a spline window's wall did at its rim (the clock's back plate: a sliver 0.022 mm tall, inward ray
// meeting the top after 0.024 mm). The solid's corner is square; the mesh's is 65°.
const lean = 0.02 * Math.tan((25 * Math.PI) / 180);
const rim = solid([
  [[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0]],
  [[0, 0, 4], [10 + lean, 0, 4], [10 + lean, 10, 4], [0, 10, 4]],
  [[0, 0, 0], [0, 10, 0], [0, 10, 4], [0, 0, 4]],
  [[10, 0, 0], [10, 10, 0], [10, 10, 3.98], [10, 0, 3.98]],
  [[10, 0, 3.98], [10, 10, 3.98], [10 + lean, 10, 4], [10 + lean, 0, 4]],
  [[0, 0, 0], [10, 0, 0], [10, 0, 3.98], [10 + lean, 0, 4], [0, 0, 4]],
  [[0, 10, 0], [10, 10, 0], [10, 10, 3.98], [10 + lean, 10, 4], [0, 10, 4]],
], [5, 5, 2]);
const before = thinWalls(rim, 0.8, 6000, { facingDeg: 180 });
assert.ok(before.regions.length > 0 && before.regions[0]!.thinnestMm < 0.05, `counting every face, the leaning facet reads as a knife edge: ${JSON.stringify(before.regions)}`);
const after = thinWalls(rim, 0.8);
assert.deepEqual(after.regions, [], "a rim at 90° is not a wall, however its facets lean");
assert.equal(after.sampled, before.sampled, "the same points are measured");

// Real thin places are still found: a plate 0.5 mm thick, and a 30° knife edge.
const sheet = thinWalls(box(10, 10, 0.5), 0.8);
assert.ok(sheet.regions.length > 0 && Math.abs(sheet.regions[0]!.thinnestMm - 0.5) < 0.01, JSON.stringify(sheet.regions));
assert.ok(sheet.areaMm2 > 150, `both faces of the sheet are thin: ${sheet.areaMm2} mm²`);
// Its two faces meet at 30°: each turns 15° from the middle plane.
const tip = 3 / Math.tan((15 * Math.PI) / 180);
const wedge = solid([
  [[0, 0, -3], [0, 10, -3], [0, 10, 3], [0, 0, 3]],
  [[0, 0, -3], [tip, 0, 0], [0, 0, 3]], [[0, 10, -3], [tip, 10, 0], [0, 10, 3]],
  [[0, 0, -3], [0, 10, -3], [tip, 10, 0], [tip, 0, 0]], [[0, 0, 3], [0, 10, 3], [tip, 10, 0], [tip, 0, 0]],
], [tip / 3, 5, 0]);
const edge = thinWalls(wedge, 0.8);
assert.ok(edge.regions.length > 0 && edge.regions.some((region) => region.centre[0] > tip - 3), `a 30° edge is a knife edge: ${JSON.stringify(edge.regions)}`);
// And a thick block is not thin anywhere, rims included.
assert.deepEqual(thinWalls(box(10, 10, 4), 0.8).regions, []);
assert.equal(WALL_FACING_DEG, 45);
console.log("thin walls: a leaning rim facet is not a knife edge; a thin sheet and a 30° edge still are");
