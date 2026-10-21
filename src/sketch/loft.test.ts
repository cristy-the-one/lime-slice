/**
 * --- F3. Loft sections from sketches, the prismatoid volume, and an old loft that has no drawing. ---
 */
import { loftGhost } from "../interact/ghosts.ts";
import { editRefusal } from "../model-edit.ts";
import { keepSketch, withoutSketch } from "../model-request.ts";
import { readSavedTree } from "../model-tree-file.ts";
import { newTree, opLabel, withChild, type Fingerprint, type LoftSection, type ModelOp } from "../model-tree.ts";
import { resolveKey, type KeyContext, type KeyEventLike } from "../ui/commands.ts";
import { sketchHandlesKey } from "./session.ts";
import { addCircle, emptySketch } from "./model.ts";
import { loopSignedArea, sketchRegions, toLoops } from "./regions.ts";
import { buildSketchLoft, loftAreaVolume, loftEditOf, readFaceLoops, readLoftDrawing, sectionArea, sectionFromRegion, sectionsCoplanar, COPLANAR_REFUSAL, SECTIONS_REFUSAL } from "./loft.ts";

let failed = 0;
function eq(name: string, got: unknown, want: unknown) {
  const left = JSON.stringify(got);
  const right = JSON.stringify(want);
  if (left === right) return;
  failed += 1;
  console.error(`FAIL ${name}\n  got  ${left}\n  want ${right}`);
}
function check(name: string, ok: boolean) {
  if (ok) return;
  failed += 1;
  console.error(`FAIL ${name}`);
}
function near(a: number, b: number, tol = 1e-6) {
  return Math.abs(a - b) < tol;
}

const square = (z: number): LoftSection => ({
  origin: [0, 0, z],
  turn: [0, 0, 0],
  profile: [[0, 0], [10, 0], [10, 10], [0, 10]],
});

check("two 10 mm squares 10 mm apart are 1000 mm³", near(loftAreaVolume([square(0), square(10)]), 1000));
check("sections in one plane are coplanar", sectionsCoplanar([square(0), { ...square(0), origin: [4, 0, 0] }]));
check("sections stacked on Z are not coplanar", !sectionsCoplanar([square(0), square(10)]));

const bed = emptySketch();
const rect = addCircle(bed, [0, 0], 5).sketch;
const region = sketchRegions(rect)[0];
check("a circle region is there", !!region);
if (region) {
  const loops = toLoops(region);
  const area = loops.reduce((sum, loop) => sum + loopSignedArea(loop), 0);
  check("a circle region's area is π r²", near(Math.abs(area), Math.PI * 25, 1e-4));
  const section = sectionFromRegion(rect, region);
  check("the loft section's area is the same", near(sectionArea(section), Math.PI * 25, 1e-4));
  const above = emptySketch({ origin: [0, 0, 30], turn: [0, 0, 0] });
  const upper = sectionFromRegion(addCircle(above, [0, 0], 5).sketch, sketchRegions(addCircle(above, [0, 0], 5).sketch)[0]!);
  const built = buildSketchLoft({
    picks: [
      { sketch: rect, section },
      { sketch: null, section: square(30) },
    ],
    ruled: true,
    mode: "new",
  });
  check("a loft builds", "op" in built);
  if ("op" in built) {
    eq("a new object is stored as fuse", built.op.op, "fuse");
    eq("ruled is sent", built.op.ruled, true);
    check("the drawing keeps the first sketch and a null face", built.op.drawing?.sketches?.[0]?.entities.length === rect.entities.length && built.op.drawing?.sketches?.[1] === null);
    const sent = withoutSketch(built.op);
    check("the engine op has no drawing", !("drawing" in sent));
    check("an op with no drawing is the same object", withoutSketch(sent) === sent);
    eq("putting the drawing back restores it", keepSketch(sent, built.op), built.op);
    eq("the row names a ruled loft", opLabel(built.op), "Loft through 2 sections, ruled");
  }
  void upper;
}

const same = buildSketchLoft({ picks: [{ sketch: null, section: square(0) }, { sketch: null, section: square(0) }], ruled: false, mode: "fuse" });
eq("coplanar sections are refused in the kernel's words", "error" in same ? same.error : "", COPLANAR_REFUSAL);
const one = buildSketchLoft({ picks: [{ sketch: null, section: square(0) }], ruled: false, mode: "fuse" });
eq("one section is refused", "error" in one ? one.error : "", SECTIONS_REFUSAL);

