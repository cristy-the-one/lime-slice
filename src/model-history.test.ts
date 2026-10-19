import { dropRefusal, foldEndingAt, foldedRedoTarget, foldedUndoTarget, historyFolds, historyKey, historyLayout, pieceLabel, presentedRows, readRow, recipeNote, rowCount, rowStep, siblingBranch, stepLabel, type HistoryRow } from "./model-history.ts";
import { dropped, jumped, newTree, opLabel, reserveId, withChild, withNode, type ModelOp, type ModelTree } from "./model-tree.ts";
import { loadedTree, savedTree, withSavedNames } from "./model-tree-file.ts";
import type { Affine } from "./model-space.ts";

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

const box = (dx: number): ModelOp => ({ kind: "boolean", op: "cut", primitive: "box", origin: [0, 0, 0], size: [dx, 10, 10], radius: 0, height: 0, turn: [0, 0, 0] });

function apply(tree: ModelTree, op: ModelOp): ModelTree {
  const [next, id] = reserveId(tree);
  return withChild(next, next.current, { id, op, label: opLabel(op), fingerprint: null });
}

// Labels ---------------------------------------------------------------------------------------------------------

eq("op labels use the panel's number format", [
  box(10),
  { kind: "hole", origin: [0, 0, 0], axis: [0, 0, -1], radius: 2.5, depth: 8 },
  { kind: "fillet", edges: [1, 2, 3], size: 1 },
  { kind: "chamfer", edges: [4], size: 0.5 },
  { kind: "split", origin: [0, 0, 42], normal: [0, 0, 1] },
  { kind: "scale", factor: 2 },
  { kind: "boolean", op: "fuse", primitive: "cylinder", origin: [0, 0, 0], size: [0, 0, 0], radius: 3, height: 12.5, turn: [0, 0, 0] },
  { kind: "boolean", op: "common", primitive: "sphere", origin: [0, 0, 0], size: [0, 0, 0], radius: 4, height: 0, turn: [0, 0, 0] },
].map((op) => opLabel(op as ModelOp)), [
  "Cut box 10×10×10",
  "Hole ⌀5 depth 8",
  "Fillet 3 edges r 1",
  "Chamfer 1 edge 0.5",
  "Split at Z 42",
  "Scale 200 %",
  "Fuse cylinder ⌀6 h 12.5",
  "Intersect sphere ⌀8",
]);
eq("a name replaces the op label", stepLabel({ label: "Cut box 10×10×10", name: "Slot" }), "Slot");
eq("a blank name does not", stepLabel({ label: "Cut box 10×10×10", name: "  " }), "Cut box 10×10×10");

// Layout ---------------------------------------------------------------------------------------------------------

const rail = (row: HistoryRow) => ({ id: row.id, lane: row.lane, up: row.up?.hot ?? null, down: row.down?.hot ?? null, forks: row.forks.map((f) => f.lane), through: row.through.map((t) => t.lane), level: row.level, state: row.state });

const root = newTree("part#1", { kind: "step", name: "bracket.step", bytes: new ArrayBuffer(1) }, "bracket.step", null);
const line = apply(apply(apply(root, box(8)), box(6)), box(4));
eq("a straight history is one rail, oldest first, root named for the file", historyLayout(line).rows.map((row) => [row.id, row.lane, row.label, row.state]), [
  [0, 0, "bracket.step", "past"],
  [1, 0, "Cut box 8×10×10", "past"],
  [2, 0, "Cut box 6×10×10", "past"],
  [3, 0, "Cut box 4×10×10", "current"],
]);
eq("one column", historyLayout(line).lanes, 1);
eq("steps after the shown one on the followed branch are redo", historyLayout(jumped(line, 1)).rows.map((row) => row.state), ["past", "current", "redo", "redo"]);

