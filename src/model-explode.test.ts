/**
 * --- Split to print, Explode (docs/plan-split-connectors.md, D12): each piece's shift along the cuts' normals, the cuts
 * in model space, and which split to print the view explodes.
 */
import { cutsInModel, EXPLODE_GAP_MM, explodeShifts, posedCentre, shiftedPose, shownPartition } from "./model-explode.ts";
import { newTree, withChild, type PartitionModelOp } from "./model-tree.ts";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) return;
  failed += 1;
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}
const show = (value: unknown) => JSON.stringify(value);

type V = [number, number, number];
const cut = (x: number): PartitionModelOp["cuts"][number] => ({ origin: [x, 10, 5], normal: [1, 0, 0], u: [0, 1, 0], profile: { kind: "straight" }, connectors: { on: false } });
const op: PartitionModelOp = { kind: "partition", cuts: [cut(20), cut(40)] };
const identity = { m: [1, 0, 0, 0, 1, 0, 0, 0, 1] as [number, number, number, number, number, number, number, number, number], t: [0, 0, 0] as V };

check("Explode opens at 10 mm", EXPLODE_GAP_MM === 10);
const chain = explodeShifts(cutsInModel(op, identity), [[10, 10, 5], [30, 10, 5], [50, 10, 5]], 10);
check("a chain opens one gap per cut, piece 1 still", show(chain) === show([[0, 0, 0], [10, 0, 0], [20, 0, 0]]), show(chain));
check("a gap of 0 moves nothing", show(explodeShifts(cutsInModel(op, identity), [[30, 10, 5]], 0)) === show([[0, 0, 0]]));
const grid = explodeShifts(
  [
    { origin: [0, 0, 0], normal: [1, 0, 0] },
    { origin: [0, 0, 0], normal: [0, 1, 0] },
  ],
  [[-5, -5, 0], [-5, 5, 0], [5, -5, 0], [5, 5, 0]],
  4,
);
check("meeting cuts spread a grid along both normals", show(grid) === show([[0, 0, 0], [0, 4, 0], [4, 0, 0], [4, 4, 0]]), show(grid));

// The op is stored in the solid's frame; the view spreads in model space.
const turned = { m: [0, -1, 0, 1, 0, 0, 0, 0, 1] as typeof identity.m, t: [100, 0, 0] as V };
const posed = cutsInModel(op, turned);
check("a cut's plane goes into model space with the part's pose", show(posed[0]) === show({ origin: [90, 20, 5], normal: [0, 1, 0] }), show(posed[0]));
check("a box's centre goes through a pose", show(posedCentre({ min: [0, 0, 0], max: [20, 10, 4] }, turned)) === show([95, 10, 2]), show(posedCentre({ min: [0, 0, 0], max: [20, 10, 4] }, turned)));
check("a shifted pose keeps its turn", show(shiftedPose(turned, [1, 2, 3])) === show({ m: turned.m, t: [101, 2, 3] }));

// The split to print on the way to the current step is the one shown; a later step on the part does not hide it.
const fp = { volumeMm3: 1, faces: 6, edges: 12 };
let tree = newTree("bar#1", { kind: "primitive", solid: { primitive: "box", origin: [0, 0, 0], size: [60, 20, 10], radius: 0, height: 0, turn: [0, 0, 0] } }, "bar", fp);
check("a part with no split to print has nothing to explode", shownPartition(tree) === null);
tree = withChild(tree, 0, { id: 1, op, label: "Split to print, 3 parts", fingerprint: fp, pieces: ["bar-2", "bar-3"] });
tree = withChild(tree, 1, { id: 2, op: { kind: "scale", factor: 2 }, label: "Scale", fingerprint: fp });
check("the split to print on the way is found with its pieces", show(shownPartition(tree)) === show({ op, pieces: ["bar-2", "bar-3"] }), show(shownPartition(tree)));

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("model explode: ok");
