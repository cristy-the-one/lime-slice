/**
 * Face extrude and face move, on the client: the ops as sent, their history labels, a `.lime` round trip,
 * a stored face matching a fresh index, and the sentence when there is no edit panel yet.
 */
import { editRefusal } from "./model-edit.ts";
import { isProbed, probeNote } from "./model-feasibility.ts";
import { faceExtrudeOp, faceLoopsRequest, moveFacesOp, shellOp } from "./model-request.ts";
import { toSolidOp, type Affine } from "./model-space.ts";
import { loadedTree, readSavedTree, savedTree } from "./model-tree-file.ts";
import { childWithOp, newTree, opLabel, withChild, type FaceRef, type ModelOp, type Vec3 } from "./model-tree.ts";
import { eulerOrient } from "./mesh-place.ts";

let failed = 0;
function eq(name: string, got: unknown, want: unknown) {
  const left = JSON.stringify(got);
  const right = JSON.stringify(want);
  if (left === right) return;
  failed += 1;
  console.error(`FAIL ${name}\n  got  ${left}\n  want ${right}`);
}

const face: FaceRef = { index: 5, mid: [10, 10, 10], areaMm2: 400 };
const pull = moveFacesOp([{ face: 5, distance: 5 }]);
const push = moveFacesOp([{ face: 3, distance: -3 }]);
const two = moveFacesOp([{ face: 1, distance: 1.5 }, { face: 2, distance: 1.5 }]);
const mixed = moveFacesOp([{ face: 1, distance: 2 }, { face: 4, distance: -1 }]);
const prism = faceExtrudeOp(2, 8);
const drafted = faceExtrudeOp(face, 5, { draftDeg: 4, upTo: 1 });

eq("a pull sends the face and the distance", pull, { kind: "moveFaces", faces: [{ face: 5, distance: 5 }] });
eq("a face extrude sends no draft or stop it was not given", prism, { kind: "faceExtrude", face: 2, distance: 8 });
eq("a draft and a stop face are sent when set", drafted, { kind: "faceExtrude", face, distance: 5, draftDeg: 4, upTo: 1 });
eq("a draft of 0 is not sent", "draftDeg" in faceExtrudeOp(2, 5, { draftDeg: 0 }), false);
eq("face loops names the face", faceLoopsRequest("k", 0, 5), { call: "faceLoops", key: "k", node: 0, face: 5 });

eq("labels", [opLabel(pull), opLabel(push), opLabel(two), opLabel(mixed), opLabel(prism), opLabel(faceExtrudeOp(1, -3)), opLabel(drafted)], [
  "Pull face 5 mm",
  "Push face 3 mm",
  "Move 2 faces 1.5 mm",
  "Move 2 faces",
  "Pull face 8 mm",
  "Push face 3 mm",
  "Pull face 5 mm, draft 4°, up to a face",
]);

const fp = (volumeMm3: number) => ({ volumeMm3, faces: 6, edges: 12 });
const root = { kind: "primitive" as const, solid: { primitive: "box" as const, origin: [0, 0, 0] as Vec3, size: [20, 20, 10] as Vec3, radius: 0, height: 0, turn: [0, 0, 0] as Vec3 } };
const stored: ModelOp[] = [
  { kind: "moveFaces", faces: [{ face, distance: 5 }] },
  { kind: "faceExtrude", face, distance: 8 },
  shellOp(1, [4]),
];
let tree = newTree("k", root, "Box", fp(4000));
stored.forEach((op, i) => (tree = withChild(tree, i, { id: i + 1, op, label: opLabel(op), fingerprint: fp(1000 + i) })));
const json = JSON.parse(JSON.stringify({ ...savedTree(tree, 3, () => undefined), rootPrimitive: root.solid }));
const read = readSavedTree(json);
eq("a saved tree reads the face ops and an older shell", read?.nodes.map((node) => node.op), [null, ...stored]);
const loaded = read && loadedTree(read, "k2", root, "Box", null, () => undefined);
eq("and opens with each step labelled", loaded && [1, 2, 3].map((id) => loaded.nodes.get(id)?.label), stored.map(opLabel));

const shellOnly = JSON.parse(JSON.stringify({
  ...savedTree(withChild(newTree("s", root, "Box", fp(1)), 0, { id: 1, op: shellOp(2), label: "Shell 2, closed", fingerprint: fp(1) }), 1, () => undefined),
  rootPrimitive: root.solid,
}));
eq("an older shell file still opens", readSavedTree(shellOnly)?.nodes.map((node) => node.op), [null, shellOp(2)]);

eq("a fresh index finds the stored face", childWithOp(tree, 0, moveFacesOp([{ face: 5, distance: 5 }])), 1);
eq("a different distance does not", childWithOp(tree, 0, moveFacesOp([{ face: 5, distance: 4 }])), null);
eq("a fresh extrude index finds the stored face", childWithOp(tree, 1, faceExtrudeOp(5, 8)), 2);

const pose: Affine = { m: eulerOrient(0, 0, 90), t: [10, 0, 0] };
eq("a face move has no point to take through the pose", toSolidOp(pull, pose), pull);
eq("a face extrude keeps its index", toSolidOp(prism, pose), prism);

eq("the new tools are checked by the kernel", ["faceExtrude", "moveFaces"].map(isProbed), [true, true]);
eq(
  "a refusal reads as it came",
  probeNote("moveFaces", { phase: "done", ok: false, error: "This face cannot move with its neighbours here. Push or pull adds material instead: hold Alt." })?.text,
  "This face cannot move with its neighbours here. Push or pull adds material instead: hold Alt.",
);
for (const id of [1, 2]) eq(`step ${id} has no edit panel`, loaded && editRefusal(loaded, id), "This step has no edit panel yet. Delete it and apply it again with new numbers.");

if (failed) {
  console.error(`model-face: ${failed} failed`);
  throw new Error(`model-face: ${failed} failed`);
}
console.log("model-face: face extrude and move faces ok");