// 0 → 1 → 2, then back to 1 and a new branch 1 → 3 → 4. The shown branch keeps the main rail.
const forked = apply(apply(jumped(apply(apply(root, box(8)), box(6)), 1), box(4)), box(3));
const layout = historyLayout(forked);
eq("a fork lists the side branch right under it in its own column, the followed branch stays on the rail", layout.rows.map(rail), [
  { id: 0, lane: 0, up: null, down: true, forks: [], through: [], level: 1, state: "past" },
  { id: 1, lane: 0, up: true, down: true, forks: [1], through: [], level: 1, state: "past" },
  { id: 2, lane: 1, up: false, down: null, forks: [], through: [0], level: 2, state: "other" },
  { id: 3, lane: 0, up: true, down: true, forks: [], through: [], level: 1, state: "past" },
  { id: 4, lane: 0, up: true, down: null, forks: [], through: [], level: 1, state: "current" },
]);
eq("two columns", layout.lanes, 2);
eq("the fork is marked", layout.rows.map((row) => row.fork), [false, true, false, false, false]);

const other = historyLayout(jumped(forked, 2));
eq("jumping into the other branch moves it onto the rail", other.rows.map((row) => [row.id, row.lane, row.state]), [
  [0, 0, "past"],
  [1, 0, "past"],
  [3, 1, "other"],
  [4, 1, "other"],
  [2, 0, "current"],
]);
eq("the side branch's line passes the rail's rows", other.rows.map((row) => row.through.map((t) => t.lane)), [[], [], [0], [0], []]);

const kept = historyLayout(jumped(forked, 2), layout.main);
eq("with the earlier shape kept, the rows stay put and only the marks move", kept.rows.map((row) => [row.id, row.lane, row.state, row.up?.hot ?? null]), [
  [0, 0, "past", null],
  [1, 0, "past", true],
  [2, 1, "current", true],
  [3, 0, "other", false],
  [4, 0, "other", false],
]);
eq("a step applied since gets its own place", historyLayout(apply(jumped(forked, 2), box(2)), layout.main).rows.map((row) => [row.id, row.lane]), [[0, 0], [1, 0], [2, 1], [5, 1], [3, 0], [4, 0]]);

// Two side branches and a fork inside a side branch: no two lines share a column.
const wide = apply(jumped(apply(jumped(forked, 1), box(2)), 2), box(1));
const wideRows = historyLayout(jumped(wide, 4)).rows;
const lanesTaken = wideRows.map((row) => [row.lane, ...row.through.map((t) => t.lane)]);
check("a row never draws two lines in one column", lanesTaken.every((taken) => new Set(taken).size === taken.length), JSON.stringify(lanesTaken));
eq("three branches from one step take three columns", wideRows.find((row) => row.id === 1)?.forks.map((f) => f.lane), [1, 2]);

// Marks ----------------------------------------------------------------------------------------------------------

const held = { ...jumped(forked, 2), committed: 4 };
eq("the plate's step is marked while the view shows another", historyLayout(held).rows.filter((row) => row.plate).map((row) => row.id), [4]);
eq("and not when they are the same", historyLayout({ ...forked, committed: 4 }).rows.filter((row) => row.plate).length, 0);
const named = historyLayout(withNode(forked, 3, { name: "Slot" })).rows.find((row) => row.id === 3)!;
eq("a named step shows its name and keeps the op for the tip", [named.label, named.opLabel], ["Slot", "Cut box 4×10×10"]);
const broken = historyLayout(withNode(forked, 3, { broken: "rebuilt differently" })).rows;
eq("a broken step carries its message, and the steps under it are blocked", broken.map((row) => [row.id, row.broken, row.blocked]), [
  [0, null, false],
  [1, null, false],
  [2, null, false],
  [3, "rebuilt differently", false],
  [4, null, true],
]);

// Branch switching -----------------------------------------------------------------------------------------------

