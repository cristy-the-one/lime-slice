import { boundsOf, ID_MATRIX, rotZ, type Bounds } from "./mesh-place.ts";
import { shellGroups, takeGroups } from "./mesh-shells.ts";
import { boxUnder } from "./model-space.ts";
import { meshToModel, oneObjectPlate, placeObject, replaceWithSolids, setMeshSeat } from "./plate.ts";
import { pieceFileName, separateBy, solidNames, solidsOffer, stepSolidHint } from "./step-solids.ts";

let failed = 0;

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) return;
  failed += 1;
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}

function near(actual: number, expected: number, eps = 0.02): boolean {
  return Math.abs(actual - expected) <= eps;
}

function sameBox(a: Bounds, b: Bounds): boolean {
  return a.min.every((value, i) => near(value, b.min[i]!)) && a.max.every((value, i) => near(value, b.max[i]!));
}

function face(a: number[], b: number[], c: number[], d: number[]): number[] {
  return [...a, ...b, ...c, ...a, ...c, ...d];
}

function box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): Float32Array {
  const p = (x: number, y: number, z: number) => [x, y, z];
  return new Float32Array([
    ...face(p(x0, y0, z0), p(x1, y0, z0), p(x1, y1, z0), p(x0, y1, z0)),
    ...face(p(x0, y0, z1), p(x0, y1, z1), p(x1, y1, z1), p(x1, y0, z1)),
    ...face(p(x0, y0, z0), p(x0, y0, z1), p(x1, y0, z1), p(x1, y0, z0)),
    ...face(p(x1, y1, z0), p(x1, y1, z1), p(x0, y1, z1), p(x0, y1, z0)),
    ...face(p(x0, y0, z0), p(x0, y1, z0), p(x0, y1, z1), p(x0, y0, z1)),
    ...face(p(x1, y0, z0), p(x1, y0, z1), p(x1, y1, z1), p(x1, y1, z0)),
  ]);
}

