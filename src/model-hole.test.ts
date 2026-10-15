import { editPanel } from "./model-edit.ts";
import { probeKey } from "./model-feasibility.ts";
import { SCREWS, screwOf, throughLength } from "./model-hole.ts";
import { positionText } from "./model-history.ts";
import { IDENTITY_POSE, placeFields, poseFromPlace, toSolidOp, type Affine } from "./model-space.ts";
import { loadedTree, readSavedTree, savedTree } from "./model-tree-file.ts";
import { newTree, opLabel, reserveId, withChild, type HoleOp, type ModelOp, type ModelTree } from "./model-tree.ts";

let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) return;
  failed += 1;
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}
function eq(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  check(name, a === b, `${a} vs ${b}`);
}

const plain: HoleOp = { kind: "hole", origin: [5, 5, 10], axis: [0, 0, -1], radius: 2.5, depth: 8 };
const through: HoleOp = { ...plain, radius: 1.7, through: true };
const bored: HoleOp = { ...through, counterboreRadius: 3, counterboreDepth: 3.2 };
const boredDeep: HoleOp = { ...plain, radius: 1.7, counterboreRadius: 3, counterboreDepth: 3.2 };

eq("labels", [plain, { ...plain, through: true as const }, bored, boredDeep].map(opLabel), [
  "Hole ⌀5 depth 8",
  "Hole ⌀5 through",
  "Hole ⌀3.4 through, counterbore ⌀6 × 3.2",
  "Hole ⌀3.4 depth 8, counterbore ⌀6 × 3.2",
]);

// toSolidOp carries the new fields: they are scalars, so no pose changes them.
const moved: Affine = { m: [0, -1, 0, 1, 0, 0, 0, 0, 1], t: [10, 0, 5] };
const inSolid = toSolidOp(bored, moved) as HoleOp;
eq("a pose takes the hole's new fields along as they are", [inSolid.through, inSolid.counterboreRadius, inSolid.counterboreDepth, inSolid.depth], [true, 3, 3.2, 8]);
check("identity sends a through counterbore exactly as typed", toSolidOp(bored, IDENTITY_POSE) === bored);

// Probe keys: an old op's key is the one it always had; the new fields make new keys.
eq(
  "an old hole's probe key is unchanged",
  probeKey("part#a.1#2", plain),
  'part#a.1#2|{"kind":"hole","origin":[5,5,10],"axis":[0,0,-1],"radius":2.5,"depth":8}',
);
const keys = [plain, { ...plain, through: true as const }, { ...plain, counterboreRadius: 4, counterboreDepth: 2 }, { ...plain, counterboreRadius: 4, counterboreDepth: 3 }].map((op) => probeKey("n", op));
eq("Through all and each counterbore number ask again", new Set(keys).size, 4);

// The `.lime` round trip: each new field comes back, and an old op comes back with none of them.
const fp = (volumeMm3: number) => ({ volumeMm3, faces: 6, edges: 12 });
function apply(tree: ModelTree, op: ModelOp, volume: number): ModelTree {
  const [next, id] = reserveId(tree);
  return withChild(next, next.current, { id, op, label: opLabel(op), fingerprint: fp(volume) });
}
const box = { primitive: "box" as const, origin: [-10, -10, 0] as [number, number, number], size: [20, 20, 10] as [number, number, number], radius: 0, height: 0, turn: [0, 0, 0] as [number, number, number] };
const start = newTree("box#1", { kind: "primitive", solid: box }, "Box 1", fp(4000));
const holed = apply(apply(apply(start, plain, 3950), through, 3900), bored, 3850);
const saved = JSON.parse(JSON.stringify({ ...savedTree(holed, holed.committed, () => undefined), rootPrimitive: box }));
eq("an old hole is saved with none of the new fields", saved.nodes[1].op, { kind: "hole", origin: [5, 5, 10], axis: [0, 0, -1], radius: 2.5, depth: 8 });
const read = readSavedTree(saved);
check("a tree with Through all and a counterbore reads back", !!read);
const reopened = loadedTree(read!, "box#2", { kind: "primitive", solid: box }, "Box 1", null, () => undefined);
eq("each hole comes back as it was saved", [1, 2, 3].map((id) => reopened.nodes.get(id)?.op), [plain, through, bored]);
eq("and labels as it did", [1, 2, 3].map((id) => reopened.nodes.get(id)?.label), ["Hole ⌀5 depth 8", "Hole ⌀3.4 through", "Hole ⌀3.4 through, counterbore ⌀6 × 3.2"]);
const damaged = (patch: Record<string, unknown>) => {
  const copy = JSON.parse(JSON.stringify(saved));
  Object.assign(copy.nodes[1].op, patch);
  return readSavedTree(copy);
};
eq("a counterbore with one number is a damaged tree", damaged({ counterboreRadius: 3 }), null);
eq("a counterbore that is not a number is a damaged tree", damaged({ counterboreRadius: "3", counterboreDepth: 2 }), null);
eq("a Through all that is not true or false is a damaged tree", damaged({ through: 1 }), null);
check("Through all saved as false reads as an old hole", JSON.stringify(loadedTree(damaged({ through: false })!, "k", { kind: "primitive", solid: box }, "Box 1", null, () => undefined).nodes.get(1)?.op) === JSON.stringify(plain));

