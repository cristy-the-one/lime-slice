import { addDisk, diskFromHit, MAX_PAINT_DISKS, paintRequestFields, readPaint, strokeTakes, tallyText, type PaintDisk } from "./support-paint.ts";
import { placeMesh, type Mat3 } from "./mesh-place.ts";
import { oneObjectPlate, revivePlate, snapPlate, withSelectedPose } from "./plate.ts";
import { beginGesture, commitGesture, emptyHistory, undoSnap, type EditSnap } from "./ui/edit-history.ts";

let failed = 0;

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) return;
  failed += 1;
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}

function eq<T>(name: string, actual: T, expected: T): void {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  check(name, same, same ? "" : `got ${JSON.stringify(actual)}`);
}

const near = (v: number[], places = 9) => v.map((x) => Math.round(x * 10 ** places) / 10 ** places + 0);

// A 20 × 10 × 4 box from (0, 0, 0), turned a quarter about Z, scaled 2×, placed on a 220 mm bed.
const box = new Float32Array([0, 0, 0, 20, 0, 0, 20, 10, 4, 0, 10, 4]);
const quarter: Mat3 = [0, -1, 0, 1, 0, 0, 0, 0, 1];
const placed = placeMesh(box, quarter, 2, 220, 220, true);
const frame = { centre: [10, 5, 2] as [number, number, number], scale: 2 };

{
  // The box's source corner (20, 10, 4) lands on the bed at the pose of that corner.
  const corner = [20, 10, 4];
  const m = placed.pose.rotation;
  const c = frame.centre;
  const scaled = corner.map((v, k) => (v - c[k]) * 2 + c[k]);
  const local = scaled.map((v, k) => v - placed.pose.pivot[k]);
  const bed = [0, 1, 2].map((r) => m[r * 3] * local[0] + m[r * 3 + 1] * local[1] + m[r * 3 + 2] * local[2] + placed.pose.translation[r]);
  const disk = diskFromHit("block", bed as [number, number, number], [0, 1, 0], 6, placed.pose, frame);
  eq("hit goes back to the source corner", near(disk.p), [20, 10, 4]);
  eq("bed +Y is source +X after a quarter turn", near(disk.n), [1, 0, 0]);
  eq("radius in source millimetres", disk.r, 3);
  eq("kind kept", disk.kind, "block");
}

{
  const d = (x: number, r = 2): PaintDisk => ({ kind: "enforce", p: [x, 0, 0], n: [0, 0, -1], r });
  check("first dab of a stroke lands", strokeTakes(undefined, d(0)));
  check("a dab half a radius on lands", strokeTakes(d(0), d(1)));
  check("a dab closer than half a radius does not", !strokeTakes(d(0), d(0.9)));
}

{
  const full: PaintDisk[] = Array.from({ length: MAX_PAINT_DISKS }, () => ({ kind: "block", p: [0, 0, 0], n: [0, 0, 1], r: 1 }));
  const more = addDisk(full, { kind: "enforce", p: [1, 1, 1], n: [0, 0, 1], r: 1 });
  eq("cap holds", more.length, MAX_PAINT_DISKS);
  eq("under the cap appends", addDisk([], full[0]!).length, 1);
}

{
  eq("no paint sends nothing", paintRequestFields([], frame), {});
  const sent = paintRequestFields(
    [
      { kind: "enforce", p: [20, 10, 4], n: [0.6, 0, -0.8], r: 3 },
      { kind: "block", p: [10, 5, 2], n: [0, 0, 1], r: 25 },
      { kind: "block", p: [10, 5, 2], n: [0, 0, 1], r: 0.05 },
    ],
    frame,
  );
  eq("mesh frame is the source scaled about its centre", sent, {
    supportPaint: [
      { kind: "enforce", p: [30, 15, 6], n: [0.6, 0, -0.8], r: 6 },
      { kind: "block", p: [10, 5, 2], n: [0, 0, 1], r: 40 },
      { kind: "block", p: [10, 5, 2], n: [0, 0, 1], r: 0.2 },
    ],
  });
}

{
  eq("tally reads plainly", tallyText({ enforce: 3, block: 1, enforceUnhit: 0, blockUnhit: 0 }), { text: "Paint: 3 enforce disks, 1 block disk.", warn: false });
  eq("missed disks warn", tallyText({ enforce: 3, block: 1, enforceUnhit: 2, blockUnhit: 0 }).text, "Paint: 3 enforce disks, 1 block disk. 2 disks missed the part and changed nothing there.");
  eq("supports off warns", tallyText({ enforce: 1, block: 0, enforceUnhit: 0, blockUnhit: 0, supportsOff: true }), {
    text: "Paint: 1 enforce disk, 0 block disks. Supports are off, so the paint is kept but nothing prints.",
    warn: true,
  });
}

{
  eq("absent paint reads empty", readPaint(undefined), []);
  eq("a disk round-trips", readPaint([{ kind: "block", p: [1, 2, 3], n: [0, 0, 1], r: 2 }]), [{ kind: "block", p: [1, 2, 3], n: [0, 0, 1], r: 2 }]);
  eq("a bad kind fails", readPaint([{ kind: "paint", p: [1, 2, 3], n: [0, 0, 1], r: 2 }]), "The support paint in this project is damaged.");
}

{
  // One drag is one undo step: the plate snap before the stroke comes back whole.
  const plate = oneObjectPlate({
    name: "box.stl",
    fileName: "box.stl",
    bytes: new ArrayBuffer(0),
    sourcePos: box,
    orient: quarter,
    partScale: 2,
    centered: true,
    offset: { x: 0, y: 0, z: 0 },
    stepTolerance: 0.1,
    supportEdits: [],
    supportPaint: [],
  });
  const snap = (paint: readonly PaintDisk[]): EditSnap => ({
    placement: { orient: [...quarter], partScale: 2, centered: true, offset: { x: 0, y: 0, z: 0 }, stepTolerance: 0.1 },
    settings: {},
    splitCustom: false,
    profile: { nozzleDiameter: 0.4, bedX: 220, bedY: 220, bedZ: 250, maxVolumetricMm3S: 15, maxAccel: 3000, filamentDensityGCm3: 1.24, filamentCostPerKg: 20 },
    level: "simple",
    plate: snapPlate(withSelectedPose(plate, { orient: quarter, partScale: 2, centered: true, offset: { x: 0, y: 0, z: 0 }, stepTolerance: 0.1, supportEdits: [], supportPaint: paint })),
  });
  const dab = (x: number): PaintDisk => ({ kind: "block", p: [x, 5, 0], n: [0, 0, -1], r: 2 });
  let history = beginGesture(emptyHistory(), snap([dab(0)]));
  let stroke: readonly PaintDisk[] = [dab(0)];
  for (const x of [2, 4, 6]) stroke = addDisk(stroke, dab(x));
  history = commitGesture(history, snap(stroke));
  eq("the stroke is one step", history.undo.length, 1);
  const undone = undoSnap(history, snap(stroke));
  const restored = undone && revivePlate(undone.restore.plate!);
  eq("undo restores the paint before the stroke", restored?.objects[0]?.supportPaint, [dab(0)]);
  eq("redo holds the stroke", undone?.history.redo.length, 1);
}

if (failed > 0) {
  console.error(`${failed} failed`);
  throw new Error(`${failed} failed`);
}
console.log("support paint checks passed");
