/**
 * Extrude, revolve, shell, and a blend that takes an earlier step's edges, on the client: the ops as sent, their history
 * labels, a `.lime` round trip, an edit's renumbered steps, the solid frame they are stored in, and the probe's measures.
 */
import { eulerOrient } from "./mesh-place.ts";
import { editRefusal, stepIds } from "./model-edit.ts";
import { isProbed, probeFromBody, probeNote } from "./model-feasibility.ts";
import { extrudeOp, probeRequest, revolveOp, shellOp, stepEdges } from "./model-request.ts";
import { applyPose, toSolidOp, type Affine } from "./model-space.ts";
import { loadedTree, readSavedTree, savedTree } from "./model-tree-file.ts";
import { childWithOp, newTree, opLabel, renumberedSteps, withChild, type ModelOp, type Vec2, type Vec3 } from "./model-tree.ts";

let failed = 0;
function eq(name: string, got: unknown, want: unknown) {
  const left = JSON.stringify(got);
  const right = JSON.stringify(want);
  if (left === right) return;
  failed += 1;
  console.error(`FAIL ${name}\n  got  ${left}\n  want ${right}`);
}
function near(name: string, got: readonly number[], want: readonly number[]) {
  if (got.length === want.length && got.every((value, i) => Math.abs(value - want[i]!) < 1e-9)) return;
  failed += 1;
  console.error(`FAIL ${name}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`);
}

// The ops as the engine reads and stores them: optional fields only when on or given.
const gable: Vec2[] = [[-5, 50], [105, 50], [50, 80]];
const front = { origin: [0, 30, 0] as Vec3, turn: [90, 0, 0] as Vec3 };
const roof = extrudeOp("fuse", front, gable, 70, true);
eq("an extrude carries its plane, profile, and depth", roof, { kind: "extrude", op: "fuse", origin: [0, 30, 0], turn: [90, 0, 0], profile: gable, depth: 70, symmetric: true });
eq("symmetric is sent only when on", "symmetric" in extrudeOp("cut", front, gable, -10), false);
const boss = revolveOp("fuse", front, [[0, 0], [5, 0], [5, 8], [0, 8]]);
eq("a revolve sends no axis or angle it was not given", Object.keys(boss), ["kind", "op", "origin", "turn", "profile"]);
eq("and each one it was", revolveOp("cut", front, gable, { origin: [0, 1], dir: [1, 0], angleDeg: 90 }), { kind: "revolve", op: "cut", origin: [0, 30, 0], turn: [90, 0, 0], profile: gable, axisOrigin: [0, 1], axisDir: [1, 0], angleDeg: 90 });
eq("a shell with no face open sends none", shellOp(2), { kind: "shell", thickness: 2 });
eq("a step pick sends its filter only when it narrows", [stepEdges(3), stepEdges(3, "all"), stepEdges(3, "convex")], [{ fromNode: 3 }, { fromNode: 3 }, { fromNode: 3, filter: "convex" }]);
eq("a probe sends the op as built", probeRequest("k", 1, shellOp(1.5, [4])), { call: "probe", key: "k", node: 1, op: { kind: "shell", thickness: 1.5, openFaces: [4] } });

// History labels.
eq("labels", [
  opLabel(roof),
  opLabel(extrudeOp("cut", front, [[0, 0], [1, 0], [1, 1], [0, 1]], -10)),
  opLabel(boss),
  opLabel(revolveOp("common", front, gable, { angleDeg: 90 })),
  opLabel(shellOp(2)),
  opLabel(shellOp(1.5, [4])),
  opLabel(shellOp(1, [4, 5])),
  opLabel({ kind: "fillet", edges: [stepEdges(2, "convex")], size: 1 }),
  opLabel({ kind: "chamfer", edges: [3, stepEdges(2)], size: 0.5 }),
], [
  "Extrude 3-point profile 70 both ways",
  "Cut extrude 4-point profile 10",
  "Revolve 4-point profile 360°",
  "Intersect revolve 3-point profile 90°",
  "Shell 2, closed",
  "Shell 1.5, 1 face open",
  "Shell 1, 2 faces open",
  "Fillet convex edges of node 2 r 1",
  "Chamfer 1 edge + edges of node 2 0.5",
]);