eq("Right at a branch's first step goes to the side branch", siblingBranch(forked, layout, 3, 1), 2);
eq("Left comes back", siblingBranch(forked, layout, 2, -1), 3);
eq("deeper in a branch, Right lands at the same depth, or the shorter branch's last step", siblingBranch(forked, layout, 4, 1), 2);
eq("no branch further right", siblingBranch(forked, layout, 2, 1), null);
eq("no fork above", siblingBranch(line, historyLayout(line), 3, 1), null);
const deep = apply(jumped(forked, 2), box(5));
eq("from the shorter branch, now on the rail, Right reaches the same depth on the other one", siblingBranch(deep, historyLayout(deep), 5, 1), 4);

// Keys -----------------------------------------------------------------------------------------------------------

const key = (k: string, focused: number, extra = {}) => historyKey({ key: k, ...extra }, forked, layout, String(focused));
eq("Up and Down move through the rows in order", [key("ArrowDown", 1), key("ArrowUp", 3)], [{ kind: "move", to: "2" }, { kind: "move", to: "2" }]);
eq("no row past the ends", [key("ArrowUp", 0), key("ArrowDown", 4)], [null, null]);
eq("Home and End", [key("Home", 3), key("End", 1)], [{ kind: "move", to: "0" }, { kind: "move", to: "4" }]);
eq("Left and Right switch branches", [key("ArrowRight", 4), key("ArrowLeft", 2)], [{ kind: "move", to: "2" }, { kind: "move", to: "3" }]);
eq("Enter and Space jump now", [key("Enter", 2), key(" ", 2)], [{ kind: "jump", to: "2" }, { kind: "jump", to: "2" }]);
eq("F2 renames, Delete drops, Shift+F10 and the menu key open the menu", [key("F2", 2), key("Delete", 2), key("F10", 2, { shiftKey: true }), key("ContextMenu", 2), key("F10", 2)], [
  { kind: "rename", id: "2" },
  { kind: "drop", id: "2" },
  { kind: "menu", id: "2" },
  { kind: "menu", id: "2" },
  null,
]);
eq("Escape leaves", key("Escape", 2), { kind: "leave" });
eq("chords stay with the app", [key("ArrowDown", 1, { ctrlKey: true }), key("z", 1, { ctrlKey: true })], [null, null]);

// Merges ---------------------------------------------------------------------------------------------------------

