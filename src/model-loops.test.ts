/**
 * K1 loops on the client: the op as sent (no empty profile), a `.lime` round trip, an old profile file unchanged,
 * a damaged segment dropping the tree, the history label, and the schema.
 */
import { extrudeOp, loftOp, revolveOp } from "./model-request.ts";
import { readSavedTree, savedTree } from "./model-tree-file.ts";
import { newTree, opLabel, withChild, type ModelOp, type ProfileLoop, type Vec2, type Vec3 } from "./model-tree.ts";
import { validateTool } from "../mcp/schema.ts";

let failed = 0;
function eq(name: string, got: unknown, want: unknown) {
  const left = JSON.stringify(got);
  const right = JSON.stringify(want);
  if (left === right) return;
  failed += 1;
  console.error(`FAIL ${name}\n  got  ${left}\n  want ${right}`);
}

const plane = { origin: [20, 20, 10] as Vec3, turn: [0, 0, 0] as Vec3 };
const washer: ProfileLoop[] = [
  {
    start: [10, 0],
    segments: [
      { kind: "arc", through: [0, 10], to: [-10, 0] },
      { kind: "arc", through: [0, -10], to: [10, 0] },
    ],
  },
  {
    start: [4, 0],
    segments: [
      { kind: "arc", through: [0, 4], to: [-4, 0] },
      { kind: "arc", through: [0, -4], to: [4, 0] },
    ],
  },
];

const made = extrudeOp("fuse", plane, [], 5, false, {}, washer);
eq("a loops extrude omits the profile", made, {
  kind: "extrude",
  op: "fuse",
  origin: [20, 20, 10],
  turn: [0, 0, 0],
  loops: washer,
  depth: 5,
});
eq("a loops revolve omits the profile", revolveOp("cut", plane, [], { angleDeg: 180 }, {}, washer).profile, undefined);
eq("a point extrude is unchanged", "loops" in extrudeOp("fuse", plane, [[0, 0], [1, 0], [0, 1]] as Vec2[], 2), false);
eq("a loft section can be loops", loftOp("fuse", [
  { origin: [0, 0, 0], turn: [0, 0, 0], loops: washer },
  { origin: [0, 0, 8], turn: [0, 0, 0], loops: washer },
]).sections[0]!.loops?.length, 2);

eq("the label counts loops", opLabel(made), "Extrude 2-loop profile 5 mm");

const fp = (volumeMm3: number) => ({ volumeMm3, faces: 6, edges: 12 });
const root = { kind: "primitive" as const, solid: { primitive: "box" as const, origin: [0, 0, 0] as Vec3, size: [40, 40, 10] as Vec3, radius: 0, height: 0, turn: [0, 0, 0] as Vec3 } };
const old: ModelOp = { kind: "extrude", op: "fuse", origin: [0, 0, 10], turn: [0, 0, 0], profile: [[0, 0], [4, 0], [4, 4], [0, 4]], depth: 2 };
let tree = newTree("k", root, "Box", fp(16000));
tree = withChild(tree, 0, { id: 1, op: old, label: opLabel(old), fingerprint: fp(16000) });
tree = withChild(tree, 1, { id: 2, op: made, label: opLabel(made), fingerprint: fp(17000) });
const json = JSON.parse(JSON.stringify({ ...savedTree(tree, 2, () => undefined), rootPrimitive: root.solid }));
const read = readSavedTree(json);
eq("loops and a point profile both come back", read?.nodes.map((node) => node.op), [null, old, made]);
eq("an old profile file has no loops key", read && "loops" in (read.nodes[1]!.op as object), false);

const damaged = JSON.parse(JSON.stringify(json));
(damaged.nodes[2].op.loops[0].segments[0] as { kind: string }).kind = "curve";
eq("a damaged segment drops the tree", readSavedTree(damaged), null);

const square = {
  kind: "extrude",
  op: "fuse",
  depth: 5,
  loops: [{ start: [0, 0], segments: [{ kind: "line", to: [10, 0] }, { kind: "line", to: [10, 10] }, { kind: "line", to: [0, 10] }, { kind: "line", to: [0, 0] }] }],
};
eq("the schema accepts a loops extrude", validateTool("model_apply", { object: "obj_1", op: square }), null);
eq("a bad segment kind is refused", validateTool("model_apply", { object: "obj_1", op: { ...square, loops: [{ start: [0, 0], segments: [{ kind: "curve", to: [1, 0] }] }] } }) !== null, true);

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("model-loops: ok");
