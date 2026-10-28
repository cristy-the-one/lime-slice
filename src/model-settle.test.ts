import { eulerOrient, type Mat3 } from "./mesh-place.ts";
import { lowestZ, settledPose, solidHull } from "./model-settle.ts";
import { applyPose, placeFields, poseFromPlace, type Affine } from "./model-space.ts";
import type { Vec3 } from "./model-tree.ts";

let failed = 0;

function check(name: string, ok: boolean, detail = ""): void {
  if (ok) return;
  failed += 1;
  console.error(`FAIL ${name} ${detail}`);
}

function near(name: string, got: number, want: number, tol: number): void {
  check(name, Math.abs(got - want) <= tol, `got ${got}, want ${want} ± ${tol}`);
}

/** A box from `at` with sizes `size`, as a solid's triangles in its own frame. */
function box(size: Vec3, at: Vec3 = [0, 0, 0]): Float32Array {
  const [sx, sy, sz] = size;
  const c = (x: number, y: number, z: number): Vec3 => [at[0] + x * sx, at[1] + y * sy, at[2] + z * sz];
  const quads: Vec3[][] = [
    [c(0, 0, 0), c(0, 1, 0), c(1, 1, 0), c(1, 0, 0)],
    [c(0, 0, 1), c(1, 0, 1), c(1, 1, 1), c(0, 1, 1)],
    [c(0, 0, 0), c(1, 0, 0), c(1, 0, 1), c(0, 0, 1)],
    [c(0, 1, 0), c(0, 1, 1), c(1, 1, 1), c(1, 1, 0)],
    [c(0, 0, 0), c(0, 0, 1), c(0, 1, 1), c(0, 1, 0)],
    [c(1, 0, 0), c(1, 1, 0), c(1, 1, 1), c(1, 0, 1)],
  ];
  const out: number[] = [];
  for (const q of quads) for (const tri of [[0, 1, 2], [0, 2, 3]]) for (const i of tri) out.push(...q[i]!);
  return new Float32Array(out);
}

const sameTurn = (a: Mat3, b: Mat3, tol = 1e-9) => a.every((v, i) => Math.abs(v - b[i]!) < tol);
const ID: Affine = { m: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] };

// A 40 x 30 x 20 box standing on Z = 0, its centre at (20, 15, 10).
const slab = box([40, 30, 20]);
const hull = solidHull(slab)!;
check("a box has a hull", !!hull);
check("a plain array has none: only a solid's own array is kept", solidHull(Array.from(slab)) === null);
const pivot: Vec3 = [20, 15, 10];
near("the box stands on Z 0", lowestZ(hull, ID), 0, 1e-9);

// Held 8 degrees off about X: it snaps flat onto its base, on the floor it stood on, with its centre over the same spot.
const tilted = poseFromPlace(ID, pivot, "rx", 8);
check("a turn about the centre takes the corner under the floor", lowestZ(hull, tilted) < -0.5, String(lowestZ(hull, tilted)));
const flat = settledPose(hull, tilted, pivot, 0);
check("8 degrees off snaps to the base", flat.snapped && sameTurn(flat.pose.m, ID.m), JSON.stringify(flat.pose.m));
near("and rests on the floor", lowestZ(hull, flat.pose), 0, 1e-6);
near("with the base as its contact", flat.areaMm2, 1200, 1);
const centre = applyPose(flat.pose, pivot);
near("its centre stays over the same X", centre[0], 20, 1e-6);
near("and Y", centre[1], 15, 1e-6);

// Held near a side, it lies on that side: 84 degrees about X puts the 40 x 20 face down.
const side = settledPose(hull, poseFromPlace(ID, pivot, "rx", 84), pivot, 0);
check("84 degrees about X snaps to 90", side.snapped && sameTurn(side.pose.m, eulerOrient(90, 0, 0)), JSON.stringify(side.pose.m));
near("the side face is the contact", side.areaMm2, 800, 1);
near("and the part sits on the floor", lowestZ(hull, side.pose), 0, 1e-6);
const read = placeFields(side.pose, pivot);
near("the fields read the settled turn", read.rx, 90, 1e-6);

// Far from every face it keeps the angle held, resting on the floor, as Prepare keeps it.
const held = poseFromPlace(ID, pivot, "rx", 45);
const kept = settledPose(hull, held, pivot, 0);
check("45 degrees is out of reach and is kept", !kept.snapped && sameTurn(kept.pose.m, held.m));
near("resting on the floor", lowestZ(hull, kept.pose), 0, 1e-6);

// A part lifted in its assembly settles onto the floor it stood on, not onto Z = 0.
const lifted: Affine = { m: [...ID.m] as Mat3, t: [5, -3, 12] };
const up = settledPose(hull, poseFromPlace(lifted, pivot, "ry", -6), pivot, lowestZ(hull, lifted));
check("a lifted part snaps too", up.snapped && sameTurn(up.pose.m, ID.m));
near("and stays on its own floor", lowestZ(hull, up.pose), 12, 1e-6);
check("where it stood", Math.abs(up.pose.t[0] - 5) < 1e-6 && Math.abs(up.pose.t[1] + 3) < 1e-6, JSON.stringify(up.pose.t));

// A pose with a scale keeps it; contact is in millimetres of the scaled part.
const doubled: Affine = { m: [2, 0, 0, 0, 2, 0, 0, 0, 2], t: [0, 0, 0] };
const big = settledPose(hull, poseFromPlace(doubled, pivot, "ry", 7), pivot, lowestZ(hull, doubled));
check("a scaled part snaps and keeps its scale", big.snapped && sameTurn(big.pose.m, doubled.m), JSON.stringify(big.pose.m));
near("its contact is the scaled base", big.areaMm2, 4800, 4);

if (failed > 0) {
  console.error(`model-settle: ${failed} failed`);
  process.exit(1);
}
console.log("model settle: rest pose in model space ok");
