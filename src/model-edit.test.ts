import { eulerOrient } from "./mesh-place.ts";
import { builtBranch, crossEdit, crossPlan, editHead, editNotes, editPanel, editRefusal, editedOp, forked, matchEdges, matchFaces, olderSplitNote, replayChain, toolEditHead, toolEditRefusal, toolPose, type EditPanel } from "./model-edit.ts";
import { stepEdges } from "./model-request.ts";
import { historyLayout } from "./model-history.ts";
import { planeFor, splitBase } from "./model-plane.ts";
import { primitiveSpec, type PrimitiveSpec } from "./model-primitive.ts";
import { fromSolidOp, toSolidOp, type Affine } from "./model-space.ts";
import { loadedTree, readSavedTree, savedTree } from "./model-tree-file.ts";
import { childrenOf, jumped, newTree, opLabel, pathTo, redoTarget, reserveId, rootLabel, withChild, withNode, type ModelOp, type ModelTree, type Vec3 } from "./model-tree.ts";

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
const extrudeRoot = { kind: "extrude" as const, op: "fuse" as const, origin: [0, 0, 0] as Vec3, turn: [0, 0, 0] as Vec3, profile: [[0, 0], [10, 0], [10, 10], [0, 10]] as [number, number][], depth: 10 };
const featureTree = newTree("ex#1", { kind: "feature", op: extrudeRoot }, rootLabel({ kind: "feature", op: extrudeRoot }, "Extrude 1"), fp(1000));
eq("a sketch-started root can be edited", editRefusal(featureTree, 0), null);
eq("its edit starts from the feature", editedOp(featureTree, 0), extrudeRoot);
eq("its header names the extrude", editHead(featureTree, 0), `Editing the new solid: ${opLabel(extrudeRoot)}`);
eq("a tool's sketch root is named as a sketch", toolEditHead(featureTree, 0, "Extrude 1"), `Editing Extrude 1's sketch: ${opLabel(extrudeRoot)}`);

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
eq("a step fillet opens on that step", editPanel({ kind: "fillet", edges: [stepEdges(2, "convex")], size: 1 }, skew, center), {
  tool: "fillet",
  fields: { modelBlend: 1 },
  edges: [],
  step: { fromNode: 2, filter: "convex" },
});
eq("a picked fillet has no step", editPanel(fillet, skew, center).step, undefined);

// Face matching for a shell's panel, the same rules as the edges above.
const face = (id: number, areaMm2: number, mid: Vec3) => ({ id, areaMm2, mid });
const faces = [face(0, 400, [10, 10, 0]), face(1, 400, [10, 10, 10]), face(2, 200, [10, 0, 5])];
eq("a face at its index is taken", matchFaces(faces, [{ index: 1, mid: [10, 10, 10], areaMm2: 400 }], 0.1), { picked: [1], missing: 0 });
eq("a face renumbered is found by its middle and area", matchFaces(faces, [{ index: 4, mid: [10, 10, 10], areaMm2: 400 }], 0.1), { picked: [1], missing: 0 });
eq("a face no longer on the solid is missing", matchFaces(faces, [{ index: 1, mid: [0, 0, 0], areaMm2: 10 }, 2], 0.1), { picked: [2], missing: 1 });
eq("two faces that both fit count as missing", matchFaces([face(0, 400, [10, 10, 10]), face(1, 400, [10, 10, 10])], [{ index: 9, mid: [10, 10, 10], areaMm2: 400 }], 0.1), { picked: [], missing: 1 });
eq("a face within the chord slack is taken", matchFaces(faces, [{ index: 9, mid: [10, 10, 10.05], areaMm2: 400 }], 0.1), { picked: [1], missing: 0 });
const identity = { m: [1, 0, 0, 0, 1, 0, 0, 0, 1] as Affine["m"], t: [0, 0, 0] as Vec3 };
const openShell = editPanel({ kind: "shell", thickness: 2, openFaces: [{ index: 1, mid: [10, 10, 10], areaMm2: 400 }] }, identity, center);
eq("an open shell keeps its thickness and its faces", [openShell.tool, openShell.fields, openShell.shellClosed, openShell.faces], ["shell", { modelShell: 2 }, false, [{ index: 1, mid: [10, 10, 10], areaMm2: 400 }]]);
const closedShell = editPanel({ kind: "shell", thickness: 1.5 }, identity, center);
eq("a closed shell opens with the box on and no faces", [closedShell.fields, closedShell.shellClosed, closedShell.faces], [{ modelShell: 1.5 }, true, []]);
eq("a pose does not change a shell's thickness", editPanel({ kind: "shell", thickness: 2, openFaces: [1] }, skew, center).fields.modelShell, 2);

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

