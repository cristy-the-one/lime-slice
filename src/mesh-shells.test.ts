import { ID_MATRIX, placeMesh, rotX, rotZ, type Bounds } from "./mesh-place.ts";
import { assemblyNotice, shellCount, shellGroups, takeGroups } from "./mesh-shells.ts";
import { boxUnder } from "./model-space.ts";
import { meshToModel, oneObjectPlate, placeObject, replaceWithShells, setMeshSeat } from "./plate.ts";

let failed = 0;

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) return;
  failed += 1;
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}

function near(actual: number, expected: number, eps = 0.02): boolean {
  return Math.abs(actual - expected) <= eps;
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

function bounds(pos: Float32Array): Bounds {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      const value = pos[i + a]!;
      if (value < min[a]) min[a] = value;
      if (value > max[a]) max[a] = value;
    }
  }
  return { min, max };
}

const solid = box(0, 0, 0, 10, 10, 10);
check("one box is one shell", shellCount(solid) === 1 && shellGroups(solid) === null);

const apart = join([box(0, 0, 0, 10, 10, 10), box(40, 0, 5, 50, 10, 15)]);
check("two separated boxes are two shells", shellCount(apart) === 2);
const touching = join([box(0, 0, 0, 10, 10, 10), box(10.0002, 0, 0, 20, 10, 10)]);
check("corners a fifth of a micron apart still touch", shellCount(touching) === 1);
const gap = join([box(0, 0, 0, 10, 10, 10), box(10.01, 0, 0, 20, 10, 10)]);
check("a hundredth of a millimetre is a gap", shellCount(gap) === 2);

const placed = placeMesh(apart, [...ID_MATRIX], 1, 220, 220, true);
const groups = shellGroups(apart);
check("the groups cover every triangle once", groups !== null && groups.groups.reduce((sum, group) => sum + group.length, 0) === apart.length / 9);
const worlds = groups ? takeGroups(placed.positions, groups.groups) : [];
const plate = oneObjectPlate({
  name: "asm.step",
  fileName: "asm.step",
  bytes: new ArrayBuffer(0),
  sourcePos: apart,
  orient: [...ID_MATRIX],
  partScale: 1,
  centered: true,
  offset: { x: 0, y: 0, z: 0 },
  stepTolerance: 0.1,
  supportEdits: [],
  supportPaint: [{ kind: "block", p: [0, 0, 0], n: [0, 0, 1], r: 1 }],
  seamPaint: [],
  reinforcement: [],
});
plate.objects[0]!.settings = { walls: 4 };
plate.objects[0]!.brep = new ArrayBuffer(2);
const next = replaceWithShells(plate, "part", worlds, 220, 220);
check("the plate gains one object per shell", next?.objects.length === 2);
if (next) {
  check("the largest piece keeps the id", next.objects[0]?.id === "part" && next.selectedId === "part");
  check("names are numbered from the file", next.objects[0]?.name === "asm 1" && next.objects[1]?.name === "asm 2");
  check("each piece is a mesh, not the whole solid", next.objects.every((obj) => obj.brep === undefined && obj.fileName.endsWith(".stl")));
  check("recipe settings stay, paint does not", next.objects.every((obj) => obj.settings.walls === 4 && obj.supportPaint.length === 0));
  check("pieces are not recentered", next.objects.every((obj) => !obj.centered && obj.partScale === 1));
  for (const [piece, world] of next.objects.map((obj, index) => [obj, worlds[index]!] as const)) {
    const got = placeObject(piece, 220, 220).bounds;
    const want = bounds(world);
    check(
      `${piece.name} stays where the shell was`,
      near(got.min[0], want.min[0]) && near(got.max[0], want.max[0]) && near(got.min[2], want.min[2]) && near(got.max[2], want.max[2]),
      `got ${got.min}..${got.max} want ${want.min}..${want.max}`,
    );
  }
  const zs = next.objects.map((obj) => placeObject(obj, 220, 220).bounds.min[2]);
  check("the raised shell is not dropped onto the bed", Math.max(...zs) > 4);
  const inModel = next.objects.map((obj) => boxUnder(bounds(obj.sourcePos), meshToModel(obj)));
  const wantModel = [bounds(box(0, 0, 0, 10, 10, 10)), bounds(box(40, 0, 5, 50, 10, 15))];
  check(
    "in model space each piece stays where it was in the part",
    inModel.every((got, i) => got.min.every((value, a) => near(value, wantModel[i]!.min[a]!)) && got.max.every((value, a) => near(value, wantModel[i]!.max[a]!))),
    JSON.stringify(inModel),
  );
}

// A parent turned, scaled, and moved on the plate, sitting turned and raised in model space, with a seat.
{
  const parent = {
    ...oneObjectPlate({
      name: "asm.step", fileName: "asm.step", bytes: new ArrayBuffer(3), sourcePos: apart, orient: rotZ(90), partScale: 2, centered: false,
      offset: { x: 30, y: 40, z: 0 }, stepTolerance: 0.1, supportEdits: [], supportPaint: [], seamPaint: [], reinforcement: [],
    }).objects[0]!,
    modelPose: { m: rotX(90), t: [100, -20, 7] as [number, number, number] },
  };
  setMeshSeat(parent.bytes, 12.5);
  const shellWorlds = takeGroups(placeObject(parent, 220, 220).positions, shellGroups(apart)!.groups);
  const pieces = replaceWithShells({ objects: [parent], selectedId: parent.id }, parent.id, shellWorlds, 220, 220)!.objects;
  const want = [box(0, 0, 0, 10, 10, 10), box(40, 0, 5, 50, 10, 15)].map((shell) => boxUnder(bounds(shell), meshToModel(parent)));
  const got = pieces.map((obj) => boxUnder(bounds(obj.sourcePos), meshToModel(obj)));
  check(
    "a shell of a turned, scaled, raised part keeps its place in model space",
    got.every((g, i) => g.min.every((value, a) => near(value, want[i]!.min[a]!)) && g.max.every((value, a) => near(value, want[i]!.max[a]!))),
    JSON.stringify({ got, want }),
  );
}

check("an STL does not get the assembly offer", assemblyNotice("pair.stl", 2) === null);
check("one STEP solid does not get the offer", assemblyNotice("asm.step", 1) === null);
const offer = assemblyNotice("asm.stp", 3);
check("a STEP assembly offers a split", offer?.message === "Imported assembly with 3 solids." && offer.label === "Split into 3 objects");

if (failed) throw new Error(`${failed} mesh-shells check(s) failed`);
console.log("mesh-shells: ok");