// Edit step: the panel opens with each new field and box as the step has them.
eq("an edited through counterbore opens with its numbers and both boxes", editPanel(bored, IDENTITY_POSE, [0, 0, 5]), {
  tool: "hole",
  fields: { modelX: 5, modelY: 5, modelZ: 10, modelHoleR: 1.7, modelHoleD: 8, modelBoreR: 3, modelBoreD: 3.2 },
  axis: [0, 0, -1],
  hole: { through: true, counterbore: true },
});
eq("an old hole opens with both boxes off and no counterbore numbers", editPanel(plain, IDENTITY_POSE, [0, 0, 5]), {
  tool: "hole",
  fields: { modelX: 5, modelY: 5, modelZ: 10, modelHoleR: 2.5, modelHoleD: 8 },
  axis: [0, 0, -1],
  hole: { through: false, counterbore: false },
});

// Through all reaches the far corner of the box along the axis, and the kernel's 1 mm past it.
const part = { min: [0, 0, 0] as [number, number, number], max: [20, 20, 10] as [number, number, number] };
eq("through from the top", throughLength(part, [10, 10, 10], [0, 0, -1]), 11);
eq("through from a side face", throughLength(part, [20, 10, 5], [-1, 0, 0]), 21);
eq("a hole pointing away from the part is just the margin", throughLength(part, [10, 10, 12], [0, 0, 1]), 1);
eq("an axis that is not a unit one is made one", throughLength(part, [20, 10, 5], [-3, 0, 0]), 21);
eq("a zero axis drills straight down, as in the kernel", throughLength(part, [10, 10, 10], [0, 0, 0]), 11);

// Screws: through, counterbored, each size as the screw has it.
const m3 = SCREWS.find((screw) => screw.name === "M3")!;
eq("M3 is a ⌀3.4 clearance hole with a ⌀6.5 × 3.4 counterbore", [m3.hole, m3.bore, m3.boreDepth], [3.4, 6.5, 3.4]);
eq("the panel's numbers are M3", screwOf({ radius: 1.7, through: true, counterbore: true, boreRadius: 3.25, boreDepth: 3.4 })?.name, "M3");
eq("not through, not a screw", screwOf({ radius: 1.7, through: false, counterbore: true, boreRadius: 3.25, boreDepth: 3.4 }), null);
eq("another depth, not a screw", screwOf({ radius: 1.7, through: true, counterbore: true, boreRadius: 3.25, boreDepth: 3 }), null);
check("every counterbore is wider than its hole and shallower than it is wide", SCREWS.every((screw) => screw.bore > screw.hole && screw.boreDepth < screw.bore));

// The Position row: identity, a move, a turn, as Place's fields read them.
const pivot: [number, number, number] = [10, 10, 5];
eq("identity is at the file position", positionText(placeFields(IDENTITY_POSE, pivot)), "At file position");
const shifted = poseFromPlace(poseFromPlace(IDENTITY_POSE, pivot, "x", 12.5), pivot, "z", -3);
eq("a move shows only the axes it moved", positionText(placeFields(shifted, pivot)), "X 12.5 · Z -3");
const turned = poseFromPlace(IDENTITY_POSE, pivot, "rz", 30);
eq("a turn about the centre shows only the turn", positionText(placeFields(turned, pivot)), "Turn Z 30°");
eq("both", positionText(placeFields(poseFromPlace(turned, pivot, "y", 4), pivot)), "Y 4 · Turn Z 30°");
eq("a hair off is still at the file position", positionText({ x: 0.001, y: -0.004, z: 0, rx: 0.002, ry: 0, rz: 0 }), "At file position");

if (failed > 0) {
  throw new Error(`model-hole: ${failed} failed`);
}
console.log("model-hole: ok");
