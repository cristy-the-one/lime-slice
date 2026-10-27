/**
 * Split to print in the history (docs/plan-split-connectors.md, milestone 3): the row, the `pieces` keys, the reader and
 * writer of `.lime`, the requests, and the slice request of a plate that holds the pieces.
 */
import { loadedTree, readSavedTree, savedTree } from "./model-tree-file.ts";
import { dropRefusal } from "./model-history.ts";
import { applyRequest, crossEditRequest } from "./model-request.ts";
import { toSolidOp, type Affine } from "./model-space.ts";
import { dropped, jumped, makesParts, newTree, opLabel, partsOf, reachableTrees, withChild, type ModelOp, type ModelTree, type PartitionModelOp } from "./model-tree.ts";
import { slicePlateFields, type PlateObject } from "./plate.ts";
import { notBuiltYet, NUMBER_STROKE_FRACTION, partitionNumbers, PROFILE_LATER, SHAPED_JOINTS_LATER } from "./modeling/partition.ts";
import { textStrokes, type StrokeBox } from "./modeling/text.ts";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) return;
  failed += 1;
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}
const eq = (name: string, actual: unknown, expected: unknown) => check(name, JSON.stringify(actual) === JSON.stringify(expected), `${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);

const fp = (volumeMm3: number) => ({ volumeMm3, faces: 6, edges: 12 });
const cut = (x: number) => ({ origin: [x, 10, 10] as [number, number, number], normal: [1, 0, 0] as [number, number, number], u: [0, 1, 0] as [number, number, number], profile: { kind: "straight" as const }, connectors: { on: false } });
const partition: PartitionModelOp = {
  kind: "partition",
  cuts: [cut(100), cut(200)],
  target: { printer: "lime-220", process: "fdm", volumeMm: [220, 220, 250] },
  orient: "keep",
  arrange: true,
  bedMarginMm: 5,
  maxPieces: 12,
};

// The row (plan section 11): the parts it made, from the node's `pieces`.
eq("a split to print in three is labelled with its parts", opLabel(partition, 3), "Split to print, 3 parts");
eq("and in two", opLabel(partition, 2), "Split to print, 2 parts");
eq("an op alone does not know its parts", opLabel(partition), "Split to print");
eq("parts count the first piece and every key", partsOf({ op: partition, pieces: ["a", null] }), 3);
eq("a split has no parts count", partsOf({ op: { kind: "split", origin: [0, 0, 0], normal: [0, 0, 1] }, pieces: undefined }), undefined);

// A tree with a split to print whose pieces are trees of their own, and one more step on the part.
const hole: ModelOp = { kind: "hole", origin: [50, 10, 20], axis: [0, 0, -1], radius: 2, depth: 5 };
let part: ModelTree = newTree("bar#1", { kind: "primitive", solid: { primitive: "box", origin: [0, 0, 0], size: [300, 20, 20], radius: 0, height: 0, turn: [0, 0, 0] } }, "Box", fp(120_000));
part = withChild(part, 0, { id: 1, op: partition, label: opLabel(partition, 3), fingerprint: fp(40_000), pieces: ["bar-part#2", "bar-part#3"] });
part = { ...withChild(part, 1, { id: 2, op: hole, label: opLabel(hole), fingerprint: fp(39_900) }), committed: 2 };
const pieceTree = (key: string, index: number) => newTree(key, { kind: "piece", tree: part.key, node: 1, index }, `Part ${index}`, fp(40_000));
const trees = new Map<string, ModelTree>([[part.key, part], ["bar-part#2", pieceTree("bar-part#2", 2)], ["bar-part#3", pieceTree("bar-part#3", 3)]]);

check("the node makes parts", makesParts(part.nodes.get(1)));
eq("the part keeps the trees its pieces root", [...reachableTrees(trees, [{ id: "bar", key: part.key }])].sort(), ["bar#1", "bar-part#2", "bar-part#3"]);
eq("a piece keeps the part it was cut from, and so the other pieces", [...reachableTrees(trees, [{ id: "p3", key: "bar-part#3" }])].sort(), ["bar#1", "bar-part#2", "bar-part#3"]);
const above = jumped(part, 0);
eq("its branch is not dropped while its pieces are parts", dropped({ ...above, committed: 0 }, 1), null);
eq("and the History says why", dropRefusal({ ...above, committed: 0 }, 1), "A split to print on this branch made parts of their own.");

// `.lime`: pieces by plate object id, null for one not saved; back to keys on open, with the row's label.
const owners = new Map([["bar-part#2", "obj_2"]]);
const saved = savedTree(part, 2, (key) => owners.get(key));
const node = saved.nodes.find((row) => row.id === 1)!;
eq("the file names each piece's object, and null for one not saved", node.pieces, ["obj_2", null]);
check("the label is not kept as a name", node.name === undefined, JSON.stringify(node));
eq("the op is kept as stored", node.op, partition);
const file = { ...saved, rootPrimitive: { primitive: "box", origin: [0, 0, 0], size: [300, 20, 20], radius: 0, height: 0, turn: [0, 0, 0] } };
const read = readSavedTree(JSON.parse(JSON.stringify(file)));
check("the saved tree reads back", read !== null);
eq("with the op and the pieces as written", read?.nodes.find((row) => row.id === 1), node);
const keys = new Map([["obj_2", "bar-part#9"]]);
const loaded = loadedTree(read!, "bar#9", { kind: "primitive", solid: file.rootPrimitive as never }, "Box", null, (id) => keys.get(id));
eq("on open each piece is its tree's key again", loaded.nodes.get(1)?.pieces, ["bar-part#9", null]);
eq("and the row counts every part", loaded.nodes.get(1)?.label, "Split to print, 3 parts");

// `piece` is a split's and `pieces` a split to print's: either on the other kind is a damaged tree, both ways.
const tree = (nodes: unknown[]) => ({ nodes, current: 1, committed: 1, nextId: 2, rootPrimitive: file.rootPrimitive });
const root = { id: 0, parent: null, op: null, fingerprint: null };
const split = { kind: "split", origin: [0, 0, 5], normal: [0, 0, 1] };
check("a split with its piece reads", readSavedTree(tree([root, { id: 1, parent: 0, op: split, fingerprint: null, piece: "obj_2" }])) !== null);
eq("a split with pieces is damaged", readSavedTree(tree([root, { id: 1, parent: 0, op: split, fingerprint: null, pieces: ["obj_2"] }])), null);
eq("a split to print with a piece is damaged", readSavedTree(tree([root, { id: 1, parent: 0, op: partition, fingerprint: null, piece: "obj_2" }])), null);
eq("a hole with pieces is damaged", readSavedTree(tree([root, { id: 1, parent: 0, op: hole, fingerprint: null, pieces: ["obj_2"] }])), null);
check("a split to print without pieces reads", readSavedTree(tree([root, { id: 1, parent: 0, op: partition, fingerprint: null }])) !== null);
for (const [why, pieces] of [["empty", []], ["blank", [""]], ["a number", [3]], ["more than 23", Array.from({ length: 24 }, () => null)]] as const) {
  eq(`pieces that are ${why} are damaged`, readSavedTree(tree([root, { id: 1, parent: 0, op: partition, fingerprint: null, pieces }])), null);
}
for (const [why, op] of [
  ["no cuts", { ...partition, cuts: [] }],
  ["a cut with no normal", { ...partition, cuts: [{ origin: [1, 2, 3] }] }],
  ["a target with an unknown process", { ...partition, target: { printer: "x", process: "sla", volumeMm: [1, 1, 1] } }],
  ["an orientation that is not keep or joint", { ...partition, orient: "flat" }],
  ["a Max pieces that is not a number", { ...partition, maxPieces: "12" }],
] as const) {
  eq(`a split to print with ${why} is damaged`, readSavedTree(tree([root, { id: 1, parent: 0, op, fingerprint: null }])), null);
}
const later = {
  kind: "partition",
  cuts: [{ ...cut(100), profile: { kind: "lap", depth: 8 }, connectors: { on: true, types: [{ type: "dowel" }] } }],
  target: { printer: "formlabs-form-4", process: "resin", volumeMm: [200, 125, 210] },
  orient: ["keep", "joint"],
  arrange: false,
  labels: { on: true },
  bedMarginMm: 10,
  maxPieces: 12,
};
eq("fields a later milestone builds are kept as stored", readSavedTree(tree([root, { id: 1, parent: 0, op: later, fingerprint: null }]))?.nodes[1]?.op, later);

// A v4 file from before this op opens unchanged: the reader adds nothing to it.
const v4 = {
  nodes: [
    { id: 0, parent: null, op: null, fingerprint: { volumeMm3: 1000, faces: 6, edges: 12 } },
    { id: 1, parent: 0, op: { kind: "split", origin: [0, 0, 4], normal: [0, 0, 1] }, fingerprint: { volumeMm3: 400, faces: 6, edges: 12 }, piece: "obj_2" },
    { id: 2, parent: 1, op: { kind: "hole", origin: [5, 5, 4], axis: [0, 0, -1], radius: 1, depth: 2 }, name: "Pin", fingerprint: { volumeMm3: 394, faces: 7, edges: 15 } },
  ],
  current: 2,
  committed: 2,
  nextId: 3,
  rootStep: { name: "plate.step", bytesBase64: "SVNP", byteLength: 3, hash: "x" },
};
eq("a v4 tree without the op reads back exactly", readSavedTree(JSON.parse(JSON.stringify(v4))), v4);

// The engine's requests: pieceKeys only on a split to print, and an apply without them is the request it always was.
eq("an apply of a split to print sends its piece keys", applyRequest("bar#1", 0, 1, partition, 0.05, null, ["k2", null]), { call: "apply", key: "bar#1", parent: 0, node: 1, op: partition, chordMm: 0.05, pieceKeys: ["k2", null] });
eq("an apply without keys is unchanged", applyRequest("bar#1", 0, 1, hole, 0.05), { call: "apply", key: "bar#1", parent: 0, node: 1, op: hole, chordMm: 0.05 });
eq("an edit of a split to print sends its piece keys", crossEditRequest([{ key: "bar#1", parent: 0, node: 3, op: partition, replay: [], old: [1] }], 0.05, ["k2"]), { call: "edit", key: "bar#1", parent: 0, node: 3, op: partition, replay: [], chordMm: 0.05, pieceKeys: ["k2"] });

// Typed in model space, the cuts reach the solid's own frame as a split's plane does, U turned with them.
const moved: Affine = { m: [0, -1, 0, 1, 0, 0, 0, 0, 1], t: [10, 0, 0] };
const own = toSolidOp({ ...partition, cuts: [cut(15)] }, moved) as PartitionModelOp;
const near = (a: readonly number[] | undefined, b: readonly number[]) => !!a && a.every((v, i) => Math.abs(v - b[i]!) < 1e-9);
check("the cut's origin goes into the solid's frame", near(own.cuts[0]!.origin, [10, -5, 10]), JSON.stringify(own.cuts[0]));
check("its normal and U turn with it", near(own.cuts[0]!.normal, [0, -1, 0]) && near(own.cuts[0]!.u, [1, 0, 0]), JSON.stringify(own.cuts[0]));

// What the kernel does not build yet is refused with the kernel's own sentence.
eq("a lap is built", notBuiltYet({ cuts: [{ ...cut(1), profile: { kind: "lap" } }] }), null);
eq("a tongue is built", notBuiltYet({ cuts: [{ ...cut(1), profile: { kind: "tongue" } }] }), null);
eq("a zig-zag and a dovetail are built", [notBuiltYet({ cuts: [{ ...cut(1), profile: { kind: "zigzag" } }] }), notBuiltYet({ cuts: [{ ...cut(1), profile: { kind: "dovetail" } }] })], [null, null]);
eq("a sketch is later", notBuiltYet({ cuts: [{ ...cut(1), profile: { kind: "sketch", sketch: { v: 1 } } }] }), PROFILE_LATER);
eq("a key and a dovetail connector are built", [notBuiltYet({ cuts: [{ ...cut(1), connectors: { on: true, types: [{ type: "key" }] } }] }), notBuiltYet({ cuts: [{ ...cut(1), connectors: { on: true, types: [{ type: "dovetail" }] } }] })], [null, null]);
eq("connectors on a lap are later", notBuiltYet({ cuts: [{ ...cut(1), profile: { kind: "lap" }, connectors: { on: true } }] }), SHAPED_JOINTS_LATER);
eq("dowels are built since milestone 5", notBuiltYet({ cuts: [{ ...cut(1), connectors: { on: true } }] }), null);
eq("a key with connectors off is a plain cut", notBuiltYet({ cuts: [{ ...cut(1), connectors: { on: false, types: [{ type: "key" }] } }] }), null);
eq("a straight plain cut is built", notBuiltYet({ cuts: [cut(1), { origin: [0, 0, 0], normal: [0, 0, 1] }] }), null);
const form4 = { ...partition, target: { printer: "formlabs-form-4", process: "resin" as const, volumeMm: [200, 125, 210] as [number, number, number] }, arrange: false };
eq("a resin target is built since milestone 3b", notBuiltYet(form4), null);
eq("an export target's row names its printer", opLabel(form4, 3), "Split to print for Formlabs Form 4, 3 parts");

// --- 3b. Part numbers: the strokes go to the engine beside the op, only when labels are on in the op itself.
eq("an op stored before 3b has no labels, so no number is cut on a replay", partitionNumbers(partition), null);
eq("labels off cut no number", partitionNumbers({ ...partition, labels: { on: false } }), null);
const labelled: PartitionModelOp = { ...form4, labels: { on: true, face: "cut", height: 4, depth: 0.4 } };
const numbers = partitionNumbers(labelled)!;
const one = textStrokes("1", 4, 4 * NUMBER_STROKE_FRACTION, undefined, "centre") as StrokeBox[];
eq("one number per piece Max pieces allows", numbers.digits.length, 12);
eq("piece 1's number is the stroke font's 1, centred", numbers.digits[0], one.map((s) => [s.centre[0], s.centre[1], s.length, s.angleDeg]));
eq("piece 12 is two digits", numbers.digits[11]!.length, (textStrokes("12", 4, 4 * NUMBER_STROKE_FRACTION, undefined, "centre") as StrokeBox[]).length);
eq("strokes 0.15 of the height, the depth stored, the resin wall floor as the inset", [numbers.strokeMm, numbers.depthMm, numbers.insetMm], [4 * 0.15, 0.4, 1]);
const sentOp = applyRequest("bar#1", 0, 1, labelled, 0.05, null, ["k2"]).op as Record<string, unknown>;
eq("an apply sends the numbers with the op", sentOp.numbers, numbers);
eq("and keeps the stored op as it is", (labelled as unknown as Record<string, unknown>).numbers, undefined);
eq("an op without labels goes as it is", applyRequest("bar#1", 0, 1, partition, 0.05).op === partition, true);

// Plan section 14: the slice request of a plate that holds the pieces has no new field. Each piece is a plate object
// like any other, with its tree's key and its solid beside it, which the slice never reads.
const box = new Float32Array([0, 0, 0, 100, 0, 0, 0, 20, 20]);
const plain = (id: string, x: number): PlateObject => ({
  id,
  name: id,
  fileName: `${id}.stl`,
  bytes: new ArrayBuffer(8),
  sourcePos: box,
  orient: [1, 0, 0, 0, 1, 0, 0, 0, 1],
  partScale: 1,
  centered: false,
  offset: { x, y: 0, z: 0 },
  stepTolerance: 0.05,
  supportEdits: [],
  supportPaint: [],
  seamPaint: [],
  reinforcement: [],
  settings: {},
});
const pose = (obj: PlateObject) => ({ rotation: obj.orient, pivot: [50, 10, 10] as [number, number, number], translation: [obj.offset.x, 0, 0] as [number, number, number] });
const plainPlate = [plain("obj_1", 0), plain("obj_2", 102), plain("obj_3", 204)];
const piecePlate = plainPlate.map((obj, at) => ({ ...obj, modelTree: at === 0 ? "bar#1" : `bar-part#${at + 1}`, brep: new ArrayBuffer(4), modelPose: { m: [1, 0, 0, 0, 1, 0, 0, 0, 1] as Affine["m"], t: [0, 0, 0] as Affine["t"] } }));
const sent = JSON.stringify(slicePlateFields(piecePlate, pose, { supports: false, supportStyle: "normal" }));
const expected = JSON.stringify({
  objects: [0, 102, 204].map((x, at) => ({
    id: `obj_${at + 1}`,
    filename: `obj_${at + 1}.stl`,
    pose: { rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1], pivot: [50, 10, 10], translation: [x, 0, 0] },
    stepToleranceMm: 0.05,
  })),
});
eq("the slice request of a plate of pieces is the exact JSON of its objects", sent, expected);
eq("and the same as the plate's objects without their trees", sent, JSON.stringify(slicePlateFields(plainPlate, pose, { supports: false, supportStyle: "normal" })));

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("model partition: ok");
