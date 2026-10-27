import { interference, trianglesCross } from "./interference.ts";
import { eulerOrient } from "./mesh-place.ts";
import { IDENTITY_POSE, type Affine } from "./model-space.ts";

let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) return;
  failed += 1;
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}
function eq(name: string, actual: unknown, expected: unknown): void {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  check(name, same, same ? "" : `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

/** A closed box from (0, 0, 0) to (dx, dy, dz), two triangles a face, wound outward. */
function box(dx: number, dy: number, dz: number): Float32Array {
  const c = (x: number, y: number, z: number) => [x * dx, y * dy, z * dz];
  const quads = [
    [c(0, 0, 0), c(0, 1, 0), c(1, 1, 0), c(1, 0, 0)],
    [c(0, 0, 1), c(1, 0, 1), c(1, 1, 1), c(0, 1, 1)],
    [c(0, 0, 0), c(1, 0, 0), c(1, 0, 1), c(0, 0, 1)],
    [c(0, 1, 0), c(0, 1, 1), c(1, 1, 1), c(1, 1, 0)],
    [c(0, 0, 0), c(0, 0, 1), c(0, 1, 1), c(0, 1, 0)],
    [c(1, 0, 0), c(1, 1, 0), c(1, 1, 1), c(1, 0, 1)],
  ];
  const out: number[] = [];
  for (const q of quads) for (const i of [0, 1, 2, 0, 2, 3]) out.push(...q[i]!);
  return new Float32Array(out);
}

/** A UV sphere of radius r about the origin: `rings` × `segments` × 2 triangles. */
function sphere(r: number, rings: number, segments: number): Float32Array {
  const at = (i: number, j: number) => {
    const theta = (Math.PI * i) / rings;
    const phi = (2 * Math.PI * j) / segments;
    return [r * Math.sin(theta) * Math.cos(phi), r * Math.sin(theta) * Math.sin(phi), r * Math.cos(theta)];
  };
  const out: number[] = [];
  for (let i = 0; i < rings; i += 1) {
    for (let j = 0; j < segments; j += 1) {
      out.push(...at(i, j), ...at(i + 1, j), ...at(i + 1, j + 1));
      out.push(...at(i, j), ...at(i + 1, j + 1), ...at(i, j + 1));
    }
  }
  return new Float32Array(out);
}

const at = (x: number, y: number, z: number, turn: [number, number, number] = [0, 0, 0]): Affine => ({ m: eulerOrient(turn[0], turn[1], turn[2]), t: [x, y, z] });
const body = { positions: box(70, 40, 10), pose: IDENTITY_POSE };
const hook = box(6, 6, 8);

// Clear: boxes apart.
eq("two parts apart are clear", interference(body, { positions: hook, pose: at(100, 0, 0) }).verdict, "clear");
eq("a gap of 0.1 mm is clear", interference(body, { positions: hook, pose: at(10, 10, 10.1) }).verdict, "clear");

// Touch: faces and edges resting on each other.
eq("a hook sitting on the rim touches", interference(body, { positions: hook, pose: at(10, 10, 10) }), { verdict: "touch" });
eq("a part flush against a side touches", interference(body, { positions: hook, pose: at(70, 10, 0) }), { verdict: "touch" });
eq("a part flush against the -X side touches, not nested", interference(body, { positions: hook, pose: at(-6, 10, 0) }), { verdict: "touch" });
eq("an edge resting on the top touches", interference(body, { positions: hook, pose: at(10, 10, 10, [45, 0, 0]) }).verdict, "touch");
eq("a hook on the rim's corner touches", interference(body, { positions: hook, pose: at(67, 37, 10) }).verdict, "touch");

// Crossing: sunk in, tilted in, pushed through.
const sunk = interference(body, { positions: hook, pose: at(10, 10, 9) });
eq("a hook sunk 1 mm into the rim crosses", sunk.verdict, "crossing");
check("and says where", !!sunk.at && Math.abs(sunk.at[2] - 10) < 1e-6, JSON.stringify(sunk.at));
eq("a hook tilted into the rim crosses", interference(body, { positions: hook, pose: at(10, 10, 9, [0, 0, 30]) }).verdict, "crossing");
eq("a peg through the body crosses", interference(body, { positions: box(4, 4, 30), pose: at(20, 20, -10) }).verdict, "crossing");
eq("half out of the body crosses", interference(body, { positions: hook, pose: at(67, 10, 2) }).verdict, "crossing");
eq("the order of the two parts does not matter", interference({ positions: hook, pose: at(10, 10, 9) }, body).verdict, "crossing");

// Nested: wholly inside, no triangle crosses.
eq("a part wholly inside another is a nested touch", interference(body, { positions: box(4, 4, 4), pose: at(20, 20, 3) }), { verdict: "touch", nested: true });
eq("either way round", interference({ positions: box(4, 4, 4), pose: at(20, 20, 3) }, body), { verdict: "touch", nested: true });
eq("a part resting on the inside floor of a box is nested", interference(body, { positions: box(4, 4, 4), pose: at(20, 20, 0) }).nested, true);

// The posed frames: the same pair, both moved and turned together, answers the same.
const together = at(-30, 55, 12, [10, 20, 30]);
const moved = (pose: Affine): Affine => ({ m: together.m.map((_, i) => [0, 1, 2].reduce((s, k) => s + together.m[Math.floor(i / 3) * 3 + k]! * pose.m[k * 3 + (i % 3)]!, 0)) as Affine["m"], t: [0, 1, 2].map((r) => together.t[r]! + [0, 1, 2].reduce((s, k) => s + together.m[r * 3 + k]! * pose.t[k]!, 0)) as Affine["t"] });
eq("a sunk hook still crosses when the pair is moved together", interference({ positions: body.positions, pose: together }, { positions: hook, pose: moved(at(10, 10, 9)) }).verdict, "crossing");
eq("a resting hook still touches when the pair is moved together", interference({ positions: body.positions, pose: together }, { positions: hook, pose: moved(at(10, 10, 10)) }).verdict, "touch");

// Triangle pairs.
check("two triangles in one plane do not cross", trianglesCross([[0, 0, 0], [1, 0, 0], [0, 1, 0]], [[0.2, 0.2, 0], [2, 0, 0], [0, 2, 0]]) === null);
check("a triangle standing on another does not cross it", trianglesCross([[0, 0, 0], [4, 0, 0], [0, 4, 0]], [[1, 1, 0], [2, 1, 0], [1, 1, 3]]) === null);
check("a triangle through another crosses it", trianglesCross([[0, 0, 0], [4, 0, 0], [0, 4, 0]], [[1, 1, -1], [2, 1, -1], [1, 1, 3]]) !== null);

// A large pair inside a time budget: two spheres of 20 000 triangles, the worst case of boxes that overlap and no cut.
const ball = sphere(10, 100, 100);
const started = performance.now();
const near = interference({ positions: ball, pose: IDENTITY_POSE }, { positions: sphere(10, 100, 100), pose: at(14.6, 14.6, 0) });
const farMs = performance.now() - started;
eq("two balls whose boxes overlap but which do not meet touch", near.verdict, "touch");
check("and the pass takes under a second", farMs < 1000, `${farMs.toFixed(0)} ms`);
const crossStart = performance.now();
eq("two balls pushed together cross", interference({ positions: ball, pose: IDENTITY_POSE }, { positions: ball, pose: at(12, 0, 0) }).verdict, "crossing");
check("and answer as fast", performance.now() - crossStart < 1000);

if (failed) {
  console.error(`${failed} failed`);
  throw new Error(`${failed} failed`);
}
console.log(`interference: clear, touch, crossing, nested, posed, ${farMs.toFixed(0)} ms for 2 x 20000 triangles ok`);
