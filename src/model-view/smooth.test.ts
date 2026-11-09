import { drawnEdgeSegments, smoothNormals } from "./smooth.ts";

let failed = 0;
function check(name: string, ok: boolean) {
  if (ok) return;
  failed += 1;
  console.error(`FAIL ${name}`);
}

/** A ring of `n` flat quads around Z (as a faceted cylinder wall), each quad two triangles, all one face, the seam doubled. */
function wall(n: number, face: number): { positions: number[]; triangles: number[] } {
  const positions: number[] = [];
  const triangles: number[] = [];
  const at = (i: number, z: number) => [Math.cos((i / n) * 2 * Math.PI), Math.sin((i / n) * 2 * Math.PI), z];
  for (let i = 0; i < n; i += 1) {
    const a0 = at(i, 0);
    const a1 = at(i + 1, 0);
    const b0 = at(i, 1);
    const b1 = at(i + 1, 1);
    positions.push(...a0, ...a1, ...b1, ...a0, ...b1, ...b0);
    triangles.push(face, face);
  }
  return { positions, triangles };
}

const ring = wall(16, 0);
const smooth = smoothNormals(ring.positions, ring.triangles);
// Each of 16 columns has 2 distinct points at the seam too (the ring closes on itself): 16 x 2 points.
check("a closed wall welds to one point per corner of the ring", smooth.points === 32);
const nx = (c: number) => [smooth.normals[c * 3]!, smooth.normals[c * 3 + 1]!, smooth.normals[c * 3 + 2]!];
const corner0 = nx(0);
// triangle 0's first corner is at angle 0; the normal there points out along +X, smooth, not the facet's own.
check("the normal at a vertex of a round face points straight out", Math.abs(corner0[0]! - 1) < 1e-6 && Math.abs(corner0[1]!) < 1e-6);
const seamSide = nx(30 * 3 + 1); // the last quad's far column is the first column again: the seam
check("the seam's two sides share one normal", Math.hypot(seamSide[0]! - corner0[0]!, seamSide[1]! - corner0[1]!, seamSide[2]! - corner0[2]!) < 1e-6);

// Two faces never share a normal: a box corner keeps three flat normals.
const faces = smoothNormals(
  [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0],
  [0, 1],
);
check("a corner shared by two faces is not averaged", faces.normals[2] === 1 && faces.normals[10] === 1 && faces.normals[11] === 0);

// A crease inside one face stays sharp.
const crease = smoothNormals([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0], [3, 3]);
check("a 90 degree crease inside one face stays sharp", crease.normals[2] === 1 && Math.abs(crease.normals[10]!) > 0.99);

// A flat face stays flat.
const flat = smoothNormals([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0], [0, 0]);
check("a flat face keeps its normal", [0, 1, 2, 3, 4, 5, 6, 7, 8].every((i) => (i % 3 === 2 ? Math.abs(flat.normals[i]! - 1) < 1e-6 : Math.abs(flat.normals[i]!) < 1e-6)));
check("a sliver with no area does not poison its neighbours", Number.isFinite(smoothNormals([0, 0, 0, 0, 0, 0, 0, 0, 0], [0]).normals[0]!));

// Seams stay out of the drawn lines and in the list.
const lines = [{ points: [0, 0, 0, 1, 0, 0] }, { points: [0, 0, 0, 0, 0, 1, 0, 0, 2] }, { points: [5, 5, 5, 6, 6, 6] }];
const drawn = drawnEdgeSegments(lines, [1]);
check("a seam is not drawn", drawn.drawn === 2 && drawn.segments.length === 12);
check("no seams draws every edge", drawnEdgeSegments(lines, undefined).segments.length === 24);

if (failed > 0) process.exit(1);
console.log("smooth tests passed");
