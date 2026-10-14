import { dropRefusal, historyKey, historyLayout, siblingBranch, stepLabel, type HistoryRow } from "./model-history.ts";
import { dropped, jumped, newTree, opLabel, reserveId, withChild, withNode, type ModelOp, type ModelTree } from "./model-tree.ts";

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

const key = (k: string, focused: number, extra = {}) => historyKey({ key: k, ...extra }, forked, layout, focused);
eq("Up and Down move through the rows in order", [key("ArrowDown", 1), key("ArrowUp", 3)], [{ kind: "move", to: 2 }, { kind: "move", to: 2 }]);
eq("no row past the ends", [key("ArrowUp", 0), key("ArrowDown", 4)], [null, null]);
eq("Home and End", [key("Home", 3), key("End", 1)], [{ kind: "move", to: 0 }, { kind: "move", to: 4 }]);
eq("Left and Right switch branches", [key("ArrowRight", 4), key("ArrowLeft", 2)], [{ kind: "move", to: 2 }, { kind: "move", to: 3 }]);
eq("Enter and Space jump now", [key("Enter", 2), key(" ", 2)], [{ kind: "jump", to: 2 }, { kind: "jump", to: 2 }]);
eq("F2 renames, Delete drops, Shift+F10 and the menu key open the menu", [key("F2", 2), key("Delete", 2), key("F10", 2, { shiftKey: true }), key("ContextMenu", 2), key("F10", 2)], [
  { kind: "rename", id: 2 },
  { kind: "drop", id: 2 },
  { kind: "menu", id: 2 },
  { kind: "menu", id: 2 },
  null,
]);
eq("Escape leaves", key("Escape", 2), { kind: "leave" });
eq("chords stay with the app", [key("ArrowDown", 1, { ctrlKey: true }), key("z", 1, { ctrlKey: true })], [null, null]);

// Delete branch --------------------------------------------------------------------------------------------------

eq("the root stays", dropRefusal(forked, 0), "The opened file starts the history and stays.");
eq("not the branch on screen", dropRefusal(forked, 3), "The step on screen is on this branch. Go to another branch first.");
eq("not a step above the one on screen", dropRefusal(forked, 1), "The step on screen is on this branch. Go to another branch first.");
eq("not the branch the plate holds", dropRefusal({ ...forked, committed: 2 }, 2), "The plate still holds a step on this branch.");
eq("another branch can go", dropRefusal(forked, 2), null);
for (const id of [0, 1, 2, 3, 4]) {
  for (const tree of [forked, { ...forked, committed: 2 }]) {
    eq(`a refusal is exactly where dropped refuses (${id}, plate ${tree.committed})`, dropRefusal(tree, id) === null, dropped(tree, id) !== null);
  }
}

if (failed) {
  console.error(`${failed} failed`);
  throw new Error(`${failed} failed`);
}
console.log("model history: labels, rails, branches, keys and drop ok");