const IDENTITY: Affine = { m: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] };
const joinOf = (key: string, node: number, name: string): ModelOp => ({ kind: "join", op: "cut", tool: { object: key.split("#")[0]!, key, node, name }, relative: IDENTITY, keepTool: false });
const cylinder = { primitive: "cylinder" as const, origin: [0, 0, 0] as [number, number, number], size: [0, 0, 0] as [number, number, number], radius: 2, height: 40, turn: [0, 0, 0] as [number, number, number] };
// A rod: its primitive, a scale (the step the joins take), then a hole made after that.
const rod = apply(apply(newTree("rod#1", { kind: "primitive", solid: cylinder }, "Cylinder ⌀4 h 40", null), { kind: "scale", factor: 1.5 }), { kind: "hole", origin: [0, 0, 0], axis: [0, 0, -1], radius: 1, depth: 2 });
const bored = apply(apply(apply(root, box(8)), joinOf("rod#1", 1, "Rod 1")), box(4));
const withRod = new Map([[rod.key, rod], [bored.key, bored]]);
const merged = historyLayout(bored, undefined, withRod);
const mergeRail = (row: HistoryRow) => ({ key: row.key, lane: row.lane, up: row.up?.hot ?? null, down: row.down?.hot ?? null, merges: row.merges.map((m) => [m.lane, m.hot]), through: row.through.map((t) => [t.lane, t.hot]), level: row.level, state: row.state });
eq("a join's tool comes in on a lane of its own, root to the step the join takes, and merges at the join", merged.rows.map(mergeRail), [
  { key: "0", lane: 0, up: null, down: true, merges: [], through: [], level: 1, state: "past" },
  { key: "1", lane: 0, up: true, down: true, merges: [], through: [], level: 1, state: "past" },
  { key: "2/0", lane: 1, up: null, down: true, merges: [], through: [[0, true]], level: 2, state: "past" },
  { key: "2/1", lane: 1, up: true, down: true, merges: [], through: [[0, true]], level: 2, state: "past" },
  { key: "2", lane: 0, up: true, down: true, merges: [[1, true]], through: [], level: 1, state: "past" },
  { key: "3", lane: 0, up: true, down: null, merges: [], through: [], level: 1, state: "current" },
]);
eq("two columns for the merge", merged.lanes, 2);
eq("the lane's rows are the tool's steps, in the tool's tree, named by it at its start", merged.rows.filter((row) => row.via.length > 0).map((row) => [row.id, row.tree, row.label, row.tool, row.toolStart]), [
  [0, "rod#1", "Cylinder ⌀4 h 40", "Rod 1", true],
  [1, "rod#1", "Scale 150 %", "Rod 1", false],
]);
eq("the join owns its lane's rows", merged.rows.find((row) => row.key === "2")!.owns, ["2/0", "2/1"]);
const peek = historyLayout(bored, undefined, withRod, "2/0");
eq("a tool's step on screen is current, its own history past, and the rest other", peek.rows.map((row) => [row.key, row.state, row.down?.hot ?? null]), [
  ["0", "other", false],
  ["1", "other", false],
  ["2/0", "current", false],
  ["2/1", "other", false],
  ["2", "other", false],
  ["3", "other", null],
]);
eq("with a tool's step on screen, the plate's step is marked", peek.rows.filter((row) => row.plate).map((row) => row.key), ["0"]);
eq("a join off the shown history draws its lane cold", historyLayout(jumped(bored, 1), undefined, withRod).rows.map((row) => [row.key, row.state]), [
  ["0", "past"],
  ["1", "current"],
  ["2/0", "other"],
  ["2/1", "other"],
  ["2", "redo"],
  ["3", "redo"],
]);
eq("a tool tree that is not here draws no lane", historyLayout(bored).rows.map((row) => row.key), ["0", "1", "2", "3"]);
const brokenRod = withNode(rod, 0, { broken: "rebuilt differently" });
eq("a tool's broken step shows, and the steps after it are blocked", historyLayout(bored, undefined, new Map([[rod.key, brokenRod]])).rows.filter((row) => row.via.length > 0).map((row) => [row.key, row.broken, row.blocked]), [
  ["2/0", "rebuilt differently", false],
  ["2/1", null, true],
]);

