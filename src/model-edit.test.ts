import { eulerOrient } from "./mesh-place.ts";
import { builtBranch, editHead, editNotes, editPanel, editRefusal, editedOp, forked, matchEdges, olderSplitNote, replayChain, type EditPanel } from "./model-edit.ts";
import { historyLayout } from "./model-history.ts";
import { planeFor, splitBase } from "./model-plane.ts";
import { primitiveSpec, type PrimitiveSpec } from "./model-primitive.ts";
import { fromSolidOp, toSolidOp, type Affine } from "./model-space.ts";
import { loadedTree, readSavedTree, savedTree } from "./model-tree-file.ts";
import { childrenOf, jumped, newTree, opLabel, pathTo, redoTarget, reserveId, withChild, withNode, type ModelOp, type ModelTree, type Vec3 } from "./model-tree.ts";

let failed = 0;

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) return;
  failed += 1;
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}

function eq(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  check(name, a === b, `got ${a}, want ${b}`);
}

function nearVec(a: readonly number[], b: readonly number[], tol = 1e-9): boolean {
  return a.length === b.length && a.every((value, i) => Math.abs(value - b[i]!) < tol);
}

const fp = (volumeMm3: number) => ({ volumeMm3, faces: 6, edges: 12 });
const boxSpec: PrimitiveSpec = { primitive: "box", origin: [-10, -10, 0], size: [20, 20, 20], radius: 0, height: 0, turn: [0, 0, 0] };
const cut: ModelOp = { kind: "boolean", op: "cut", primitive: "box", origin: [0, 0, 15], size: [5, 5, 5], radius: 0, height: 0, turn: [0, 0, 0] };
const hole = (radius: number): ModelOp => ({ kind: "hole", origin: [0, 0, 20], axis: [0, 0, -1], radius, depth: 8 });
const fillet: ModelOp = { kind: "fillet", edges: [{ index: 3, mid: [0, -10, 0], lengthMm: 20 }], size: 1 };
const scale: ModelOp = { kind: "scale", factor: 2 };

function apply(tree: ModelTree, op: ModelOp, volume: number): ModelTree {
  const [next, id] = reserveId(tree);
  return withChild(next, next.current, { id, op, label: opLabel(op), fingerprint: fp(volume) });
}

// Box 1 → cut (1) → hole (2) → fillet (3) → scale (4), all on one branch, the tip shown.
const start = newTree("box#1", { kind: "primitive", solid: boxSpec }, "Box 20×20×20", fp(8000));
const line = [cut, hole(2), fillet, scale].reduce((tree, op, i) => apply(tree, op, 8000 - i), start);

// Which descendants replay.
eq("an edit at the tip's parent replays the steps down to the tip", replayChain(line, 2, 4), [3, 4]);
eq("an edit of the shown step replays only what Redo would walk", replayChain(line, 4, 4), []);
const shownMid = jumped({ ...line, current: 2 }, 2);
eq("with an earlier step shown, the steps Redo walks come along", replayChain(shownMid, 1, 2), [2, 3, 4]);
eq("an edit of a step Redo would walk replays the rest of it", replayChain(shownMid, 3, 2), [4]);
// A side branch: from step 2, a second hole (5), shown. Editing the old branch's fillet replays its own Redo branch.
const branched = apply(jumped(line, 2), hole(1), 7000);
eq("a side branch's step replays its own branch, not the shown one", replayChain(branched, 3, branched.current), [4]);
eq("a step above the fork replays down the shown branch only", replayChain(branched, 1, branched.current), [2, 5]);
eq("the root replays the shown branch", replayChain(branched, 0, branched.current), [1, 2, 5]);

// The fork: edit the hole to ⌀6. The engine built 6 (the hole) and 7, 8 (the fillet and scale replayed).
const edited = forked(
  line,
  1,
  [
    { id: 6, op: hole(3), fingerprint: fp(7900) },
    { id: 7, op: fillet, fingerprint: fp(7895), name: "Round" },
    { id: 8, op: scale, fingerprint: fp(63160) },
  ],
  8,
);
eq("the edited step is a sibling of the old one", childrenOf(edited, 1), [2, 6]);
eq("the replayed steps hang under it, and the view is on the tip", [pathTo(edited, 8), edited.current], [[0, 1, 6, 7, 8], 8]);
eq("labels come from the new ops", [6, 7, 8].map((id) => edited.nodes.get(id)?.label), ["Hole ⌀6 depth 8", "Fillet 1 edge r 1", "Scale 200 %"]);
eq("a renamed step keeps its name", edited.nodes.get(7)?.name, "Round");
eq("the old branch is untouched", [2, 3, 4].map((id) => line.nodes.get(id) === edited.nodes.get(id)), [true, true, true]);
eq("Redo from the step above follows the edit", edited.lastChild.get(1), 6);
eq("ids move on past the new steps", edited.nextId, 9);
const rows = historyLayout(edited).rows;
eq("the history draws the edit as the main rail and the old branch beside it", rows.map((row) => [row.id, row.lane]), [[0, 0], [1, 0], [2, 1], [3, 1], [4, 1], [6, 0], [7, 0], [8, 0]]);