// A `.lime` round trip: the ops come back as stored, each with its label.
const fp = (volumeMm3: number) => ({ volumeMm3, faces: 6, edges: 12 });
const root = { kind: "primitive" as const, solid: { primitive: "box" as const, origin: [0, 0, 0] as Vec3, size: [100, 60, 50] as Vec3, radius: 0, height: 0, turn: [0, 0, 0] as Vec3 } };
const stored: ModelOp[] = [
  roof,
  { kind: "revolve", op: "cut", origin: [20, 20, 10], turn: [90, 0, 0], profile: [[5, 0], [7, 0], [7, -2], [5, -2]], axisDir: [0, 1] },
  { kind: "shell", thickness: 1, openFaces: [{ index: 5, mid: [50, 30, 80], areaMm2: 400 }] },
  { kind: "fillet", edges: [{ fromNode: 1, filter: "concave" }, { index: 2, mid: [0, 0, 5], lengthMm: 10 }], size: 1 },
];
let tree = newTree("k", root, "Box", fp(300_000));
stored.forEach((op, i) => (tree = withChild(tree, i, { id: i + 1, op, label: opLabel(op), fingerprint: fp(1000 + i) })));
const json = JSON.parse(JSON.stringify({ ...savedTree(tree, 4, () => undefined), rootPrimitive: root.solid }));
const read = readSavedTree(json);
eq("a saved tree with the new ops reads", read?.nodes.map((node) => node.op), [null, ...stored]);
const loaded = read && loadedTree(read, "k2", root, "Box", null, () => undefined);
eq("and opens with each step labelled", loaded && [1, 2, 3, 4].map((id) => loaded.nodes.get(id)?.label), stored.map(opLabel));
const damaged = (patch: (op: Record<string, unknown>) => void, at = 1) => {
  const copy = JSON.parse(JSON.stringify(json));
  patch(copy.nodes[at].op);
  return readSavedTree(copy);
};
eq("a damaged op is a damaged tree", [
  damaged((op) => (op.profile = [[0, 0], [1, 0]])),
  damaged((op) => (op.profile = [[0, 0], [1, 0], [1]])),
  damaged((op) => (op.depth = "deep")),
  damaged((op) => (op.symmetric = 1)),
  damaged((op) => (op.op = "glue")),
  damaged((op) => (op.axisDir = [0, 1, 0]), 2),
  damaged((op) => (op.openFaces = [{ index: 5 }]), 3),
  damaged((op) => ((op.edges as unknown[])[0] = { fromNode: 1, filter: "round" }), 4),
], [null, null, null, null, null, null, null, null]);

// A shell stored with references is the same op as a fresh pick of the same face, as a blend's edges are.
const shellTree = withChild(newTree("s", root, "Box", fp(1)), 0, { id: 1, op: stored[2]!, label: "", fingerprint: fp(1) });
eq("a fresh pick finds the shell already built", childWithOp(shellTree, 0, shellOp(1, [5])), 1);
eq("but not another face", childWithOp(shellTree, 0, shellOp(1, [4])), null);

// An edit replays steps under new ids, and a blend's step pick follows its step.
const blend: ModelOp = { kind: "fillet", edges: [stepEdges(3, "convex"), 7], size: 1 };
const ids = stepIds([3, 4], [9, 10]);
eq("an edit renames each replayed step", [...ids], [[3, 9], [4, 10]]);
eq("a blend takes edges from its step's new id", renumberedSteps(blend, ids), { kind: "fillet", edges: [{ fromNode: 9, filter: "convex" }, 7], size: 1 });
eq("a blend of a step not replayed is the same op", renumberedSteps(blend, stepIds([5], [11])) === blend, true);

