import {
  childWithOp,
  childrenOf,
  closeOrder,
  dropped,
  featureObjectName,
  jumped,
  newTree,
  nodeWithMesh,
  historyCaption,
  opLabel,
  pathTo,
  reachableTrees,
  redoTarget,
  reserveId,
  rootLabel,
  savedNodes,
  toolUser,
  undoTarget,
  usesTree,
  visitStep,
  withChild,
  withFeatureRoot,
  withNode,
  type ModelOp,
  type ModelTree,
  type PrepareKeep,
} from "./model-tree.ts";

let failed = 0;

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) return;
  failed += 1;
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}

function eq(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  check(name, a === b, `${a} vs ${b}`);
}

const cut: ModelOp = { kind: "boolean", op: "cut", primitive: "box", origin: [0, 0, 5], size: [10, 10, 10], radius: 0, height: 0, turn: [0, 0, 0] };
const hole: ModelOp = { kind: "hole", origin: [5, 5, 10], axis: [0, 0, -1], radius: 2, depth: 5 };
const scale: ModelOp = { kind: "scale", factor: 2 };
const fp = (volumeMm3: number) => ({ volumeMm3, faces: 6, edges: 12 });

function apply(tree: ModelTree, op: ModelOp, volume: number): ModelTree {
  const [next, id] = reserveId(tree);
  return withChild(next, next.current, { id, op, label: opLabel(op), fingerprint: fp(volume) });
}

const root = newTree("part#1", { kind: "step", name: "plate.step", bytes: new ArrayBuffer(4) }, "plate.step", fp(4000));
eq("a new tree shows and holds its root", [root.current, root.committed, undoTarget(root), redoTarget(root)], [0, 0, null, null]);

// Apply twice: 0 → 1 → 2.
const two = apply(apply(root, cut, 2000), hole, 1937);
eq("each Apply is a child of the shown node and is shown", [pathTo(two, 2), two.current], [[0, 1, 2], 2]);
eq("the plate still holds the root until it commits", two.committed, 0);
eq("Undo is the parent", undoTarget(two), 1);
eq("a leaf has no Redo", redoTarget(two), null);

// Undo twice, then Redo walks back down the same branch.
const back = jumped(jumped(two, 1), 0);
eq("Undo at the root goes nowhere", undoTarget(back), null);
eq("Redo from the root follows the branch it came from", redoTarget(back), 1);
eq("and then the next step on it", redoTarget(jumped(back, 1)), 2);

// Apply from a node that has children: a new branch, Redo follows it, the old one stays.
const branched = apply(jumped(two, 0), scale, 32000);
eq("a new branch gets a fresh id", branched.current, 3);
eq("both branches stay", childrenOf(branched, 0), [1, 3]);
eq("the old branch keeps its steps", pathTo(branched, 2), [0, 1, 2]);
eq("Redo from the parent follows the newest branch", redoTarget(jumped(branched, 0)), 3);
eq("jumping into the old branch makes Redo follow it again", redoTarget(jumped(jumped(branched, 2), 0)), 1);
eq("ids are never reused, even for a failed Apply", reserveId(reserveId(branched)[0])[1], 5);

// The same numbers from the same node are the step already built.
eq("an Apply of numbers already applied here finds that step", childWithOp(branched, 0, { ...cut, origin: [0, 0, 5] }), 1);
eq("other numbers find none", childWithOp(branched, 0, { ...cut, size: [10, 10, 11] }), null);
eq("the same numbers from another node find none", childWithOp(branched, 1, cut), null);
const blended = apply(root, { kind: "fillet", edges: [3], size: 1 }, 3990);
const stored = withNode(blended, 1, { op: { kind: "fillet", edges: [{ index: 3, mid: [0, 0, 5], lengthMm: 10 }], size: 1 } });
eq("a stored edge matches a fresh pick by index", childWithOp(stored, 0, { kind: "fillet", edges: [3], size: 1 }), 1);
eq("but not a chamfer of it", childWithOp(stored, 0, { kind: "chamfer", edges: [3], size: 1 }), null);
eq("a broken step is built again", childWithOp(withNode(branched, 1, { broken: "no" }), 0, cut), null);

// Saved nodes, parents first, for the engine's open.
eq(
  "the op list resends every node but the root, parents first",
  savedNodes(branched).map((node) => [node.id, node.parent, node.op.kind]),
  [[1, 0, "boolean"], [2, 1, "hole"], [3, 0, "scale"]],
);

