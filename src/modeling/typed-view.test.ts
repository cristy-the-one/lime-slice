/**
 * The solid as the reads answer it (src/modeling/typed-view.ts): in the frame ops are typed in. Identity is the solid
 * itself; a move and a turn carry the mesh, each face's normal, centre, box and axis (a sphere's centre), each edge's
 * points and direction, and the box, with indexes and kinds kept. Then the refusal's frame sentence (placing.ts).
 */
import { typedDir, typedPoint, typedView } from "./typed-view.ts";
import { frameWhere } from "./placing.ts";
import { IDENTITY_POSE, type Affine } from "../model-space.ts";
import type { EdgeRow, FaceRow } from "./solid-geometry.ts";

let failed = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
  if (ok) {
    console.log(`ok   ${name}`);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name} ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 2000)}`);
}
type V = [number, number, number];
const near = (a: readonly number[] | undefined, b: readonly number[], tol = 1e-5) => !!a && b.every((v, i) => Math.abs(a[i]! - v) <= tol);

// One flat triangle at z = 10 (face 0, normal +Z) and one triangle of a "sphere" face (face 1) about (0, 0, 20).
const positions = new Float32Array([0, 0, 10, 10, 0, 10, 0, 10, 10, 0, 0, 40, 20, 0, 20, 0, 20, 20]);
const triangles = new Uint32Array([0, 1]);
const faces: FaceRow[] = [
  { index: 0, areaMm2: 50, normal: [0, 0, 1], centre: [10 / 3, 10 / 3, 10], bbox: { min: [0, 0, 10], max: [10, 10, 10] }, kind: "plane" },
  { index: 1, areaMm2: 300, normal: [0.5, 0.5, 0.7], centre: [6.7, 6.7, 26.7], bbox: { min: [0, 0, 20], max: [20, 20, 40] }, kind: "sphere", radiusMm: 20, axis: [0, 0, 1], axisPoint: [0, 0, 20] },
];
const edges: EdgeRow[] = [{ index: 0, lengthMm: 10, start: [0, 0, 10], end: [10, 0, 10], mid: [5, 0, 10], dir: [1, 0, 0] }];
const solid = { positions, triangles, faces, edges, bounds: { min: [0, 0, 10] as V, max: [20, 20, 40] as V }, lines: [{ edge: 0, points: new Float32Array([0, 0, 10, 10, 0, 10]) }], volumeMm3: 1 };

check("identity reads the solid itself", typedView(solid, IDENTITY_POSE) === solid);

const moved: Affine = { m: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [200, 0, 0] };
const m = typedView(solid, moved);
check("a move shifts the box", near(m.bounds.min, [200, 0, 10]) && near(m.bounds.max, [220, 20, 40]), m.bounds);
check("a move shifts a face's centre and box, not its normal", near(m.faces[0]!.centre, [200 + 10 / 3, 10 / 3, 10]) && near(m.faces[0]!.bbox.min, [200, 0, 10]) && near(m.faces[0]!.normal!, [0, 0, 1]), m.faces[0]);
check("a sphere's centre moves with it", near(m.faces[1]!.axisPoint!, [200, 0, 20]) && m.faces[1]!.kind === "sphere" && m.faces[1]!.radiusMm === 20, m.faces[1]);
check("an edge's points move", near(m.edges[0]!.start, [200, 0, 10]) && near(m.edges[0]!.mid, [205, 0, 10]) && near(m.edges[0]!.dir!, [1, 0, 0]) && near(Array.from(m.lines![0]!.points), [200, 0, 10, 210, 0, 10]), m.edges[0]);
check("the same pose gives the same view, kept", typedView(solid, moved) === m);
check("the solid itself is untouched", positions[0] === 0 && faces[1]!.axisPoint![0] === 0 && solid.bounds.min[0] === 0);
check("volume and indexes carry over", m.volumeMm3 === 1 && m.faces.map((f) => f.index).join() === "0,1" && m.edges[0]!.index === 0);

// Turned 90° about X (y → z, z → −y), then moved.
const turned: Affine = { m: [1, 0, 0, 0, 0, -1, 0, 1, 0], t: [0, 5, 0] };
const t = typedView(solid, turned);
check("a turn turns the flat face's normal: +Z to −Y", near(t.faces[0]!.normal!, [0, -1, 0]) && t.faces[0]!.kind === "plane", t.faces[0]);
check("a turn takes the sphere's centre and pole with it", near(t.faces[1]!.axisPoint!, [0, -15, 0]) && near(t.faces[1]!.axis!, [0, -1, 0]), t.faces[1]);
check("the turned box is the turned mesh's", near(t.bounds.min, [0, -35, 0]) && near(t.bounds.max, [20, -5, 20]), t.bounds);
check("an edge's direction stays along X", near(t.edges[0]!.dir!, [1, 0, 0]) && near(t.edges[0]!.start, [0, -5, 0]), t.edges[0]);
check("a point and a direction alone", near(typedPoint(turned, [0, 0, 20]), [0, -15, 0]) && near(typedDir(turned, [0, 0, 1]), [0, -1, 0]) && near(typedPoint(IDENTITY_POSE, [1, 2, 3]), [1, 2, 3]));

// --- The refusal of a cut that misses: the frame, and the pose, with no "sits at (" to add as an offset.
check("no pose, no sentence", frameWhere(undefined, undefined) === "" && frameWhere(IDENTITY_POSE, "part") === "");
const said = frameWhere(moved, undefined);
check("model space names the reads and the move", said.includes("Numbers are read in model space, where model_describe, faces_find and surface_at answer too") && said.includes("moved by (200, 0, 0)") && !said.includes("sits at ("), said);
const own = frameWhere({ m: turned.m, t: [200, 0, 0] }, "part");
check("the part frame names the move and the turn", own.includes("part's own frame") && own.includes("moved by (200, 0, 0) and turned (90°, 0°, 0°)") && !own.includes("sits at ("), own);
check("a turn alone says only the turn", frameWhere({ m: turned.m, t: [0, 0, 0] }, "model").includes("has the part turned (90°, 0°, 0°) there"), frameWhere({ m: turned.m, t: [0, 0, 0] }, "model"));

if (failed) {
  console.error(`typed-view: ${failed} failed`);
  process.exit(1);
}
console.log("src/modeling/typed-view: ok");
