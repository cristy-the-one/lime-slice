import { applyRequest, crossEditRequest, editRequest, exportRequest, isBrep, joinOp, newSolidRequest, openRequest, probeRequest, solidFileName, wholeTreeRequest } from "./model-request.ts";
import { newTree, withChild, type ModelOp } from "./model-tree.ts";
import type { PrimitiveSpec } from "./model-primitive.ts";

let failed = 0;
function eq(name: string, got: unknown, want: unknown) {
  const left = JSON.stringify(got);
  const right = JSON.stringify(want);
  if (left === right) return;
  failed += 1;
  console.error(`FAIL ${name}\n  got  ${left}\n  want ${right}`);
}

const typed: PrimitiveSpec = { primitive: "box", origin: [3, 3, 3], size: [20, 10, 4], radius: 5, height: 10, turn: [0, 0, 30] };
eq("New solid opens the root standing at the origin, with only the box's fields", newSolidRequest("obj-1#a.1", typed, 0.1), {
  call: "open",
  key: "obj-1#a.1",
  primitive: { primitive: "box", origin: [-10, -5, 0], size: [20, 10, 4], radius: 0, height: 0, turn: [0, 0, 0] },
  chordMm: 0.1,
});
const step = new Uint8Array([73, 83, 79]).buffer;
eq("a STEP root sends its bytes and no fingerprint", openRequest("k", { kind: "step", name: "a.step", bytes: step }, 0.2), { call: "open", key: "k", filename: "a.step", dataB64: "SVNP", chordMm: 0.2 });

const hole: ModelOp = { kind: "hole", origin: [0, 0, 4], axis: [0, 0, -1], radius: 1, depth: 2 };
const root = { kind: "primitive" as const, solid: { ...typed, origin: [-10, -5, 0] as [number, number, number] } };
const fp = (volumeMm3: number) => ({ volumeMm3, faces: 6, edges: 12 });
const grown = withChild(newTree("k", root, "Box 20×10×4", fp(800)), 0, { id: 1, op: hole, label: "Hole", fingerprint: fp(794) });
eq("a whole primitive tree sends the root's fingerprint and every op", wholeTreeRequest(grown, root, 1, 0.1), {
  call: "open",
  key: "k",
  primitive: root.solid,
  fingerprint: fp(800),
  chordMm: 0.1,
  nodes: [{ id: 1, parent: 0, op: hole, fingerprint: fp(794) }],
  current: 1,
});
const saved = new TextEncoder().encode("LIMEBREP 1 7.9.2 794 *\nbody");
eq("a whole tree can send one step's saved solid, which that step and its children build from", wholeTreeRequest(grown, root, 1, 0.1, { seed: { node: 1, bytes: saved.buffer } }).seed, { node: 1, dataB64: "TElNRUJSRVAgMSA3LjkuMiA3OTQgKgpib2R5" });
eq("without one, a whole tree sends no seed", "seed" in wholeTreeRequest(grown, root, 1, 0.1, { seed: null }), false);
eq("a quiet open says so, and only then", [wholeTreeRequest(grown, root, 1, 0.1, { quiet: true }).quiet, "quiet" in wholeTreeRequest(grown, root, 1, 0.1)], [true, false]);
eq("an export names its format", [exportRequest("k", 3, "brep"), exportRequest("k", 3, "step").format], [{ call: "export", key: "k", node: 3, format: "brep" }, "step"]);
eq("the engine's binary solid is told from STEP by its first bytes", [isBrep(saved), isBrep(saved.buffer), isBrep(new TextEncoder().encode("ISO-10303-21;")), isBrep(new TextEncoder().encode("LIMEBREP ")), isBrep(undefined)], [true, true, false, false, false]);
eq("a project names a solid by its format", [solidFileName("bracket.step", saved), solidFileName("bracket.stl", step), solidFileName(".brep", saved)], ["bracket.brep", "bracket.step", "solid.brep"]);
eq("an apply names the split piece's key only when there is one", [applyRequest("k", 0, 1, hole, 0.1), applyRequest("k", 0, 2, hole, 0.1, "piece#1").otherKey], [{ call: "apply", key: "k", parent: 0, node: 1, op: hole, chordMm: 0.1 }, "piece#1"]);

const tool = { object: "obj-2", key: "obj-2#a.3", node: 4, name: "telo split" };
const turned = { m: [0, -1, 0, 1, 0, 0, 0, 0, 1] as [number, number, number, number, number, number, number, number, number], t: [5, 7, 0] as [number, number, number] };
const moved = { m: turned.m, t: [5, -3, 0] as [number, number, number] };
const joined = joinOp("cut", tool, turned, moved, false);
eq("a join keeps the tool's step and its pose in the target's own frame: model −Y 10 is the target's own −X 10", { ...joined, relative: { ...joined.relative, t: joined.relative.t.map((v) => Math.round(v * 1e9) / 1e9 + 0) } }, {
  kind: "join",
  op: "cut",
  tool,
  relative: { m: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [-10, 0, 0] },
  keepTool: false,
});
eq("and is applied as any op is", applyRequest("obj-1#a.1", 2, 3, joined, 0.1).op, joined);

const wider: ModelOp = { ...hole, radius: 2 };
eq("an edit sends the new op on the parent and each replayed step with its new id", editRequest("k", 0, 5, wider, [{ id: 6, op: joined }], 0.1), {
  call: "edit",
  key: "k",
  parent: 0,
  node: 5,
  op: wider,
  replay: [{ id: 6, op: joined }],
  chordMm: 0.1,
});

const scale: ModelOp = { kind: "scale", factor: 1.25 };
eq("an edit across trees sends the tool trees' parts first, deepest first, and the open tree's as an edit", crossEditRequest([
  { key: "rod", parent: 0, node: 3, op: scale, replay: [], old: [1] },
  { key: "k", parent: 1, node: 4, op: joined, replay: [{ id: 5, op: wider }], old: [2, 3] },
], 0.1), {
  call: "edit",
  key: "k",
  parent: 1,
  node: 4,
  op: joined,
  replay: [{ id: 5, op: wider }],
  chordMm: 0.1,
  tools: [{ key: "rod", parent: 0, node: 3, op: scale, replay: [] }],
});
eq("with one tree it is a plain edit", crossEditRequest([{ key: "k", parent: 0, node: 5, op: wider, replay: [], old: [1] }], 0.1), editRequest("k", 0, 5, wider, [], 0.1));
eq("a dry-run asks for its shape only with a chord", [probeRequest("k", 2, wider), probeRequest("k", 2, wider, 0.05)], [
  { call: "probe", key: "k", node: 2, op: wider },
  { call: "probe", key: "k", node: 2, op: wider, preview: true, chordMm: 0.05 },
]);

if (failed) {
  console.error(`model-request: ${failed} failed`);
  throw new Error(`model-request: ${failed} failed`);
}
console.log("model-request: the requests the engine reads ok");
