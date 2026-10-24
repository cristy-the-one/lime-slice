/**
 * The part's triangles split for painting: every edge under the target, the
 * area unchanged, and the budget kept.
 */
import { paintCorners } from "./paint-mesh.ts";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(name);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}

/** One 100 × 10 face, two triangles. */
const face = Float32Array.from([0, 0, 0, 100, 0, 0, 100, 10, 0, 0, 0, 0, 100, 10, 0, 0, 10, 0]);

function area(p: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < p.length; i += 9) {
    const u = [p[i + 3]! - p[i]!, p[i + 4]! - p[i + 1]!, p[i + 5]! - p[i + 2]!];
    const v = [p[i + 6]! - p[i]!, p[i + 7]! - p[i + 1]!, p[i + 8]! - p[i + 2]!];
    sum += Math.hypot(u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!) / 2;
  }
  return sum;
}

function longest(p: Float32Array): number {
  let worst = 0;
  for (let i = 0; i < p.length; i += 9) {
    for (const [a, b] of [[0, 3], [3, 6], [6, 0]] as const) {
      worst = Math.max(worst, Math.hypot(p[i + a]! - p[i + b]!, p[i + a + 1]! - p[i + b + 1]!, p[i + a + 2]! - p[i + b + 2]!));
    }
  }
  return worst;
}

const fine = paintCorners(face, 2.5);
// 1000 mm² in pieces of at most 2.5 mm a side: under 2000 pieces, where a split in four would make 8192.
check("each triangle splits until its longest edge is under 2.5 mm", longest(fine) <= 2.5 && fine.length / 9 < 2000, `${longest(fine)} ${fine.length / 9}`);
check("the split keeps the area", Math.abs(area(fine) - 1000) < 1e-3, String(area(fine)));
check("a triangle already small enough is kept as it is", paintCorners(face, 200).length === face.length);

const capped = paintCorners(face, 0.1, 3000);
check("a budget caps the corners", capped.length / 3 <= 3000 && capped.length / 3 > 600, String(capped.length / 3));

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("paint-mesh: ok");