// Drop a subtree.
const pruned = dropped(jumped(branched, 3), 1);
check("dropping a branch removes it and everything under it", pruned != null && !pruned.nodes.has(1) && !pruned.nodes.has(2) && pruned.nodes.has(3));
eq("Redo from its parent falls back to the remaining child", pruned && redoTarget(jumped(pruned, 0)), 3);
const other = dropped(jumped(branched, 0), 3);
eq("Redo falls back to the other branch when the newest goes", other && redoTarget(other), 1);
const bare = dropped(jumped(two, 0), 1);
eq("a node that loses its only child has no Redo", bare && redoTarget(bare), null);
eq("the root cannot be dropped", dropped(branched, 0), null);
eq("the branch the view shows cannot be dropped", dropped(jumped(branched, 2), 1), null);
eq("the branch the plate holds cannot be dropped", dropped({ ...jumped(branched, 3), committed: 2 }, 1), null);
const held = withNode(jumped(branched, 3), 2, { mesh: { name: "plate.stl", bytes: new ArrayBuffer(1), sourcePos: new Float32Array(0), token: "m2" } });
eq("nor one with a step the plate held, which a Prepare undo can bring back", dropped(held, 1), null);
eq("nor one with a split whose piece roots its own tree", dropped(withNode(jumped(branched, 3), 2, { piece: "part-piece#1" }), 1), null);

// The visit step: what the plate does when it takes the shown node.
const keep: PrepareKeep = { supportEdits: [], supportPaint: [{ x: 1 } as never], seamPaint: [], reinforcement: [], partScale: 1.5 };
eq("nothing to commit when the plate holds the shown node", visitStep(root), null);
eq("a node with no saved state starts with empty paint", visitStep(two), { from: 0, to: 2, keep: null, resetScale: false });
const kept = withNode(two, 0, { keep });
const backToRoot = { ...jumped(kept, 0), committed: 2 };
eq("returning to a node puts its saved state back", visitStep(backToRoot), { from: 2, to: 0, keep, resetScale: false });
eq("a scale between the two nodes resets placement scale", visitStep(jumped(branched, 3))?.resetScale, true);
eq("so does a scale on the way up", visitStep({ ...jumped(branched, 2), committed: 3 })?.resetScale, true);
eq("but not one on another branch", visitStep({ ...jumped(branched, 2), committed: 1 })?.resetScale, false);

// The plate mesh names its node.
const meshed = withNode(two, 1, { mesh: { name: "plate.stl", bytes: new ArrayBuffer(1), sourcePos: new Float32Array(0), token: "m7" } });
eq("a mesh token finds its node", nodeWithMesh(meshed, "m7"), 1);
eq("an unknown token finds none", nodeWithMesh(meshed, "m8"), null);

// Which trees stay: what the plate or a Prepare step names, by key or by a mesh, and their split relatives.
const mesh = (token: string) => ({ name: "plate.stl", bytes: new ArrayBuffer(1), sourcePos: new Float32Array(0), token });
const trees = new Map<string, ModelTree>([
  ["a#1", withNode(withNode(two, 1, { piece: "a-piece#2" }), 2, { mesh: mesh("m-a") })],
  ["a-piece#2", { ...newTree("a-piece#2", { kind: "piece", tree: "a#1", node: 1 }, "piece", fp(10)), key: "a-piece#2" }],
  ["b#3", withNode({ ...two, key: "b#3" }, 1, { mesh: mesh("m-b") })],
  ["c#4", { ...two, key: "c#4" }],
]);
eq("a key keeps its tree and the piece its split made", [...reachableTrees(trees, [{ id: "a", key: "a#1" }])].sort(), ["a#1", "a-piece#2"]);
eq("a piece keeps the tree it was split from", [...reachableTrees(trees, [{ id: "p", key: "a-piece#2" }])].sort(), ["a#1", "a-piece#2"]);
eq("an object without a key keeps a tree of its own with its mesh", [...reachableTrees(trees, [{ id: "b", token: "m-b" }])], ["b#3"]);
eq("and, as a copy, any tree with its mesh", [...reachableTrees(trees, [{ id: "copy", token: "m-b" }])], ["b#3"]);
eq("an object with a key keeps another tree only if that tree is its own", [...reachableTrees(trees, [{ id: "c", key: "c#4", token: "m-b" }])], ["c#4"]);
eq("nothing names the rest", [...reachableTrees(trees, [{ id: "gone", key: "gone#9", token: "m-x" }])], []);

const drawn = { v: 1 as const, plane: { origin: [0, 0, 0] as [number, number, number], turn: [0, 0, 0] as [number, number, number] }, points: [], entities: [], name: "Sketch 1" };
const drawn2 = { ...drawn, name: "Sketch 2" };
const extrude: ModelOp = { kind: "extrude", op: "cut", origin: [0, 0, 0], turn: [0, 0, 0], profile: [[0, 0], [1, 0], [0, 1]], depth: -20, sketch: drawn };
const revolve: ModelOp = { kind: "revolve", op: "fuse", origin: [0, 0, 0], turn: [0, 0, 0], profile: [[0, 0], [1, 0], [0, 1]], angleDeg: 270, sketch: drawn };
const loft: ModelOp = { kind: "loft", op: "fuse", sections: [], drawing: { sketches: [drawn, drawn2] } };
eq("a sketch feature is named from the sketch, and an MCP step keeps opLabel", [
  historyCaption(extrude, opLabel(extrude)),
  historyCaption(revolve, opLabel(revolve)),
  historyCaption(loft, opLabel(loft)),
  historyCaption(cut, opLabel(cut)),
], ["Extrude Sketch 1, 20 mm, cut", "Revolve Sketch 1, 270°", "Loft Sketch 1 → Sketch 2", opLabel(cut)]);

