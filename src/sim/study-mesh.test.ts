/**
 * SR-16. The sliced mesh and the picked faces are one tessellation, scaled once.
 */
import { encodeStl, scaledCanonical } from "../mesh-place.ts";
import { chooseStudyMesh, STUDY_MESH_REFUSAL, sameTessellation } from "./study-mesh.ts";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(name);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}

/** An outward box, two triangles a face. Face 0 is +Z. */
function box(min: number[], max: number[]): { positions: Float32Array; triangles: Uint32Array } {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const c = [
    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
  ];
  const quads = [
    [4, 5, 6, 7],
    [0, 3, 2, 1],
    [1, 2, 6, 5],
    [0, 4, 7, 3],
    [3, 7, 6, 2],
    [0, 1, 5, 4],
  ];
  const positions = new Float32Array(quads.length * 18);
  const triangles = new Uint32Array(quads.length * 2);
  quads.forEach((quad, face) => {
    const corner = (index: number) => c[quad[index]!]!;
    const write = (tri: number, a: number[], b: number[], d: number[]) => {
      positions.set([...a, ...b, ...d], (face * 2 + tri) * 9);
      triangles[face * 2 + tri] = face;
    };
    write(0, corner(0), corner(1), corner(2));
    write(1, corner(0), corner(2), corner(3));
  });
  return { positions, triangles };
}

function inside(at: number[], min: number[], max: number[]): boolean {
  return at.every((value, axis) => value >= min[axis]! - 1e-3 && value <= max[axis]! + 1e-3);
}

const small = box([-4, -3, 0], [4, 3, 4]);
const scaled = chooseStudyMesh({
  picked: small.positions,
  pickedTriangles: small.triangles,
  plate: null,
  scale: 2,
  committed: false,
});
if (!scaled || "reason" in scaled) {
  check("scale 2 slices the solid the faces were picked on", false, scaled && "reason" in scaled ? scaled.reason : "no mesh");
} else {
  const expect = scaledCanonical(small.positions, 2);
  let same = scaled.positions.length === expect.length;
  for (let i = 0; i < expect.length; i += 1) if (Math.abs(scaled.positions[i]! - expect[i]!) > 1e-4) same = false;
  const face = scaled.triangles ? Number(scaled.triangles[0]) : -1;
  const corner = [scaled.positions[0]!, scaled.positions[1]!, scaled.positions[2]!];
  const view = new DataView(encodeStl(scaled.positions, "box.stl"));
  const vx = view.getFloat32(84 + 12, true);
  const vy = view.getFloat32(84 + 16, true);
  const vz = view.getFloat32(84 + 20, true);
  check("scale 2 slices the solid the faces were picked on", same && face === 0, `face ${face}`);
  check(
    "the face triangle is a corner of that scaled mesh",
    inside(corner, [-8, -6, -2], [8, 6, 6]) && Math.abs(vx - corner[0]!) < 1e-4 && Math.abs(vy - corner[1]!) < 1e-4 && Math.abs(vz - corner[2]!) < 1e-4,
    `${corner.join(",")} stl ${vx},${vy},${vz}`,
  );
}

const plate = small.positions;
const editedBox = box([-8, -3, 0], [8, 3, 4]);
check("a size edit keeps the triangle count", plate.length === editedBox.positions.length && !sameTessellation(editedBox.positions, plate));
const edited = chooseStudyMesh({
  picked: editedBox.positions,
  pickedTriangles: editedBox.triangles,
  plate,
  scale: 1,
  committed: true,
});
if (!edited || "reason" in edited) {
  check("an uncommitted size edit slices the edited solid", false, edited && "reason" in edited ? edited.reason : "no mesh");
} else {
  const moved = Math.abs(edited.positions[0]! - editedBox.positions[0]!) < 1e-4 && Math.abs(edited.positions[0]! - plate[0]!) > 1;
  check("an uncommitted size edit slices the edited solid", moved, `x ${edited.positions[0]} plate ${plate[0]}`);
}

const missing = chooseStudyMesh({ picked: null, pickedTriangles: null, plate: null, scale: 2, committed: false });
check(
  "a missing solid at scale 2 is refused",
  !!missing && "reason" in missing && missing.reason === STUDY_MESH_REFUSAL,
  missing && "reason" in missing ? missing.reason : "no refusal",
);

const beam = chooseStudyMesh({
  picked: null,
  pickedTriangles: null,
  plate: small.positions,
  scale: 1,
  committed: true,
});
check(
  "a committed mesh with no solid stays that mesh",
  !!beam && !("reason" in beam) && beam.unscaled === small.positions && beam.triangles === null,
);

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("study-mesh: ok");
