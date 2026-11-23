/**
 * Organic fix round, item 11: an edit replays steps under new ids, and every op field that can name an earlier step's
 * edges follows the new id, not only fillet and chamfer edges.
 */
import { renumberedSteps, type Curve3D, type EdgePick, type ModelOp } from "./model-tree.ts";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(name);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name}${detail ? ` ${detail}` : ""}`);
}

const ids = new Map([[3, 7]]);
const old: EdgePick = { fromNode: 3, filter: "convex" };
const other: EdgePick = { fromNode: 2 };
const byEdges: Curve3D = { kind: "edges", edges: [old, 4, other] };
/** Every fromNode an op holds, anywhere. */
const nodesIn = (value: unknown): number[] => JSON.stringify(value).match(/"fromNode":(\d+)/g)?.map((m) => Number(m.split(":")[1])) ?? [];

const sheetSpec = { method: "extrude", curves: [byEdges], dir: [0, 0, 1] } as unknown;
const ops: [string, ModelOp][] = [
  ["fillet edges", { kind: "fillet", edges: [old, other], size: 1 }],
  ["chamfer edges", { kind: "chamfer", edges: [old], size: 1 }],
  ["transition edges", { kind: "transition", edges: [old], build: [0, 0, 1] } as ModelOp],
  ["sweep spine", { kind: "sweep", op: "fuse", sections: [{ origin: [0, 0, 0], turn: [0, 0, 0], radius: 1 }], spine: byEdges } as unknown as ModelOp],
  ["sweep auxiliary spine", { kind: "sweep", op: "fuse", sections: [{ origin: [0, 0, 0], turn: [0, 0, 0], radius: 1 }], spine: { kind: "polyline", points: [[0, 0, 0], [0, 0, 5]] }, mode: { kind: "auxSpine", spine: byEdges } } as unknown as ModelOp],
  ["loft guides", { kind: "loft", op: "fuse", sections: [], guides: [byEdges] } as unknown as ModelOp],
  ["sheet curves", { kind: "sheet", ...(sheetSpec as object) } as ModelOp],
  ["trim/split sheet curves", { kind: "trimSplit", sheet: sheetSpec } as unknown as ModelOp],
  ["replace face sheet curves", { kind: "replaceFace", face: 0, sheet: sheetSpec } as unknown as ModelOp],
  ["split face curve", { kind: "splitFace", face: 0, curve: byEdges } as unknown as ModelOp],
  ["patch sides and guides", { kind: "patch", boundaries: [{ edges: [old] }, { curve: byEdges }], guides: [byEdges] }],
  ["blend sides", { kind: "blendSurface", a: { edges: [old, other] }, b: { curve: byEdges } }],
];
for (const [name, op] of ops) {
  const before = nodesIn(op);
  const after = nodesIn(renumberedSteps(op, ids));
  const expected = before.map((id) => ids.get(id) ?? id);
  check(`${name}: an earlier step's edges follow its new id`, before.includes(3) && JSON.stringify(after) === JSON.stringify(expected), `before=${before} after=${after}`);
  check(`${name}: unchanged when nothing is renamed`, renumberedSteps(op, new Map([[9, 10]])) === op);
}
// Inside a group, too.
const group: ModelOp = { kind: "group", steps: [ops[10]![1], ops[11]![1]] } as unknown as ModelOp;
check("a group's patch and blend follow", !nodesIn(renumberedSteps(group, ids)).includes(3));

if (failed) {
  console.error(`${failed} checks failed`);
  process.exit(1);
}
console.log("renumbered steps: ok");