const radius: LoftSection = { origin: [0, 0, 0], turn: [0, 0, 0], radius: 4 };
const lifted: LoftSection = { origin: [0, 0, 12], turn: [0, 0, 0], radius: 4 };
const edited = loftEditOf({ kind: "loft", op: "cut", sections: [radius, lifted] } as ModelOp, false);
check("an MCP loft reopens", !!edited && edited.kind === "loft" && edited.choice === "cut" && edited.ruled === false);
const rebuilt = edited?.sketches[0];
check("a radius section rebuilds as a circle sketch", rebuilt?.entities.some((entity) => entity.kind === "circle" && entity.radius === 4) === true);

const fp: Fingerprint = { volumeMm3: 1, faces: 1, edges: 1 };
const loftOp: ModelOp = { kind: "loft", op: "fuse", sections: [square(0), square(10)] };
const tree = withChild(newTree("k", { kind: "step", name: "a.step", bytes: new ArrayBuffer(0) }, "a", fp), 0, { id: 1, op: loftOp, label: "Loft", fingerprint: fp });
eq("a loft step can be edited", editRefusal(tree, 1), null);

const saved = readSavedTree({
  nodes: [
    { id: 0, parent: null, op: null, fingerprint: null },
    { id: 1, parent: 0, op: { kind: "loft", op: "fuse", sections: [square(0), square(10)] }, fingerprint: null },
  ],
  current: 1,
  committed: 1,
  nextId: 2,
  rootStep: "a.step",
});
const opened = saved && "rootStep" in saved ? saved.nodes[1]?.op : null;
check("an old loft opens with no drawing", !!opened && opened.kind === "loft" && opened.drawing === undefined && opened.sections.length === 2);

const messy = readSavedTree({
  nodes: [
    { id: 0, parent: null, op: null, fingerprint: null },
    { id: 1, parent: 0, op: { kind: "loft", op: "fuse", sections: [square(0), square(10)], drawing: { sweep: { profile: "no" } } }, fingerprint: null },
  ],
  current: 1,
  committed: 1,
  nextId: 2,
  rootStep: "a.step",
});
const dropped = messy && "rootStep" in messy ? messy.nodes[1]?.op : null;
check("a bad drawing is dropped and the loft still opens", !!dropped && dropped.kind === "loft" && dropped.drawing === undefined);

eq("readLoftDrawing rejects a sketch that is not one", readLoftDrawing({ sketches: ["nope"] }), undefined);
const face = readFaceLoops({ origin: [0, 0, 1], turn: [0, 0, 0], loops: [{ start: [0, 0], segments: [{ kind: "line", to: [1, 0] }, { kind: "line", to: [1, 1] }, { kind: "line", to: [0, 0] }] }] });
check("face loops read a flat outline", !("error" in face) && face.loops.length === 1);
eq("a curved face keeps the kernel sentence", readFaceLoops({ error: "Face loops are for a flat face." }), { error: "Face loops are for a flat face." });

const squareRing = (z: number): [number, number, number][] => [[0, 0, z], [10, 0, z], [10, 10, z], [0, 10, z]];
let ghost = 0;
const soup = loftGhost([squareRing(0), squareRing(10)]);
for (let i = 0; i + 8 < soup.length; i += 9) {
  const ax = soup[i]!;
  const ay = soup[i + 1]!;
  const az = soup[i + 2]!;
  const bx = soup[i + 3]!;
  const by = soup[i + 4]!;
  const bz = soup[i + 5]!;
  const cx = soup[i + 6]!;
  const cy = soup[i + 7]!;
  const cz = soup[i + 8]!;
  ghost += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
}
check("the loft ghost of a square prism is 1000 mm³", near(Math.abs(ghost / 6), 1000, 1e-3));

const model: KeyContext = { helpOpen: false, typing: false, stage: "model", hasResult: false, running: false, searching: false, brushOn: false, editingSupports: false, inGcode: false, sketchOpen: false, sketchFeature: false, sketchLoft: false };
const key = (name: string, shift: boolean): KeyEventLike => ({ key: shift ? name.toUpperCase() : name, code: `Key${name.toUpperCase()}`, ctrlKey: false, metaKey: false, shiftKey: shift, altKey: false, repeat: false });
eq("W still picks edges when no sketch is open", resolveKey(key("w", false), model)?.id, "model-edge");
eq("Shift+L still chamfers when no sketch is open", resolveKey(key("l", true), model)?.id, "model-chamfer");
eq("the sketch does not claim W", sketchHandlesKey("w", { ctrl: false, meta: false, shift: false }), false);
eq("the sketch still claims L, Shift included, for the Line tool", sketchHandlesKey("L", { ctrl: false, meta: false, shift: true }), true);

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("loft tests passed");