// Editing a tool's step from the history of the part its join cut. A rod: its cylinder, a scale (the step the join
// takes), and a hole after it. The box: a cut, the join (2), and a corner cut after it, shown.
const placed: Affine = { m: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [10, 10, -15] };
const rodSpec: PrimitiveSpec = { primitive: "cylinder", origin: [0, 0, 0], size: [0, 0, 0], radius: 2, height: 40, turn: [0, 0, 0] };
const rodTree = [{ kind: "scale", factor: 1.5 } as ModelOp, hole(1)].reduce((tree, op, i) => apply(tree, op, 500 - i), newTree("rod#1", { kind: "primitive", solid: rodSpec }, "Cylinder ⌀4 h 40", fp(502)));
const takeRod = (node: number): Extract<ModelOp, { kind: "join" }> => ({ kind: "join", op: "cut", tool: { object: "rod", key: "rod#1", node, name: "Rod 1" }, relative: placed, keepTool: false });
const corner: ModelOp = { kind: "boolean", op: "cut", primitive: "box", origin: [0, 0, 15], size: [5, 5, 5], radius: 0, height: 0, turn: [0, 0, 0] };
const boxTree = [cut, takeRod(1), corner].reduce((tree, op, i) => apply(tree, op, 8000 - i), start);
const handed = new Map<string, number>([[rodTree.key, rodTree.nextId], [boxTree.key, boxTree.nextId]]);
const reserve = (key: string, count: number) => {
  const first = handed.get(key)!;
  handed.set(key, first + count);
  return Array.from({ length: count }, (_, i) => first + i);
};
const links = [{ tree: boxTree, id: 2, op: takeRod(1) }];
const wider: ModelOp = { kind: "scale", factor: 1.25 };
const levels = crossEdit(rodTree, links, 1, wider, replayChain(boxTree, 2, boxTree.current), reserve);
eq("the tool's tree forks at its step, down to the step the join takes; the join is built again on the new tip, and the box's later steps replay", levels, [
  { key: "rod#1", parent: 0, node: 3, op: wider, replay: [], old: [1] },
  { key: "box#1", parent: 1, node: 4, op: takeRod(3), replay: [{ id: 5, op: corner }], old: [2, 3] },
]);
const rootLevels = crossEdit(rodTree, links, 0, { kind: "root", ...rodSpec, radius: 3 }, [3], (key, count) => Array.from({ length: count }, (_, i) => (key === "rod#1" ? 10 : 20) + i));
eq("the tool's primitive edits as a root step under its root, its scale replayed but not the hole after the join's step", rootLevels.map((level) => [level.key, level.parent, level.node, level.replay.map((step) => [step.id, step.op.kind])]), [
  ["rod#1", 0, 10, [[11, "scale"]]],
  ["box#1", 1, 20, [[21, "boolean"]]],
]);
eq("and the join names the new tip", (rootLevels[1]!.op as Extract<ModelOp, { kind: "join" }>).tool.node, 11);
const rodForked = forked(rodTree, 0, [{ id: 3, op: wider, fingerprint: fp(400) }], rodTree.current, false);
eq("the tool's own tree keeps its shown step and where Redo goes from the parent", [rodForked.current, rodForked.lastChild.get(0) ?? null, childrenOf(rodForked, 0)], [rodTree.current, rodTree.lastChild.get(0) ?? null, [1, 3]]);
const boxForked = forked(boxTree, 1, [{ id: 4, op: takeRod(3), fingerprint: fp(7000) }, { id: 5, op: corner, fingerprint: fp(6875) }], 5);
const both = [{ tree: boxForked, id: 2, op: takeRod(1) }];
eq("the same numbers find the branch built before, in every tree", crossPlan(rodForked, both, 1, wider, [3]), { twin: 5 });
const narrower: ModelOp = { kind: "scale", factor: 1.1 };
const fresh = crossPlan(rodForked, both, 1, narrower, [3]);
eq("other numbers build every tree", "from" in fresh && [fresh.from.tool.key, fresh.from.joins, fresh.from.node, fresh.from.op, fresh.reused], ["rod#1", both, 1, narrower, null]);
// The box's branch of that edit deleted: the rod's still stands, so the edit builds the join on it, and no twin of it.
const boxOnly = crossPlan(rodForked, links, 1, wider, [3]);
eq("with the part's branch deleted, the tool's branch built before is taken, and the edit starts at the join", "from" in boxOnly && [boxOnly.from.tool.key, boxOnly.from.joins, boxOnly.from.node, boxOnly.from.op, boxOnly.reused], ["box#1", [], 2, takeRod(3), 3]);
eq("so only the part's tree is built again", "from" in boxOnly && crossEdit(boxOnly.from.tool, boxOnly.from.joins, boxOnly.from.node, boxOnly.from.op, [3], () => [6, 7]), [
  { key: "box#1", parent: 1, node: 6, op: takeRod(3), replay: [{ id: 7, op: corner }], old: [2, 3] },
]);