// A replay that breaks: the fillet did not build. It is kept, broken, with the scale under it unbuilt.
const broke = forked(line, 1, [{ id: 6, op: hole(3), fingerprint: fp(7900) }, { id: 7, op: fillet, fingerprint: null, broken: "That edge is not on this solid" }, { id: 8, op: scale, fingerprint: null }], 6);
eq("the view shows the last step that built", broke.current, 6);
eq("Redo stops there, since it could not show the broken step", redoTarget(broke), null);
const brokeRows = historyLayout(broke).rows;
eq("the broken step carries the engine's message, the step after it is blocked", brokeRows.filter((row) => row.id >= 6).map((row) => [row.id, row.broken, row.blocked]), [[6, null, false], [7, "That edge is not on this solid", false], [8, null, true]]);

// Editing the broken fillet replays the scale under it, though Redo stops before the broken step.
eq("the steps under a broken step follow it", replayChain(broke, 7, broke.current), [8]);
// A reopened tree knows only the path to its shown step; elsewhere a branch goes on with its newest step.
const reopenedFork = { ...jumped({ ...edited, lastChild: new Map() }, 2), current: 2 };
eq("off the shown path, a branch goes on with its newest child", replayChain(reopenedFork, 6, 2), [7, 8]);
// A root edited twice: the first edit's root step is not replayed, since the new root stands in for it.
const rootEdited = forked(line, 0, [{ id: 6, op: { kind: "root", ...boxSpec, size: [30, 30, 20] }, fingerprint: fp(18000) }, { id: 7, op: cut, fingerprint: fp(17000) }], 7);
eq("editing the root again replays the steps after the earlier root step, not that step", replayChain(rootEdited, 0, 7), [7]);
eq("a root step heads its panel as the new solid", editHead(rootEdited, 6), "Editing the new solid: Box 30×30×20");
eq("the same numbers find the branch an edit already built", builtBranch(edited, 1, hole(3), [fillet, scale]), 8);
eq("other numbers find none", [builtBranch(edited, 1, hole(2.5), [fillet, scale]), builtBranch(edited, 1, hole(3), [fillet, cut])], [null, null]);
eq("a broken step is not a branch to show", builtBranch(broke, 1, hole(3), [fillet]), null);

// Why a step cannot be edited.
const stepTree = apply(newTree("plate#1", { kind: "step", name: "plate.step", bytes: new ArrayBuffer(4) }, "plate.step", fp(4000)), cut, 3900);
eq("the opened file is not editable", editRefusal(stepTree, 0), "The opened file starts the history. Its steps can be edited, not the file.");
eq("a step after it is", editRefusal(stepTree, 1), null);
eq("a new solid's root is", editRefusal(line, 0), null);
const pieceTree = newTree("plate-piece#1", { kind: "piece", tree: "plate#1", node: 1 }, "plate split", fp(100));
eq("a piece's root is not", editRefusal(pieceTree, 0), "This piece is as its split cut it. Edit that split in the part it came from.");
eq("the broken step itself can be edited", editRefusal(broke, 7), null);
eq("a step under a broken one cannot", editRefusal(broke, 8), "A step above this one cannot be rebuilt. Edit or delete that step first.");
eq("an edit of the root starts from its primitive", editedOp(line, 0), { kind: "root", ...boxSpec });
eq("the header names the step and its label", [editHead(line, 2), editHead(line, 0), editHead(edited, 7)], ["Editing step 2: Hole ⌀4 depth 8", "Editing the new solid: Box 20×20×20", "Editing step 3: Round"]);

