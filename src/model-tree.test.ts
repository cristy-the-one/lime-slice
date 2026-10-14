import {
  childWithOp,
  childrenOf,
  dropped,
  jumped,
  newTree,
  nodeWithMesh,
  opLabel,
  pathTo,
  redoTarget,
  reserveId,
  savedNodes,
  undoTarget,
  visitStep,
  withChild,
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

eq("labels", [cut, hole, scale, { kind: "split", origin: [0, 0, 4.5], normal: [0, 0, 1] }, { kind: "fillet", edges: [1, 2, 3], size: 1 }].map((op) => opLabel(op as ModelOp)), [
  "Cut box 10×10×10",
  "Hole ⌀4 depth 5",
  "Scale 200 %",
  "Split at Z 4.5",
  "Fillet 3 edges r 1",
]);

if (failed) {
  console.error(`${failed} failed`);
  throw new Error(`${failed} failed`);
}
console.log("model tree: path, branch, redo, drop, visit step ok");
