/**
 * Organic surfaces S6: schema, bake, and .lime round-trip for nurbsSurface.
 * An older tree that has no NURBS surface still loads.
 */
import { readSavedTree } from "../src/model-tree-file.ts";
import { IDENTITY_POSE } from "../src/model-space.ts";
import { bakeOp } from "../src/modeling/bake.ts";
import { bicubicGrid } from "../src/modeling/nurbs-eval.ts";
import { GLOBAL_WORKPLANE } from "../src/workplane.ts";
import { validateTool } from "./schema.ts";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(name);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name}${detail ? ` ${detail}` : ""}`);
}

const poles = bicubicGrid(4, 4);
const op = { kind: "nurbsSurface", poles, degreeU: 3, degreeV: 3, weights: poles.map((row, iu) => row.map((_, iv) => (iu === 1 && iv === 1 ? 2 : 1))) };
const err = validateTool("model_apply", { op });
check("schema validates nurbsSurface", err === null, String(err));
const refused = validateTool("model_apply", { op: { kind: "nurbsSurface", poles, degreeU: 3, weights: poles.map((row) => row.map(() => 0)) } });
check("schema refuses a weight of 0", refused !== null, String(refused));

const baked = bakeOp(op, { pose: IDENTITY_POSE, solid: null, plane: GLOBAL_WORKPLANE, expand: () => ({ faces: [], faceBy: () => ({ reason: "none" }) }) as never, nodeOf: () => null, hasNode: () => false });
check("bake keeps the weighted grid", !("reason" in baked) && baked.op.kind === "nurbsSurface" && baked.op.weights?.[1]?.[1] === 2, JSON.stringify(baked));
const bad = bakeOp(
  { kind: "nurbsSurface", poles: bicubicGrid(3, 4), degreeU: 3, degreeV: 3 },
  { pose: IDENTITY_POSE, solid: null, plane: GLOBAL_WORKPLANE, expand: () => ({ faces: [], faceBy: () => ({ reason: "none" }) }) as never, nodeOf: () => null, hasNode: () => false },
);
check("bake refuses too few poles", "reason" in bad && bad.reason === "This surface needs at least 4 poles in U for degree 3.", JSON.stringify(bad));

const older = readSavedTree({
  rootFeature: { kind: "extrude", op: "fuse", origin: [0, 0, 0], profile: [[0, 0], [10, 0], [10, 10]], depth: 4 },
  nodes: [{ id: 0, parent: null, op: null, fingerprint: { volumeMm3: 200, faces: 5, edges: 9 } }],
  current: 0,
  committed: 0,
  nextId: 1,
});
check("an older file with no NURBS surface still loads", older !== null && older.nodes.length === 1, JSON.stringify(older));

const saved = readSavedTree({
  rootFeature: op,
  nodes: [{ id: 0, parent: null, op: null, fingerprint: { volumeMm3: 0, faces: 1, edges: 4 } }],
  current: 0,
  committed: 0,
  nextId: 1,
});
check(
  "saved-tree codec round-trips nurbsSurface",
  saved !== null && saved.rootFeature?.kind === "nurbsSurface" && saved.rootFeature.weights?.[1]?.[1] === 2,
  JSON.stringify(saved),
);

if (failed) {
  console.error(`nurbs-surface: ${failed} failed`);
  process.exit(1);
}
console.log("nurbs-surface: ok");