// The panel opens in model space: under a turned and moved pose, its numbers sent back through `toSolidOp` are the op again.
const skew: Affine = { m: eulerOrient(30, -50, 115), t: [12.5, 3, -40] };
const center: Vec3 = [7, -3, 11];
const turnedBox: Extract<ModelOp, { kind: "boolean" }> = { kind: "boolean", op: "common", primitive: "box", origin: [1, 2, 3], size: [10, 4, 6], radius: 0, height: 0, turn: [20, 10, -35] };
const fields = (panel: EditPanel) => (id: string) => panel.fields[id] ?? Number.NaN;
const fromPanel = (panel: EditPanel): ModelOp => {
  const f = fields(panel);
  const sizes = { size: [f("modelDx"), f("modelDy"), f("modelDz")] as Vec3, radius: f("modelRadius"), height: f("modelHeight"), topRadius: f("modelTopR"), tubeRadius: f("modelTube"), innerRadius: f("modelInnerR"), topX: f("modelTopX"), sides: f("modelSides"), across: f("modelAcross"), flats: panel.flats ?? false };
  return { kind: "boolean", op: panel.boolOp!, ...primitiveSpec(panel.primitive!, sizes, [f("modelX"), f("modelY"), f("modelZ")], [f("modelRx"), f("modelRy"), f("modelRz")]) };
};
const boxPanel = editPanel(turnedBox, skew, center);
eq("a boolean opens Boolean on its primitive and op", [boxPanel.tool, boxPanel.primitive, boxPanel.boolOp], ["boolean", "box", "common"]);
const boxBack = toSolidOp(fromPanel(boxPanel), skew) as typeof turnedBox;
check("a turned box comes back to the stored op", nearVec(boxBack.origin, turnedBox.origin) && nearVec(boxBack.turn, turnedBox.turn) && nearVec(boxBack.size, turnedBox.size), JSON.stringify(boxBack));
eq("only the box's own size fields are written", Object.keys(boxPanel.fields).sort(), ["modelDx", "modelDy", "modelDz", "modelRx", "modelRy", "modelRz", "modelX", "modelY", "modelZ"]);
const tilted: ModelOp = { kind: "hole", origin: [3, 4, 9], axis: [0.6, 0, -0.8], radius: 2.5, depth: 7 };
const holePanel = editPanel(tilted, skew, center);
const hf = fields(holePanel);
const holeBack = toSolidOp({ kind: "hole", origin: [hf("modelX"), hf("modelY"), hf("modelZ")], axis: holePanel.axis!, radius: hf("modelHoleR"), depth: hf("modelHoleD") }, skew) as Extract<ModelOp, { kind: "hole" }>;
check("a hole drilled at a slant comes back with its origin and axis", nearVec(holeBack.origin, [3, 4, 9]) && nearVec(holeBack.axis, [0.6, 0, -0.8]) && holeBack.radius === 2.5 && holeBack.depth === 7, JSON.stringify(holeBack));
// A split the panel can only say with its axis turned around: a face split on a face that points down model −Y.
const down = toSolidOp({ kind: "split", origin: [2, -6, 1], normal: [0.2, -0.9, 0.1] }, skew) as Extract<ModelOp, { kind: "split" }>;
const splitPanel = editPanel(down, skew, center);
eq("a split opens on its nearest model axis, turned around", splitPanel.plane, { mode: "y", flip: true });
const sf = fields(splitPanel);
const base = splitBase(splitPanel.plane!.mode, center, null)!;
const plan = planeFor({ ...base, normal: [0, -1, 0] }, sf("modelPlane"), [sf("modelTiltA"), sf("modelTiltB")], () => null, null);
const splitBack = toSolidOp({ kind: "split", origin: plan.origin, normal: plan.normal }, skew) as typeof down;
const unit = (v: Vec3) => v.map((value) => value / Math.hypot(...v)) as Vec3;
const along = (op: typeof down) => unit(op.normal).reduce((sum, value, i) => sum + value * op.origin[i]!, 0);
check("the panel's plane is the stored plane, on the same side", nearVec(unit(splitBack.normal), unit(down.normal), 1e-9) && Math.abs(along(splitBack) - along(down)) < 1e-9, JSON.stringify([splitBack, down]));
check("its pivot sits on the line through the solid's middle", Math.abs(plan.origin[0] - center[0]) < 1e-9 && Math.abs(plan.origin[2] - center[2]) < 1e-9);
const upPanel = editPanel({ kind: "split", origin: [0, 0, 42], normal: [0, 0, 1] }, { m: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] }, center);
eq("a plain Z split opens as Plane Z at its height, untilted", [upPanel.plane, upPanel.fields], [{ mode: "z", flip: false }, { modelPlane: 42, modelTiltA: 0, modelTiltB: 0 }]);
eq("a root opens New solid's panel with its sizes", editPanel({ kind: "root", ...boxSpec }, skew, center), { tool: "create", fields: { modelDx: 20, modelDy: 20, modelDz: 20 }, primitive: "box" });
eq("a polygon keeps its flats", editPanel({ kind: "root", primitive: "polygon", origin: [0, 0, 0], size: [0, 0, 0], radius: 0, height: 4, turn: [0, 0, 0], sides: 6, across: 10, flats: true }, skew, center).flats, true);
const join: ModelOp = { kind: "join", op: "cut", tool: { object: "b", key: "b#1", node: 0, name: "Box 2" }, relative: { m: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] }, keepTool: true };
eq("a join keeps its tool and opens with its op and Keep", editPanel(join, skew, center), { tool: "boolean", fields: {}, boolOp: "cut", join: { name: "Box 2", keepTool: true } });
check("a pose of identity opens the stored numbers as they are", fromSolidOp(turnedBox, { m: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] }) === turnedBox);