// A bar that takes the rod's step 1 at its step 1; a plate that takes the bar's step 1. The lanes nest.
const bar = apply(newTree("bar#1", { kind: "step", name: "bar.step", bytes: new ArrayBuffer(1) }, "bar.step", null), joinOf("rod#1", 1, "Rod 1"));
const plate = apply(newTree("plate#1", { kind: "step", name: "plate.step", bytes: new ArrayBuffer(1) }, "plate.step", null), joinOf("bar#1", 1, "Bar"));
const nest = new Map([[rod.key, rod], [bar.key, bar], [plate.key, plate]]);
const nested = historyLayout(plate, undefined, nest);
eq("a tool with a join of its own nests a lane in its lane", nested.rows.map((row) => [row.key, row.lane, row.level, row.merges.map((m) => m.lane), row.through.map((t) => t.lane)]), [
  ["0", 0, 1, [], []],
  ["1/0", 1, 2, [], [0]],
  ["1/1/0", 2, 3, [], [0, 1]],
  ["1/1/1", 2, 3, [], [0, 1]],
  ["1/1", 1, 2, [2], [0]],
  ["1", 0, 1, [1], []],
]);
eq("three columns", nested.lanes, 3);
eq("every row of both lanes is the shown step's history", nested.rows.map((row) => row.state), ["past", "past", "past", "past", "past", "current"]);
eq("each join owns its own lane", nested.rows.map((row) => row.owns), [[], [], [], [], ["1/1/0", "1/1/1"], ["1/0", "1/1"]]);
const twoJoins = apply(jumped(bored, 1), joinOf("rod#1", 2, "Rod 1"));
eq("the header counts every row drawn: the part's steps on every branch, and each lane's, nested ones too", [
  [rowCount(line), historyLayout(line).rows.length],
  [rowCount(bored, withRod), merged.rows.length],
  [rowCount(bored), historyLayout(bored).rows.length],
  [rowCount(plate, nest), nested.rows.length],
  [rowCount(twoJoins, withRod), historyLayout(twoJoins, undefined, withRod).rows.length],
], [[4, 4], [6, 6], [4, 4], [6, 6], [10, 10]]);
// The rod's step 3 joins the part back: the part's lane of the rod stops there, as the cycle guard has it.
const loopRod = apply(rod, joinOf(root.key, 1, "Part"));
const loopPart = apply(apply(root, box(8)), joinOf("rod#1", 3, "Rod 1"));
const loop = new Map([[loopRod.key, loopRod], [loopPart.key, loopPart]]);
const orphan = { ...line, nodes: new Map([...line.nodes, [99, { ...line.nodes.get(3)!, id: 99, parent: 50 }]]) };
eq("a lane that would loop back, and a node not under the root, are counted as drawn", [
  [rowCount(loopPart, loop), historyLayout(loopPart, undefined, loop).rows.length],
  [rowCount(orphan), historyLayout(orphan).rows.length],
], [[7, 7], [4, 4]]);
const deepStep = rowStep(nest, plate, "1/1/1");
eq("a row's key finds its step through the joins", deepStep && [deepStep.tree.key, deepStep.id, deepStep.joins.map((join) => [join.tree.key, join.id])], ["rod#1", 1, [["plate#1", 1], ["bar#1", 1]]]);
eq("a key through a step that is no join finds nothing", rowStep(nest, plate, "0/1"), null);
eq("keys read back", [readRow("1/1/0"), readRow("4"), readRow("x")], [{ via: [1, 1], id: 0 }, { via: [], id: 4 }, null]);

const mkey = (k: string, focused: string) => historyKey({ key: k }, bored, merged, focused);
eq("Down walks into the lane, Right from the join reaches its tool's step, Left comes back", [mkey("ArrowDown", "1"), mkey("ArrowRight", "2"), mkey("ArrowLeft", "2/0"), mkey("ArrowLeft", "2/1")], [
  { kind: "move", to: "2/0" },
  { kind: "move", to: "2/1" },
  { kind: "move", to: "2" },
  { kind: "move", to: "2" },
]);
eq("in a nested lane, Left goes to the join it merges at", historyKey({ key: "ArrowLeft" }, plate, nested, "1/1/0"), { kind: "move", to: "1/1" });

// Delete branch --------------------------------------------------------------------------------------------------