// An extrude or a revolve reopens its sketch. A shell does too, and so does a blend of a step's edges.
eq("an extrude step reopens its sketch", editRefusal(tree, 1), null);
eq("a revolve step reopens its sketch", editRefusal(tree, 2), null);
eq("a shell step can be edited", editRefusal(tree, 3), null);
eq("a blend of a step's edges can be edited", editRefusal(tree, 4), null);

// Typed in model space, stored in the solid's own frame: the profile lands in the same place either way.
const pose: Affine = { m: eulerOrient(0, 0, 90), t: [10, 5, 0] };
const solid = toSolidOp(roof, pose) as typeof roof;
const at = (plane: { origin: Vec3; turn: Vec3 }, [u, v]: Vec2) => {
  const m = eulerOrient(plane.turn[0], plane.turn[1], plane.turn[2]);
  return [plane.origin[0] + m[0] * u + m[1] * v, plane.origin[1] + m[3] * u + m[4] * v, plane.origin[2] + m[6] * u + m[7] * v];
};
for (const point of gable) near(`profile point ${point} keeps its place`, applyPose(pose, at(solid, point)), at(roof, point));
eq("a pose that only moves keeps the turn", (toSolidOp(roof, { m: eulerOrient(0, 0, 0), t: [1, 2, 3] }) as typeof roof).turn, [90, 0, 0]);
eq("a shell has no frame to move", toSolidOp(shellOp(1, [2]), pose), shellOp(1, [2]));

// The probe's measures, and its notes.
eq("a probe that builds reads its measures", probeFromBody({ ok: true, volumeMm3: 1408, solids: 1, shells: 2, before: { volumeMm3: 4000, solids: 1, shells: 1 } }), {
  phase: "done",
  ok: true,
  measure: { volumeMm3: 1408, solids: 1, shells: 2, before: { volumeMm3: 4000, solids: 1, shells: 1 } },
});
eq("an older engine's bare ok still reads", probeFromBody({ ok: true }), { phase: "done", ok: true });

// A group is one history row: its label, its steps, and the composite it was typed as.
const pocket: ModelOp = {
  kind: "group",
  label: "Pocket 10 × 10, 2 bars",
  source: { kind: "pocket", width: 10 },
  steps: [roof, { kind: "hole", origin: [5, 5, 10], axis: [0, 0, -1], radius: 1, depth: 4 }],
};
eq("a group row is its label", opLabel(pocket), "Pocket 10 × 10, 2 bars");
let grouped = withChild(newTree("g", root, "Box", fp(1)), 0, { id: 1, op: pocket, label: opLabel(pocket), fingerprint: fp(2) });
const groupFile = JSON.parse(JSON.stringify({ ...savedTree(grouped, 1, () => undefined), rootPrimitive: root.solid }));
eq("a group round-trips through .lime with its source and steps", readSavedTree(groupFile)?.nodes[1]?.op, pocket);
const opened = readSavedTree(groupFile);
const openedTree = opened && loadedTree(opened, "g2", root, "Box", null, () => undefined);
eq("and opens as one row named by that label", openedTree?.nodes.get(1)?.label, "Pocket 10 × 10, 2 bars");
const withoutSource = JSON.parse(JSON.stringify(groupFile));
delete withoutSource.nodes[1].op.source;
eq("a group saved without source still opens", readSavedTree(withoutSource)?.nodes[1]?.op, { kind: "group", label: pocket.label, steps: pocket.steps });
eq("the same steps are the group already built, whatever its source or label", childWithOp(grouped, 0, { ...pocket, label: "other", source: { kind: "pocket", width: 99 } }), 1);
const blendGroup: ModelOp = { kind: "group", label: "Edges", steps: [blend] };
eq("a group renumbers a blend inside it", renumberedSteps(blendGroup, ids), { kind: "group", label: "Edges", steps: [renumberedSteps(blend, ids)] });
eq("a pocket group reopens its feature panel", editRefusal(grouped, 1), null);
const plainGroup = withChild(newTree("plain", root, "Box", fp(1)), 0, { id: 1, op: blendGroup, label: blendGroup.label, fingerprint: fp(2) });
eq("a group without a feature source has no edit panel yet", editRefusal(plainGroup, 1), "This step has no edit panel yet. Delete it and apply it again with new numbers.");
const turned: Affine = { m: eulerOrient(0, 0, 90), t: [10, 5, 0] };
const solidGroup = toSolidOp(pocket, turned);
eq("a turned pose moves each step of a group and keeps the composite", solidGroup, { ...pocket, steps: pocket.steps.map((step) => toSolidOp(step, turned)) });
const identity: Affine = { m: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] };
eq("identity sends the group exactly as typed", toSolidOp(pocket, identity) === pocket, true);
eq("a group with a step that will not read is a damaged tree", readSavedTree(JSON.parse(JSON.stringify({ ...groupFile, nodes: groupFile.nodes.map((node: { op: { steps?: unknown[] } }, i: number) => i === 1 ? { ...node, op: { ...node.op, steps: [] } } : node) }))), null);
eq("the new tools are checked by the kernel", ["extrude", "revolve", "shell"].map(isProbed), [true, true, true]);
eq("a refusal reads as it came", probeNote("shell", { phase: "done", ok: false, error: "This wall is too thick for the part's smallest feature." })?.text, "This wall is too thick for the part's smallest feature.");

