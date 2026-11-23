/**
 * Organic final round: one reply carries both meshes. The decoded solid's `positions`, `triangles`, faces and edges are
 * the plate mesh with or without the view's `display` mesh, so what Stress slices (`chooseStudyMesh`, as `stressMesh`
 * calls it) and what Auto ribs reads (`panelSolid`: the posed positions and the face of each triangle) are byte for byte
 * the same. Only the viewport draws `display` (`drawnSolid`).
 */
import { decodeSolid, encodeSolid, type ParsedSolid } from "./model-reply.ts";
import { drawnSolid } from "./model-view/types.ts";
import { applyPose } from "./model-space.ts";
import { chooseStudyMesh } from "./sim/study-mesh.ts";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(name);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name}${detail ? ` ${detail}` : ""}`);
}

/** Two triangles a face on a 10 mm square, and the same faces finer (eight triangles each) for display. */
const coarse = [0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 0, 0, 10, 10, 0, 0, 10, 0];
const fine: number[] = [];
const fineFaces: number[] = [];
for (let i = 0; i < 4; i += 1) {
  const x = i * 2.5;
  fine.push(x, 0, 0, x + 2.5, 0, 0, x + 2.5, 10, 0, x, 0, 0, x + 2.5, 10, 0, x, 10, 0);
  fineFaces.push(0, 0);
}
const base = {
  volumeMm3: 0,
  positions: coarse,
  triangles: [0, 0],
  faces: [{ areaMm2: 100 }],
  edges: [{ lengthMm: 10, points: [0, 0, 0, 10, 0, 0] }],
};
const plain = decodeSolid({ id: 2, ...encodeSolid(base), fingerprint: { volumeMm3: 0, faces: 1, edges: 1 } }) as ParsedSolid;
const both = decodeSolid({ id: 2, ...encodeSolid({ ...base, display: { positions: fine, normals: fine.map((_, i) => (i % 3 === 2 ? 1 : 0)), triangles: fineFaces } }), fingerprint: { volumeMm3: 0, faces: 1, edges: 1 } }) as ParsedSolid;
check("both replies decode", typeof plain !== "string" && typeof both !== "string");
const same = (a: ArrayLike<number>, b: ArrayLike<number>) => a.length === b.length && Array.from(a).every((v, i) => Object.is(v, b[i]));
check("positions, triangles and edges are the plate mesh either way", same(plain.positions, both.positions) && same(plain.triangles, both.triangles) && same(plain.edges[0]!.points, both.edges[0]!.points));
check("the display mesh rides beside them", !plain.display && both.display?.positions.length === fine.length && both.display.triangles.length === 8);

// Stress, as stressMesh calls it: the picked mesh is the open solid's positions, the plate the plate's.
const study = (solid: ParsedSolid) => chooseStudyMesh({ picked: solid.positions, pickedTriangles: solid.triangles, plate: Float32Array.from(coarse), scale: 1, committed: true });
const a = study(plain);
const b = study(both);
check(
  "Stress slices the same mesh with or without the display mesh (the plate's, not a re-tessellation)",
  !!a && !!b && !("reason" in a) && !("reason" in b) && same(a.positions, b.positions) && same(a.unscaled, b.unscaled) && same(a.unscaled, Float32Array.from(coarse)),
);

// Auto ribs, as panelSolid reads it: the posed positions and each triangle's face.
const pose = { m: [1, 0, 0, 0, 1, 0, 0, 0, 1] as [number, number, number, number, number, number, number, number, number], t: [5, 0, 2] as [number, number, number] };
const posePoints = (points: ArrayLike<number>) => {
  const out: number[] = [];
  for (let i = 0; i + 2 < points.length; i += 3) out.push(...applyPose(pose, [points[i]!, points[i + 1]!, points[i + 2]!]));
  return out;
};
const wall = (solid: ParsedSolid) => ({ positions: Float32Array.from(posePoints(solid.positions)), faceOf: Uint32Array.from(solid.triangles) });
check("Auto ribs reads the same wall with or without the display mesh", same(wall(plain).positions, wall(both).positions) && same(wall(plain).faceOf, wall(both).faceOf));

// The viewport draws the display mesh, with the same face ids, and the plate mesh when there is none.
const drawn = drawnSolid(both);
check("the viewport draws the display mesh, its normals and its face of each triangle", drawn.positions === both.display!.positions && drawn.triangles === both.display!.triangles && drawn.normals === both.display!.normals && drawnSolid(both) === drawn);
check("with no display mesh the viewport draws the plate mesh", drawnSolid(plain) === plain);
check("a display triangle naming a face the solid does not have is refused", typeof decodeSolid({ id: 2, ...encodeSolid({ ...base, display: { positions: coarse, triangles: [0, 5] } }), fingerprint: null }) === "string");

if (failed) {
  console.error(`${failed} checks failed`);
  process.exit(1);
}
console.log("display mesh: plate readers unchanged, viewport draws display: ok");