eq("the root stays", dropRefusal(forked, 0), "The opened file starts the history and stays.");
eq("a new solid's root stays too", dropRefusal({ ...forked, root: { kind: "primitive", solid: { primitive: "box", origin: [0, 0, 0], size: [1, 1, 1], radius: 0, height: 0, turn: [0, 0, 0] } } }, 0), "The primitive this solid started as begins the history and stays.");
const sketchRoot = { kind: "extrude" as const, op: "fuse" as const, origin: [0, 0, 0] as [number, number, number], turn: [0, 0, 0] as [number, number, number], profile: [[0, 0], [1, 0], [0, 1]] as [number, number][], depth: 1 };
eq("a sketch-started root stays", dropRefusal({ ...forked, root: { kind: "feature", op: sketchRoot } }, 0), "The sketch this solid started as begins the history and stays.");
eq("not the branch on screen", dropRefusal(forked, 3), "The step on screen is on this branch. Go to another branch first.");
eq("not a step above the one on screen", dropRefusal(forked, 1), "The step on screen is on this branch. Go to another branch first.");
eq("not the branch the plate holds", dropRefusal({ ...forked, committed: 2 }, 2), "The plate still holds a step on this branch.");
eq("another branch can go", dropRefusal(forked, 2), null);
const plateHeld = withNode(forked, 2, { mesh: { name: "plate.stl", bytes: new ArrayBuffer(1), sourcePos: new Float32Array(0), token: "m2" } });
eq("not a branch the plate held", dropRefusal(plateHeld, 2), "The plate held a step on this branch, and Prepare undo can bring it back.");
const splitOff = withNode(forked, 2, { piece: "part-piece#1" });
eq("not a split whose piece has its own tree", dropRefusal(splitOff, 2), "A split on this branch made a part of its own.");
const user = withChild(newTree("other#1", { kind: "step", name: "o.step", bytes: new ArrayBuffer(1) }, "other", null), 0, {
  id: 1,
  op: { kind: "join", op: "cut", tool: { object: "part", key: forked.key, node: 2, name: "part" }, relative: { m: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] }, keepTool: false },
  label: "Cut part",
  fingerprint: null,
});
const trees = new Map([[forked.key, forked], [user.key, user]]);
eq("not a branch with a step another part's join takes as its tool", dropRefusal(forked, 2, trees), "“Cut part” in another part's history uses a step on this branch as its tool.");
const below = { ...withChild(forked, 2, { id: 9, op: { kind: "scale", factor: 2 }, label: "Scale 200 %", fingerprint: null }), current: forked.current };
eq("a branch below that step can go", dropRefusal(below, 9, new Map([[below.key, below], [user.key, user]])), null);
for (const id of [0, 1, 2, 3, 4]) {
  for (const tree of [forked, { ...forked, committed: 2 }, plateHeld, splitOff]) {
    eq(`a refusal is exactly where dropped refuses (${id}, plate ${tree.committed})`, dropRefusal(tree, id) === null, dropped(tree, id) !== null);
  }
}

// Folded composites --------------------------------------------------------------------------------------------

eq("a piece name is prefix, index and count", pieceLabel("rim leaves 3/12"), { prefix: "rim leaves", k: 3, n: 12 });
eq("one step is not a run", pieceLabel("texture 1/1"), null);
eq("an ordinary step is not a run", pieceLabel("Cut box 8×10×10"), null);

function called(tree: ModelTree, name: string): ModelTree {
  return withNode(tree, tree.current, { name });
}

/** `n` steps named "texture 1/n" … "texture n/n" after the root. */
function texture(n: number): ModelTree {
  let tree = root;
  for (let k = 1; k <= n; k += 1) tree = called(apply(tree, box(1)), `texture ${k}/${n}`);
  return tree;
}

const forty = texture(40);
const fortyRows = historyLayout(forty).rows;
const fortyFolded = presentedRows(fortyRows, new Set());
eq("texture 1/40 … 40/40 folds into one row", fortyFolded.map((row) => row.label), ["bracket.step", "texture · 40 steps"]);
eq("the folded row stands for the whole run", fortyFolded[1]?.fold && [fortyFolded[1].fold.expanded, fortyFolded[1].fold.keys.length, fortyFolded[1].state], [false, 40, "current"]);
eq("undo from the last step lands before the first", foldedUndoTarget(forty), 0);
eq("redo from before the run lands on its last step", foldedRedoTarget(jumped(forty, 0)), 40);
eq("undo from a step inside the run moves one step", foldedUndoTarget(jumped(forty, 10)), 9);
const opened = presentedRows(fortyRows, new Set([fortyFolded[1]!.fold!.id]));
eq("expanding the run shows every step", opened.map((row) => row.label), ["bracket.step", ...Array.from({ length: 40 }, (_, i) => `texture ${i + 1}/40`)]);
eq("the open run's first step can fold it", opened[1]?.fold && [opened[1].fold.head, opened[1].fold.expanded], [true, true]);

const gapped = withNode(forty, 5, { name: "gap" });
eq("a broken run stays as separate rows", historyFolds(historyLayout(gapped).rows).length, 0);
eq("and undo from its end moves one step", foldedUndoTarget(gapped), 39);