// Edge matching for a fillet's panel.
const edge = (id: number, lengthMm: number, points: number[]) => ({ id, lengthMm, points: new Float32Array(points) });
const shown = [edge(0, 20, [-10, -10, 0, 10, -10, 0]), edge(1, 20, [10, -10, 0, 10, 10, 0]), edge(2, 30, [-15, -15, 0, 15, -15, 0])];
eq("an edge at its index is taken", matchEdges(shown, [{ index: 1, mid: [10, 0, 0], lengthMm: 20 }], 0.1), { picked: [1], missing: 0 });
eq("an edge renumbered is found by its midpoint and length", matchEdges(shown, [{ index: 2, mid: [0, -10, 0], lengthMm: 20 }], 0.1), { picked: [0], missing: 0 });
eq("an edge no longer on the solid is missing", matchEdges(shown, [{ index: 0, mid: [0, -12, 0], lengthMm: 24 }, 2], 0.1), { picked: [2], missing: 1 });

// The `.lime` round trip of a tree with an edit fork, a root edit among it.
const rerooted = forked(edited, 0, [{ id: 9, op: { kind: "root", ...boxSpec, origin: [-15, -15, 0], size: [30, 30, 20] }, fingerprint: fp(18000) }, { id: 10, op: cut, fingerprint: fp(17875) }], 10);
const saved = JSON.parse(JSON.stringify({ ...savedTree(rerooted, rerooted.committed, () => undefined), rootPrimitive: boxSpec }));
const read = readSavedTree(saved);
check("a tree with an edit fork reads back", !!read);
const reopened = loadedTree(read!, "box#2", { kind: "primitive", solid: boxSpec }, "Box 1", null, () => undefined);
eq("both branches come back, with their labels", [...reopened.nodes.values()].map((node) => [node.id, node.parent, node.label]), [...rerooted.nodes.values()].sort((a, b) => a.id - b.id).map((node) => [node.id, node.parent, node.label]));
eq("the root's edit reads as its primitive", reopened.nodes.get(9)?.label, "Box 30×30×20");
eq("Redo from the root leads to the shown step", pathTo(reopened, 10), [0, 9, 10]);
const misplaced = JSON.parse(JSON.stringify(saved));
misplaced.nodes.find((node: { id: number }) => node.id === 10).op = { kind: "root", ...boxSpec };
eq("a root step anywhere but under the root is a damaged tree", readSavedTree(misplaced), null);

// What an edit leaves as it was: a split's piece that is a part of its own, and another part's join.
const split: ModelOp = { kind: "split", origin: [0, 0, 5], normal: [0, 0, 1] };
const cutUp = withNode(apply(apply(start, split, 4000), hole(2), 3900), 1, { piece: "box-piece#1" });
const user = withChild(newTree("other#1", { kind: "primitive", solid: boxSpec }, "Box 2", fp(8000)), 0, { id: 1, op: { ...join, tool: { object: "box", key: "box#1", node: 2, name: "Box 1" } }, label: "Cut Box 1", fingerprint: fp(7000) });
const trees = new Map([[cutUp.key, cutUp], [user.key, user]]);
eq(
  "the piece stays as the older split cut it, and the join names the old step",
  editNotes(trees, cutUp, [1, 2], (key) => (key === "box-piece#1" ? "Box 1 split" : null)),
  ["Box 1 split stays as the older split cut it.", "“Cut Box 1” in another part still uses this part as it was before the edit."],
);
// The piece keeps a note once its part's plate step is no longer under the split that cut it.
const piece = newTree("box-piece#1", { kind: "piece", tree: cutUp.key, node: 1 }, "Box 1 split", fp(4000));
eq("a piece whose split is on its part's plate step has no note", olderSplitNote(new Map([[cutUp.key, { ...cutUp, committed: 2 }]]), piece), null);
const resplit = { ...forked(cutUp, 0, [{ id: 9, op: split, fingerprint: fp(4100) }], 9), committed: 9 };
eq("once the plate takes an edit of that split, it says so", olderSplitNote(new Map([[cutUp.key, resplit]]), piece), "This piece was cut by a split that its part's steps on the plate no longer have.");
eq("a piece no longer on the plate, and no join, say nothing",editNotes(new Map([[cutUp.key, cutUp]]), cutUp, [1, 2], () => null), []);

if (failed) {
  console.error(`${failed} failed`);
  throw new Error(`${failed} failed`);
}
console.log("model edit: replay chain, fork, refusals, panel, edges, save, notes ok");