// A box that takes the rod's hole (step 2): an edit of the rod's scale (step 1) replays the hole under it.
const boxHole = [cut, takeRod(2)].reduce((tree, op, i) => apply(tree, op, 8000 - i), start);
const holeLinks = [{ tree: boxHole, id: 2, op: takeRod(2) }];
const rodWhole = forked(rodTree, 0, [{ id: 3, op: wider, fingerprint: fp(400) }, { id: 4, op: hole(1), fingerprint: fp(300) }], rodTree.current, false);
const pastHole = crossPlan(rodWhole, holeLinks, 1, wider, []);
eq("the step reused for the edited one is the scale, and the join takes the hole after it", "from" in pastHole && [pastHole.reused, (pastHole.from.op as Extract<ModelOp, { kind: "join" }>).tool.node], [3, 4]);
// A first branch cut short by Delete branch in the rod's own History, and a whole one beside it: the whole one is taken.
const rodShort = forked(forked(rodTree, 0, [{ id: 3, op: wider, fingerprint: fp(400) }], rodTree.current, false), 0, [{ id: 4, op: wider, fingerprint: fp(400) }, { id: 5, op: hole(1), fingerprint: fp(300) }], rodTree.current, false);
const besideShort = crossPlan(rodShort, holeLinks, 1, wider, []);
eq("a branch cut short is passed over for a whole one with the same numbers", "from" in besideShort && [besideShort.reused, (besideShort.from.op as Extract<ModelOp, { kind: "join" }>).tool.node], [4, 5]);
eq("and an edit of the part's own step finds it too", builtBranch(rodShort, 0, wider, [hole(1)]), 5);

// Nested: a plate takes the box's step 2, which took the rod's step 1. An edit of the rod reaches the plate.
const plateTree = apply(newTree("plate#1", { kind: "step", name: "plate.step", bytes: new ArrayBuffer(4) }, "plate.step", fp(9000)), { kind: "join", op: "common", tool: { object: "box", key: "box#1", node: 2, name: "Box 1" }, relative: { m: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [1, 2, 3] }, keepTool: false }, 6000);
const deepLinks = [{ tree: plateTree, id: 1, op: plateTree.nodes.get(1)!.op as Extract<ModelOp, { kind: "join" }> }, { tree: boxTree, id: 2, op: takeRod(1) }];
const deep = crossEdit(rodTree, deepLinks, 1, wider, [], (key, count) => Array.from({ length: count }, (_, i) => ({ "rod#1": 30, "box#1": 40, "plate#1": 50 })[key]! + i));
eq("three trees, deepest first: the box replays nothing past the step the plate takes", deep.map((level) => [level.key, level.parent, level.node, level.replay.length, level.op.kind === "join" ? level.op.tool.node : null]), [
  ["rod#1", 0, 30, 0, null],
  ["box#1", 1, 40, 0, 30],
  ["plate#1", 0, 50, 0, 40],
]);
const plateOnly = crossPlan(rodForked, [deepLinks[0]!, { tree: boxForked, id: 2, op: takeRod(1) }], 1, wider, []);
eq("nested, with the rod's and the box's branches still there, the edit starts at the plate, on the box's tip", "from" in plateOnly && [plateOnly.from.tool.key, plateOnly.from.joins, plateOnly.from.node, (plateOnly.from.op as Extract<ModelOp, { kind: "join" }>).tool.node, plateOnly.reused], ["plate#1", [], 1, 4, 3]);
const boxAndPlate = crossPlan(rodForked, deepLinks, 1, wider, []);
eq("with only the rod's there, it starts at the box, under the plate's join", "from" in boxAndPlate && [boxAndPlate.from.tool.key, boxAndPlate.from.joins.map((join) => join.tree.key), boxAndPlate.from.node, (boxAndPlate.from.op as Extract<ModelOp, { kind: "join" }>).tool.node, boxAndPlate.reused], ["box#1", ["plate#1"], 2, 3, 3]);
eq("the rod sits where both joins put it", toolPose({ m: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [100, 0, 0] }, deepLinks).t, [111, 12, -12]);
eq("a tool's step can be edited from the part's history", toolEditRefusal(rodTree, links, 1), null);
const stepTool = apply(newTree("bar#1", { kind: "step", name: "bar.step", bytes: new ArrayBuffer(4) }, "bar.step", fp(10)), cut, 9);
eq("not a tool's opened file", toolEditRefusal(stepTool, links, 0), "The opened file starts the history. Its steps can be edited, not the file.");
eq("nor through a join under a broken step", toolEditRefusal(rodTree, [{ tree: withNode(boxTree, 1, { broken: "gone" }), id: 2, op: takeRod(1) }], 1), "A step above this one cannot be rebuilt. Edit or delete that step first.");
eq("the header names the tool", [toolEditHead(rodTree, 1, "Rod 1"), toolEditHead(rodTree, 0, "Rod 1")], ["Editing Rod 1, step 1: Scale 150 %", "Editing Rod 1's primitive: Cylinder ⌀4 h 40"]);

if (failed) {
  console.error(`${failed} failed`);
  throw new Error(`${failed} failed`);
}
console.log("model edit: replay chain, fork, refusals, panel, edges, save, notes ok");