eq("labels", [cut, hole, scale, { kind: "split", origin: [0, 0, 4.5], normal: [0, 0, 1] }, { kind: "split", origin: [10, 5, 5], normal: [1, 0, 0] }, { kind: "fillet", edges: [1, 2, 3], size: 1 }].map((op) => opLabel(op as ModelOp)), [
  "Cut box 10×10×10",
  "Hole ⌀4 depth 5",
  "Scale 200 %",
  "Split at Z 4.5",
  "Split at X 10",
  "Fillet 3 edges r 1",
]);

// Joins between trees ------------------------------------------------------------------------------------------------

const place = { m: [1, 0, 0, 0, 1, 0, 0, 0, 1] as [number, number, number, number, number, number, number, number, number], t: [0, 0, 0] as [number, number, number] };
const join = (op: "fuse" | "cut" | "common", key: string, node: number, name: string): ModelOp => ({ kind: "join", op, tool: { object: key.split("#")[0]!, key, node, name }, relative: place, keepTool: false });
eq("joins label by the tool's name as it was at Apply", [opLabel(join("cut", "split#1", 0, "telo split")), opLabel(join("fuse", "box#1", 2, "Box 1")), opLabel(join("common", "s#1", 0, "Sphere 1"))], ["Cut telo split", "Fuse Box 1", "Intersect Sphere 1"]);
const stepRoot = { kind: "step" as const, name: "a.step", bytes: new ArrayBuffer(1) };
const toolTree = withChild(newTree("b#1", stepRoot, "b", fp(80)), 0, { id: 1, op: hole, label: "Hole", fingerprint: fp(70) });
const targetTree = withChild(newTree("a#1", stepRoot, "a", fp(8000)), 0, { id: 1, op: join("cut", "b#1", 1, "b"), label: "Cut b", fingerprint: fp(7990) });
const chainTree = withChild(newTree("c#1", stepRoot, "c", fp(900)), 0, { id: 1, op: join("fuse", "a#1", 1, "a"), label: "Fuse a", fingerprint: fp(9000) });
const all = new Map([toolTree, targetTree, chainTree].map((tree) => [tree.key, tree]));
eq("a tool off the plate stays while a join names it, at any depth", [...reachableTrees(all, [{ id: "c", key: "c#1" }])].sort(), ["a#1", "b#1", "c#1"]);
eq("and goes with the last join that names it", [...reachableTrees(all, [{ id: "b", key: "b#1" }])], ["b#1"]);
eq("a history uses its tools' trees, at any depth, and its own", [usesTree(all, "c#1", "b#1"), usesTree(all, "a#1", "b#1"), usesTree(all, "b#1", "a#1"), usesTree(all, "a#1", "a#1")], [true, true, false, true]);
eq("the join that keeps a tool's step", [toolUser(all, "b#1", new Set([1]))?.label, toolUser(all, "b#1", new Set([0])), toolUser(all, "a#1", new Set([0, 1]))?.label], ["Cut b", null, "Fuse a"]);
eq("trees close each before its tools", closeOrder(all, ["b#1", "a#1", "c#1"]), ["c#1", "a#1", "b#1"]);
eq("a tree not closing changes nothing", closeOrder(all, ["b#1", "a#1"]), ["a#1", "b#1"]);
eq("a join is saved as its op, ready to replay", savedNodes(targetTree).map((node) => node.op.kind), ["join"]);

const sketch = { kind: "extrude" as const, op: "fuse" as const, origin: [0, 0, 0] as [number, number, number], turn: [0, 0, 0] as [number, number, number], profile: [[0, 0], [10, 0], [10, 10], [0, 10]] as [number, number][], depth: 10 };
const taller = { ...sketch, depth: 20 };
eq("a feature root is named from its op", rootLabel({ kind: "feature", op: sketch }, "file"), opLabel(sketch));
eq("a feature solid is named Extrude, Revolve, or Loft, numbered past the names taken", [featureObjectName(["Box 1"], "extrude"), featureObjectName(["Extrude 1", "Extrude 2"], "revolve"), featureObjectName(["Loft 1"], "loft")], ["Extrude 1", "Revolve 1", "Loft 2"]);
const sketched = newTree("ex#1", { kind: "feature", op: sketch }, opLabel(sketch), fp(1000));
const editedRoot = withFeatureRoot(sketched, taller);
eq("editing a feature root keeps node 0 and renames it", [editedRoot.nodes.get(0)?.id, editedRoot.root, editedRoot.nodes.get(0)?.label], [0, { kind: "feature", op: taller }, opLabel(taller)]);

if (failed) {
  console.error(`${failed} failed`);
  throw new Error(`${failed} failed`);
}
console.log("model tree: path, branch, redo, drop, visit step, joins ok");
