import { sectionCap } from "./section-cap.ts";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) return;
  failed += 1;
  console.error(`FAIL ${name}${detail ? `\n  ${detail}` : ""}`);
}

/** A box from the origin, two triangles a face, wound outward. */
function box(sx: number, sy: number, sz: number) {
  const c = (x: number, y: number, z: number): [number, number, number] => [x * sx, y * sy, z * sz];
  const quads: [number, number, number][][] = [
    [c(0, 0, 0), c(0, 1, 0), c(1, 1, 0), c(1, 0, 0)],
    [c(0, 0, 1), c(1, 0, 1), c(1, 1, 1), c(0, 1, 1)],
    [c(0, 0, 0), c(1, 0, 0), c(1, 0, 1), c(0, 0, 1)],
    [c(0, 1, 0), c(0, 1, 1), c(1, 1, 1), c(1, 1, 0)],
    [c(0, 0, 0), c(0, 0, 1), c(0, 1, 1), c(0, 1, 0)],
    [c(1, 0, 0), c(1, 1, 0), c(1, 1, 1), c(1, 0, 1)],
  ];
  const positions: number[] = [];
  const triangles: number[] = [];
  quads.forEach((quad, face) => {
    for (const tri of [
      [0, 1, 2],
      [0, 2, 3],
    ]) {
      for (const index of tri) positions.push(...quad[index]!);
      triangles.push(face);
    }
  });
  return { positions, triangles };
}

function area(cap: Float32Array): number {
  let sum = 0;
  for (let i = 0; i + 8 < cap.length; i += 9) {
    const ax = cap[i + 3]! - cap[i]!;
    const ay = cap[i + 4]! - cap[i + 1]!;
    const az = cap[i + 5]! - cap[i + 2]!;
    const bx = cap[i + 6]! - cap[i]!;
    const by = cap[i + 7]! - cap[i + 1]!;
    const bz = cap[i + 8]! - cap[i + 2]!;
    const cx = ay * bz - az * by;
    const cy = az * bx - ax * bz;
    const cz = ax * by - ay * bx;
    sum += Math.hypot(cx, cy, cz) / 2;
  }
  return sum;
}

const solid = box(10, 10, 10);
const cap = sectionCap(solid.positions, solid.triangles, [0, 0, 4], [0, 0, 1]);
check("a mid cut makes a cap", cap.length >= 9, `len ${cap.length}`);
let onPlane = true;
for (let i = 2; i < cap.length; i += 3) if (Math.abs(cap[i]! - 4) > 1e-3) onPlane = false;
check("the cap lies on the plane", onPlane);
check("the cap has the section's area", Math.abs(area(cap) - 100) < 0.05, `area ${area(cap)}`);

const miss = sectionCap(solid.positions, solid.triangles, [0, 0, 40], [0, 0, 1]);
check("a plane past the part cuts nothing", miss.length === 0);

if (failed) throw new Error(`${failed} section cap checks failed`);
console.log("section-cap: ok");