function join(parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

// --- Names: the STEP's own, else <file>-<n>.
check(
  "named solids keep their STEP names, in order",
  JSON.stringify(solidNames("telo-form4.step", [{ name: "telo-form4-1" }, { name: "telo-form4-2" }, { name: "telo-form4-3" }])) === JSON.stringify(["telo-form4-1", "telo-form4-2", "telo-form4-3"]),
);
check(
  "unnamed solids are <file>-<n>",
  JSON.stringify(solidNames("cover.STP", [{ name: "" }, { name: "  " }, { name: "" }])) === JSON.stringify(["cover-1", "cover-2", "cover-3"]),
);
check(
  "a repeated name falls back to <file>-<n> and never repeats",
  JSON.stringify(solidNames("asm.step", [{ name: "bolt" }, { name: "bolt" }, { name: "asm-2" }])) === JSON.stringify(["bolt", "asm-2", "asm-3"]),
  JSON.stringify(solidNames("asm.step", [{ name: "bolt" }, { name: "bolt" }, { name: "asm-2" }])),
);
check("each piece keeps a STEP file", pieceFileName("telo-form4-1") === "telo-form4-1.step" && pieceFileName("lid.stp") === "lid.stp");

// --- The choice on import.
check("one solid offers nothing", solidsOffer(1) === null && solidsOffer(0) === null);
const offer = solidsOffer(7);
check(
  "seven solids offer the pieces or the one object",
  offer?.message === "This STEP file holds 7 solids." && offer.pieces === "Open as 7 pieces" && offer.whole === "Open as one object",
  JSON.stringify(offer),
);

// --- The count read from the file's text, before any kernel call.
const enc = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer;
const three = enc("ISO-10303-21;\nDATA;\n#10=MANIFOLD_SOLID_BREP('a',#11);\n#20=MANIFOLD_SOLID_BREP('b',#21);\n#30=BREP_WITH_VOIDS('c',#31,(#32));\nENDSEC;\n");
check("three solid entities count as three", stepSolidHint(three) === 3, String(stepSolidHint(three)));
check("a STEP with one solid counts one", stepSolidHint(enc("#5=MANIFOLD_SOLID_BREP('',#6);")) === 1);
check("a name that mentions a solid is not one", stepSolidHint(enc("#5=PRODUCT('MANIFOLD_SOLID_BREP_part','','',(#6));")) === 0);

// --- Separate: by solids for a STEP of several, by shells otherwise.
check("a STEP of three solids separates by solids", separateBy("telo-form4.step", 3) === "solids");
check("a one-solid STEP separates by shells", separateBy("cube.stp", 1) === "shells");
check("an STL separates by shells", separateBy("pair.stl", 3) === "shells" && separateBy("pair.3mf", 3) === "shells");
check("an uncounted STEP separates by shells", separateBy("cube.step", undefined) === "shells");

// --- Each piece stays where it sat in the parent: on the bed and in model space, turned and scaled as the parent was.
{
  const low = box(0, 0, 0, 10, 10, 10);
  const high = box(40, 0, 5, 50, 10, 15);
  const whole = join([low, high]);
  const parent = {
    ...oneObjectPlate({
      name: "pair.step", fileName: "pair.step", bytes: new ArrayBuffer(4), sourcePos: whole, orient: rotZ(90), partScale: 2, centered: false,
      offset: { x: 30, y: 40, z: 0 }, stepTolerance: 0.05, supportEdits: [], supportPaint: [{ kind: "block", p: [0, 0, 0], n: [0, 0, 1], r: 1 }], seamPaint: [], reinforcement: [],
    }).objects[0]!,
    settings: { walls: 3 },
  };
  setMeshSeat(parent.bytes, 7);
  // Read on their own, the kernel's pieces sit on Z = 0, lowered by 7 and 12 mm from the file.
  const pieces = [
    { name: "pair-1", fileName: "pair-1.step", bytes: new ArrayBuffer(5), sourcePos: box(0, 0, 0, 10, 10, 10), seatMm: 7 },
    { name: "lid", fileName: "lid.step", bytes: new ArrayBuffer(6), sourcePos: box(40, 0, 0, 50, 10, 10), seatMm: 12 },
  ];
  const next = replaceWithSolids({ objects: [parent], selectedId: parent.id }, parent.id, pieces, 220, 220)!;
  const made = next.objects;
  check("two solids make two objects, the first keeping the id", made.length === 2 && made[0]!.id === parent.id && next.selectedId === parent.id);
  check("each piece is named from the STEP and keeps its STEP file", made.map((obj) => `${obj.name}|${obj.fileName}`).join(",") === "pair-1|pair-1.step,lid|lid.step");
  check("pieces keep settings, not paint", made.every((obj) => obj.settings.walls === 3 && obj.supportPaint.length === 0 && !obj.centered));
  const world = placeObject(parent, 220, 220).positions;
  const shells = takeGroups(world, shellGroups(whole)!.groups);
  const wantBed = [boundsOf(shells[0]!), boundsOf(shells[1]!)];
  const gotBed = made.map((obj) => placeObject(obj, 220, 220).bounds);
  check("each piece stays where it sat on the bed", gotBed.every((b, i) => sameBox(b, wantBed[i]!)), JSON.stringify({ gotBed, wantBed }));
  const wantModel = [low, high].map((piece) => boxUnder(boundsOf(piece), { m: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 7] }));
  const gotModel = made.map((obj) => boxUnder(boundsOf(obj.sourcePos), meshToModel(obj)));
  check("each piece is where the file put it in model space", gotModel.every((b, i) => sameBox(b, wantModel[i]!)), JSON.stringify({ gotModel, wantModel }));
  check("one solid does not replace the object", replaceWithSolids({ objects: [parent], selectedId: parent.id }, parent.id, pieces.slice(0, 1), 220, 220) === null);
}

{
  const plate = oneObjectPlate({
    name: "flat.step", fileName: "flat.step", bytes: new ArrayBuffer(7), sourcePos: join([box(0, 0, 0, 10, 10, 10), box(10, 0, 0, 20, 10, 10)]), orient: [...ID_MATRIX], partScale: 1, centered: true,
    offset: { x: 0, y: 0, z: 0 }, stepTolerance: 0.05, supportEdits: [], supportPaint: [], seamPaint: [], reinforcement: [],
  });
  const touching = [
    { name: "a", fileName: "a.step", bytes: new ArrayBuffer(8), sourcePos: box(0, 0, 0, 10, 10, 10), seatMm: 0 },
    { name: "b", fileName: "b.step", bytes: new ArrayBuffer(9), sourcePos: box(10, 0, 0, 20, 10, 10), seatMm: 0 },
  ];
  const made = replaceWithSolids(plate, "part", touching, 220, 220)!.objects.map((obj) => placeObject(obj, 220, 220).bounds);
  check(
    "pieces whose cut faces touch stay together, the whole centred on the bed",
    sameBox(made[0]!, { min: [100, 105, 0], max: [110, 115, 10] }) && sameBox(made[1]!, { min: [110, 105, 0], max: [120, 115, 10] }),
    JSON.stringify(made),
  );
}

if (failed) throw new Error(`${failed} step-solids check(s) failed`);
console.log("step-solids: ok");
