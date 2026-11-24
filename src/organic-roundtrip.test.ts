/**
 * Organic fix round S7: the op the kernel echoes in an apply reply (it serializes Curve3D as the app writes it,
 * `through` and `closed` included) round-trips through what the app does with it: keepSketch (as apply.ts stores it),
 * the request copy, the pose conversion both ways, and the project file. A sweep with a spline spine, and a closed
 * NURBS curve.
 */
import { keepSketch, withoutSketch } from "./model-request.ts";
import { fromSolidOp, toSolidOp } from "./model-space.ts";
import { eulerOrient } from "./mesh-place.ts";
import { readSavedTree, savedTree } from "./model-tree-file.ts";
import { newTree, withChild, type ModelOp } from "./model-tree.ts";
import { readLoftBoundaryField as readLoftBoundary } from "./modeling/bake.ts";
import { addNurbs, emptySketch, readSketch, sketchJson as sketchJsonOf } from "./sketch/model.ts";
import { curveOf } from "./sketch/geom.ts";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(name);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name}${detail ? ` ${detail}` : ""}`);
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const near = (a: unknown, b: unknown) => JSON.stringify(a, (_k, v) => (typeof v === "number" ? Math.round(v * 1e6) / 1e6 : v)) === JSON.stringify(b, (_k, v) => (typeof v === "number" ? Math.round(v * 1e6) / 1e6 : v));

const sweep: ModelOp = {
  kind: "sweep",
  op: "fuse",
  sections: [{ origin: [0, 0, 0], turn: [0, 0, 0], radius: 2 }],
  spine: { kind: "spline", through: [[0, 0, 0], [5, 2, 10], [0, 8, 20]] },
} as ModelOp;
const closedNurbs: ModelOp = {
  kind: "splitFace",
  faces: [0],
  curve: { kind: "nurbs", poles: [[0, 0, 5], [10, 0, 5], [10, 10, 5], [0, 10, 5]], degree: 3, closed: true },
} as ModelOp;
const pose = { m: eulerOrient(10, 20, 30), t: [5, -3, 7] as [number, number, number] };

for (const [name, op] of [["a sweep with a spline spine", sweep], ["a closed NURBS curve", closedNurbs]] as const) {
  // What the kernel echoes: the op as sent, through JSON.
  const echo = JSON.parse(JSON.stringify(withoutSketch(op))) as ModelOp;
  const stored = keepSketch(echo, op);
  check(`${name}: the echo, as apply stores it, is the op sent`, same(stored, op), JSON.stringify(stored));
  check(`${name}: the solid frame and back is the op`, near(fromSolidOp(toSolidOp(stored, pose), pose), op));
  const tree = withChild(newTree("a#1", { kind: "primitive", solid: { primitive: "box", origin: [0, 0, 0], size: [20, 20, 20] } } as never, "Box", null), 0, { id: 1, op: stored, label: "step", fingerprint: null });
  const read = readSavedTree({ ...JSON.parse(JSON.stringify(savedTree({ ...tree, committed: 1 }, 1, () => undefined))), rootPrimitive: { primitive: "box", origin: [0, 0, 0], size: [20, 20, 20] } }) as { nodes?: { op?: unknown }[] } | null;
  check(`${name}: the project file keeps it as sent`, same(read?.nodes?.find((node) => node.op)?.op, op), JSON.stringify(read?.nodes));
}

// The kernel refuses a loft "curvature" end condition: the app no longer produces one (old files still read).
check("a typed loft curvature condition is refused with the kernel's terms", "reason" in readLoftBoundary({ kind: "curvature" }));
check("normal and tangent conditions are still taken", !("reason" in readLoftBoundary({ kind: "normal" })) && !("reason" in readLoftBoundary({ kind: "tangent", dir: [0, 0, 1] })));
{
  // An old file's loft with a curvature end is read as it was saved, not dropped: the step goes to the kernel, which
  // refuses it ("A loft cannot match curvature at an end: ..."), and History shows that sentence on the step.
  const ring = (z: number) => ({ origin: [0, 0, z], turn: [0, 0, 0], radius: 5 });
  const oldLoft = { kind: "loft", op: "fuse", sections: [ring(0), ring(10)], endCondition: { kind: "curvature", dir: [0, 0, 1] } };
  const tree = withChild(newTree("a#1", { kind: "primitive", solid: { primitive: "box", origin: [0, 0, 0], size: [20, 20, 20] } } as never, "Box", null), 0, { id: 1, op: oldLoft as unknown as ModelOp, label: "Loft", fingerprint: null });
  const read = readSavedTree({ ...JSON.parse(JSON.stringify(savedTree({ ...tree, committed: 1 }, 1, () => undefined))), rootPrimitive: { primitive: "box", origin: [0, 0, 0], size: [20, 20, 20] } }) as { nodes?: { op?: { endCondition?: unknown } }[] } | null;
  const kept = read?.nodes?.find((node) => node.op)?.op?.endCondition;
  check("an old file's loft curvature end is kept as saved, for the kernel to refuse", same(kept, { kind: "curvature", dir: [0, 0, 1] }), JSON.stringify(read?.nodes));
}

// The kernel refuses a NURBS degree above poles - 1 and knots without mults: the sketch never makes either.
{
  const high = addNurbs(emptySketch(), [[0, 0], [10, 10], [20, 0]], { degree: 5 }).sketch;
  const e = high.entities[0] as { degree?: number };
  check("addNurbs fits a degree to its poles (3 poles: at most 2)", e.degree === 2, JSON.stringify(e));
  const knotsOnly = addNurbs(emptySketch(), [[0, 0], [5, 8], [10, 8], [15, 0], [20, 4]], { knots: [0, 0.5, 1] }).sketch;
  const k = knotsOnly.entities[0] as { knots?: number[]; mults?: number[] };
  check("addNurbs writes the multiplicities its knots imply", same(k.mults, [4, 1, 4]), JSON.stringify(k));
  // An old entity with knots and no mults still reads, and what is sent carries the mults the preview used.
  const old = { ...knotsOnly, entities: [{ ...knotsOnly.entities[0]!, mults: undefined }] } as typeof knotsOnly;
  const c = curveOf(old, old.entities[0]!);
  check("an old entity's knots go out with their implied mults", c?.kind === "spline" && same(c.nurbs?.mults, [4, 1, 4]), JSON.stringify(c && c.kind === "spline" ? c.nurbs : null));
  // The preview (src/modeling/nurbs-eval.ts) still lowers a degree the poles cannot carry, but the app never sends a
  // lowered one: a new curve's degree fits its poles (above), and an old file's is kept as saved and sent as it is, so
  // the kernel refuses it with its own sentence rather than build another curve than the file holds.
  const saved = sketchJsonOf(addNurbs(emptySketch(), [[0, 0], [10, 10], [20, 0]]).sketch);
  (saved.entities[0] as { degree?: number }).degree = 5;
  const reread = readSketch(JSON.parse(JSON.stringify(saved)));
  const sent = reread ? curveOf(reread, reread.entities[0]!) : null;
  check("an old file's degree above its poles is read and sent as saved, for the kernel to refuse", sent?.kind === "spline" && sent.nurbs?.degree === 5, JSON.stringify(sent && sent.kind === "spline" ? sent.nurbs : null));
}

if (failed) {
  console.error(`${failed} checks failed`);
  process.exit(1);
}
console.log("organic round trip: ok");