let paired = texture(2);
paired = called(apply(paired, box(1)), "rim leaves 1/2");
paired = called(apply(paired, box(1)), "rim leaves 2/2");
eq("two runs fold into two rows", presentedRows(historyLayout(paired).rows, new Set()).map((row) => row.label), ["bracket.step", "texture · 2 steps", "rim leaves · 2 steps"]);
eq("undo of the second run stops at the first run", foldedUndoTarget(paired), 2);

let branched = texture(3);
branched = apply(jumped(branched, 2), box(2));
branched = jumped(branched, 3);
eq("a side branch between the steps keeps them unfolded", foldEndingAt(branched, 3), null);
eq("and the rows stay separate", historyFolds(historyLayout(branched).rows).map((fold) => fold.label), []);

const foldKey = (focused: string, key: string) => historyKey({ key }, forty, { ...historyLayout(forty), rows: fortyFolded }, focused);
eq("Right expands a folded row and Enter shows its last step", [foldKey(fortyFolded[1]!.key, "ArrowRight"), foldKey(fortyFolded[1]!.key, "Enter")], [
  { kind: "expand", id: fortyFolded[1]!.fold!.id },
  { kind: "jump", to: fortyFolded[1]!.fold!.lastKey },
]);
eq("Left on the open run's first step folds it", historyKey({ key: "ArrowLeft" }, forty, { ...historyLayout(forty), rows: opened }, opened[1]!.key), { kind: "collapse", id: opened[1]!.fold!.id });
eq("a folded row does not rename or delete", [foldKey(fortyFolded[1]!.key, "F2"), foldKey(fortyFolded[1]!.key, "Delete")], [null, null]);

// The name survives the file, including a label the MCP wrote without a separate name.
let carried = withNode(apply(root, box(8)), 1, { label: "rim leaves 1/2" });
carried = called(apply(carried, box(6)), "rim leaves 2/2");
const saved = savedTree(carried, carried.committed, () => undefined);
const groupOp: ModelOp = { kind: "group", label: "Pocket 10 × 10", source: { kind: "pocket" }, steps: [box(2), box(3)] };
let beside = apply(root, groupOp);
beside = called(apply(beside, box(1)), "rim leaves 1/2");
beside = called(apply(beside, box(1)), "rim leaves 2/2");
eq("a group stays one row beside a folded run", presentedRows(historyLayout(beside).rows, new Set()).map((row) => row.label), ["bracket.step", "Pocket 10 × 10", "rim leaves · 2 steps"]);
eq("undo of the group is one step", foldedUndoTarget(jumped(beside, 1)), 0);
eq("undo of the run still skips the run", foldedUndoTarget(beside), 1);

eq("a composite's labels are kept as step names", saved.nodes.filter((node) => node.id > 0).map((node) => node.name), ["rim leaves 1/2", "rim leaves 2/2"]);
const loaded = loadedTree(saved, "part#2", carried.root, "bracket.step", null, () => undefined);
eq("the app shows those names", [1, 2].map((id) => stepLabel(loaded.nodes.get(id)!)), ["rim leaves 1/2", "rim leaves 2/2"]);
const restored = withSavedNames(loaded);
eq("the MCP session reads the saved name as the label", [1, 2].map((id) => restored.nodes.get(id)?.label), ["rim leaves 1/2", "rim leaves 2/2"]);

eq("an object with a recipe says so", recipeNote({ recipes: { "obj-1": { recipe: { name: "pegs", params: { count: 3, wall: "n / 2" } } } } }, "obj-1"), {
  title: "Built by a recipe",
  detail: "pegs · count = 3 · wall = n / 2",
});
eq("another object has no recipe", recipeNote({ recipes: { "obj-1": { recipe: { name: "pegs", params: {} } } } }, "obj-2"), null);
eq("a recipe with no name still counts", recipeNote({ recipes: { part: { recipe: { params: {} } } } }, "part")?.title, "Built by a recipe");

if (failed) {
  console.error(`${failed} failed`);
  throw new Error(`${failed} failed`);
}
console.log("model history: labels, rails, branches, keys, drop and folded composites ok");