// K3. A second depth, a draft, and a face to stop at. Each is absent unless it was set.
const square: Vec2[] = [[0, 0], [10, 0], [10, 10], [0, 10]];
const bed = { origin: [0, 0, 10] as Vec3, turn: [0, 0, 0] as Vec3 };
const tapered = extrudeOp("fuse", bed, square, 10, false, {}, { depth2: 4, draftDeg: 5 });
eq("a second depth and a draft are sent when set", tapered, { kind: "extrude", op: "fuse", origin: [0, 0, 10], turn: [0, 0, 0], profile: square, depth: 10, depth2: 4, draftDeg: 5 });
eq("a zero draft is left off", "draftDeg" in extrudeOp("fuse", bed, square, 10, false, {}, { draftDeg: 0 }), false);
eq("a plain extrude still sends none of them", Object.keys(extrudeOp("fuse", bed, square, 10)), ["kind", "op", "origin", "turn", "profile", "depth"]);
const stopped = extrudeOp("cut", bed, square, 0, false, {}, { upTo: 3 });
eq("labels name the second side, the draft, and the face", [opLabel(tapered), opLabel(stopped)], ["Extrude 4-point profile 10 and 4, draft 5°", "Cut extrude 4-point profile up to a face"]);
const storedStop: ModelOp = { ...stopped, upTo: { index: 3, mid: [5, 5, 20], areaMm2: 100 } };
const stopTree = withChild(newTree("e", root, "Box", fp(1)), 0, { id: 1, op: storedStop, label: opLabel(storedStop), fingerprint: fp(1) });
eq("a fresh face index finds the extrude that stops there", childWithOp(stopTree, 0, stopped), 1);
eq("and another face does not", childWithOp(stopTree, 0, extrudeOp("cut", bed, square, 0, false, {}, { upTo: 4 })), null);
const extentJson = JSON.parse(JSON.stringify({ ...savedTree(stopTree, 1, () => undefined), rootPrimitive: root.solid }));
eq("an extrude up to a face round-trips", readSavedTree(extentJson)?.nodes[1]?.op, storedStop);
eq("a damaged second depth, draft, or face is a damaged tree", [
  damaged((op) => (op.depth2 = "far"), 1),
  damaged((op) => (op.draftDeg = "steep"), 1),
  damaged((op) => (op.upTo = { index: -1 }), 1),
].map((tree) => tree?.nodes[1]?.op ?? null), [null, null, null]);

if (failed) {
  console.error(`model-sketch: ${failed} failed`);
  throw new Error(`model-sketch: ${failed} failed`);
}
console.log("model-sketch: extrude, revolve, shell, and step edges ok");
