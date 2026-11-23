/**
 * S6: a NURBS op's knot insertion and degree elevation are applied when the op is baked (the stored op is the grid the
 * kernel builds), and a saved file keeps every field the schema takes.
 */
import { readSavedTree } from "../model-tree-file.ts";
import { IDENTITY_POSE } from "../model-space.ts";
import { GLOBAL_WORKPLANE } from "../workplane.ts";
import { bakeOp } from "./bake.ts";
import { applyRefinements, bicubicGrid, evalNurbsSurface3D, type NurbsSurface3D } from "./nurbs-eval.ts";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) return;
  failed += 1;
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}

const ctx = { pose: IDENTITY_POSE, solid: null, plane: GLOBAL_WORKPLANE, expand: () => ({ faces: [], faceBy: () => ({ reason: "none" }) }) as never, nodeOf: () => null, hasNode: () => false };
const poles = bicubicGrid().map((row, iu) => row.map((p, iv) => [p[0], p[1], 3 * Math.sin(iu * 0.7) * Math.cos(iv * 0.5)] as [number, number, number]));
const plain: NurbsSurface3D = { poles, degreeU: 3, degreeV: 3 };

const baked = bakeOp({ kind: "nurbsSurface", poles, degreeU: 3, degreeV: 3, insertU: [[0.43, 1]], insertV: [[0.5, 2]], elevateU: 4 }, ctx);
if ("reason" in baked) check("bake applies insert and elevate", false, baked.reason);
else {
  const op = baked.op as NurbsSurface3D & { insertU?: unknown; elevateU?: unknown };
  // U: 8 poles + 1 inserted = 9, 6 spans -> elevated to degree 4: 9 + 6 = 15. V: 8 + 2 = 10.
  check("the baked grid is the grid the kernel builds (15 × 10, degree 4 × 3)", op.poles.length === 15 && op.poles[0]!.length === 10 && op.degreeU === 4 && op.degreeV === 3, `${op.poles.length}x${op.poles[0]!.length} ${op.degreeU}/${op.degreeV}`);
  check("nothing the call asked for is left to the kernel", op.insertU === undefined && op.elevateU === undefined);
  let worst = 0;
  for (let i = 0; i < 20; i += 1) {
    for (let j = 0; j < 20; j += 1) {
      const a = evalNurbsSurface3D(plain, (i + 0.3) / 20, (j + 0.6) / 20).point;
      const b = evalNurbsSurface3D(op, (i + 0.3) / 20, (j + 0.6) / 20).point;
      worst = Math.max(worst, Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]));
    }
  }
  check("the baked grid is the same surface (< 1e-10 mm at 400 samples)", worst < 1e-10, `${worst}`);
  const again = applyRefinements(plain, { insertU: [[0.43, 1]], insertV: [[0.5, 2]], elevateU: 4 });
  check("bake and the sculpt tool's maths agree", typeof again !== "string" && JSON.stringify(again.poles) === JSON.stringify(op.poles));
}

const ring = { kind: "nurbsSurface", poles: bicubicGrid(6, 4), degreeU: 3, degreeV: 3, periodicU: true, elevateU: 4 };
const closed = bakeOp(ring, ctx);
check("a closed surface with elevate is refused in one sentence", "reason" in closed && closed.reason === "Knot insertion and degree elevation are for a clamped NURBS surface, not a closed one.", JSON.stringify(closed));
check("elevate past the cap is refused", "reason" in bakeOp({ kind: "nurbsSurface", poles, elevateV: 9 }, ctx));
check("an insert that is not [parameter, times] is refused", "reason" in bakeOp({ kind: "nurbsSurface", poles, insertU: [[0.5]] }, ctx));
check("a grid that would pass 64 poles is refused", "reason" in bakeOp({ kind: "nurbsSurface", poles: bicubicGrid(64, 4), insertU: [[0.5, 1]] }, ctx));

// A file keeps every field: an older or hand-written op with insert and elevate reads back with them.
const tree = readSavedTree({
  rootFeature: { kind: "nurbsSurface", poles, degreeU: 3, degreeV: 3, insertU: [[0.43, 1]], insertV: [[0.5, 2]], elevateU: 4, elevateV: 5 },
  nodes: [{ id: 0, parent: null, op: null, fingerprint: null }],
  current: 0,
  committed: 0,
  nextId: 1,
});
const root = tree?.rootFeature as { insertU?: number[][]; insertV?: number[][]; elevateU?: number; elevateV?: number } | undefined;
check("a saved NURBS root keeps insert and elevate", JSON.stringify([root?.insertU, root?.insertV, root?.elevateU, root?.elevateV]) === JSON.stringify([[[0.43, 1]], [[0.5, 2]], 4, 5]), JSON.stringify(root));
check("a damaged insert pair makes the op unreadable", readSavedTree({ rootFeature: { kind: "nurbsSurface", poles, insertU: [[0.5, 0]] }, nodes: [{ id: 0, parent: null, op: null, fingerprint: null }], current: 0, committed: 0, nextId: 1 }) === null);
if (!("reason" in baked)) {
  const stored = readSavedTree({ rootFeature: baked.op, nodes: [{ id: 0, parent: null, op: null, fingerprint: null }], current: 0, committed: 0, nextId: 1 });
  check("the baked grid round-trips through a file", JSON.stringify(stored?.rootFeature) === JSON.stringify(baked.op));
}

// A 64 × 64 grid (the cap) reads back from a file; a curve's 50-point cap does not apply to it.
const big = readSavedTree({ rootFeature: { kind: "nurbsSurface", poles: bicubicGrid(64, 64) }, nodes: [{ id: 0, parent: null, op: null, fingerprint: null }], current: 0, committed: 0, nextId: 1 });
check("a 64 × 64 NURBS grid reads back from a file", (big?.rootFeature as { poles?: unknown[] } | undefined)?.poles?.length === 64);
check("a 65-row grid does not", readSavedTree({ rootFeature: { kind: "nurbsSurface", poles: bicubicGrid(65, 4) }, nodes: [{ id: 0, parent: null, op: null, fingerprint: null }], current: 0, committed: 0, nextId: 1 }) === null);

if (failed) throw new Error(`${failed} nurbs bake checks failed`);
console.log("nurbs-bake: ok");
