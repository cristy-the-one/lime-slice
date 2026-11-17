/**
 * The rib network's plan (src/modeling/rib-net.ts) on hand-made meshes, with no modeler: snapping, wall ends, joints,
 * tapers, the room in front of the wall, the wall under the sink, refusals in a sentence, and a plan that is the same
 * every time. Also the ground of `standRegion` past a kink in a sloped floor (the leak the probe of 2026-11-17 found).
 */
import { levelFrame } from "./frames.ts";
import { standRegion } from "./plane-region.ts";
import { boxOf as boxOfMesh, toolMesh } from "./inspect.ts";
import { ribNetPlan, type RibNetPlan } from "./rib-net.ts";
import type { LoftSection } from "../model-tree.ts";

/** A step's loft sections; a box step has none. */
const lofted = (step: RibNetPlan["steps"][number]): LoftSection[] => (step.kind === "loft" ? step.sections : []);
const near = (a: readonly number[], b: readonly number[]) => a.every((v, i) => Math.abs(v - b[i]!) < 1e-3);

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(`ok ${name}`);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name}${detail ? ` ${detail}` : ""}`);
}

type V3 = [number, number, number];

/** Two triangles of a quad a, b, c, d (counter-clockwise seen from where its normal points), with its face id. */
function quad(out: number[], faces: number[], face: number, a: V3, b: V3, c: V3, d: V3) {
  out.push(...a, ...b, ...c, ...a, ...c, ...d);
  faces.push(face, face);
}

/** A box's six faces wound outward (or inward, for a cavity), as quads. */
function box(out: number[], faces: number[], first: number, lo: V3, hi: V3, inward = false, skipTop = false): number {
  const [x0, y0, z0] = lo;
  const [x1, y1, z1] = hi;
  const sides: [V3, V3, V3, V3][] = [
    [[x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]], // bottom, -Z
    [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], // top, +Z
    [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]], // -Y
    [[x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]], // +Y
    [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], // -X
    [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]], // +X
  ];
  let face = first;
  sides.forEach((q, i) => {
    if (skipTop && i === 1) return;
    if (inward) quad(out, faces, face++, q[3], q[2], q[1], q[0]);
    else quad(out, faces, face++, ...q);
  });
  return face;
}

/**
 * An open-top shelled box, 120 × 80 × 30 with 2 mm walls: the outside without its top, the cavity without its top
 * (wound into the cavity), and the rim's four strips. `lid` adds a closed slab over x from -60 to 0, z 24 to 30.
 */
function shellBox(lid = false): { positions: Float32Array; faceOf: Uint32Array } {
  const out: number[] = [];
  const faces: number[] = [];
  let face = box(out, faces, 0, [-60, -40, 0], [60, 40, 30], false, true);
  face = box(out, faces, face, [-58, -38, 2], [58, 38, 30], true, true);
  if (!lid) {
    quad(out, faces, face++, [-60, -40, 30], [60, -40, 30], [58, -38, 30], [-58, -38, 30]);
    quad(out, faces, face++, [60, -40, 30], [60, 40, 30], [58, 38, 30], [58, -38, 30]);
    quad(out, faces, face++, [60, 40, 30], [-60, 40, 30], [-58, 38, 30], [58, 38, 30]);
    quad(out, faces, face++, [-60, 40, 30], [-60, -40, 30], [-58, -38, 30], [-58, 38, 30]);
  } else {
    // The lid: its underside at z 24 over the left half (wound down into the cavity), its top at 30.
    quad(out, faces, face++, [-58, -38, 24], [-58, 38, 24], [0, 38, 24], [0, -38, 24]);
    quad(out, faces, face++, [0, -38, 24], [0, 38, 24], [0, 38, 30], [0, -38, 30]);
  }
  return { positions: Float32Array.from(out), faceOf: Uint32Array.from(faces) };
}

const flat = shellBox();
const plan = (op: Record<string, unknown>, mesh = flat) => ribNetPlan({ kind: "ribNet", ...op }, { positions: mesh.positions, faceOf: mesh.faceOf });
const ok = (made: ReturnType<typeof plan>): made is RibNetPlan => !("reason" in made);

// --- Wall to wall: one loft, its ends 0.5 mm into each wall, two sections plus the two extensions.
{
  const made = plan({ width: 1.5, height: 6, paths: [{ points: [[-58, 0, 2], [58, 0, 2]] }] });
  check("a rib from wall to wall plans", ok(made), JSON.stringify(made).slice(0, 300));
  if (ok(made)) {
    const step = made.steps[0]!;
    check("one run, both ends into a wall", made.runs === 1 && made.ends.wall === 2 && made.ends.tapered === 0, JSON.stringify(made.ends));
    check("a straight run of one height is a box that fuses", step.kind === "boolean" && step.op === "fuse" && step.primitive === "box", JSON.stringify(step));
    const box = step.kind === "boolean" ? boxOfMesh(toolMesh(step)) : null;
    check("it reaches 0.5 mm into each wall, is 1.5 wide, 0.5 into the floor and 6 off it", !!box && near(box.min, [-58.5, -0.75, 1.5]) && near(box.max, [58.5, 0.75, 8]), JSON.stringify(box));
    check("guard rays come from under the floor", made.guards.length > 10 && made.guards.every((g) => g.before !== null), String(made.guards.length));
  }
}

// --- A loose end tapers over the height; the other end meets the wall.
{
  const made = plan({ width: 1.2, height: 5, paths: [{ points: [[20, 0, 2], [58, 0, 2]] }] });
  check("a rib that starts on the floor and meets a wall plans", ok(made), JSON.stringify(made).slice(0, 300));
  if (ok(made)) {
    const s = lofted(made.steps[0]!);
    const tops = s.map((row) => Math.max(...row.profile!.map((p) => p[1])));
    check("its loose end tapers to the surface over 5 mm, the other runs into the wall", made.ends.tapered === 1 && made.ends.wall === 1 && Math.abs(tops[0]!) < 1e-6 && Math.abs(tops[1]! - 5) < 1e-6 && Math.abs(s[1]!.origin[0] - 25) < 1e-3, JSON.stringify({ tops, at: s.map((row) => row.origin) }));
  }
  const square = plan({ width: 1.2, height: 5, taper: 0, paths: [{ points: [[20, 0, 2], [58, 0, 2]] }] });
  const squareStep = ok(square) ? square.steps[0]! : null;
  check("taper 0 leaves a square end: a box 5 mm off the floor", ok(square) && square.ends.square === 1 && squareStep?.kind === "boolean" && near(boxOfMesh(toolMesh(squareStep)).max, [58.5, 0.6, 7]), JSON.stringify(squareStep));
}

// --- A T: the branch's end on the trunk runs on to the trunk's far side; crossing paths need nothing.
{
  const made = plan({ width: 2, height: 4, paths: [{ points: [[-40, 0, 2], [40, 0, 2]] }, { points: [[0, 30, 2], [0, 0, 2]] }] });
  check("a T plans", ok(made), JSON.stringify(made).slice(0, 300));
  if (ok(made)) {
    const branch = lofted(made.steps[1]!);
    check("the branch's end is a joint, run on to the trunk's far side", made.ends.joint === 1 && Math.abs(branch[branch.length - 1]!.origin[1] + 1) < 1e-3, JSON.stringify(branch.map((row) => row.origin)));
  }
  const crossing = plan({ width: 2, height: 4, paths: [{ points: [[-40, 0, 2], [40, 0, 2]] }, { points: [[0, -30, 2], [0, 30, 2]] }] });
  check("crossing paths are two runs with loose ends", ok(crossing) && crossing.runs === 2 && crossing.ends.tapered === 4);
}

// --- A sharp corner in one path: two runs that meet in a joint.
{
  const made = plan({ width: 1.5, height: 4, paths: [{ points: [[-20, -20, 2], [20, -20, 2], [-20, 0, 2]] }] });
  check("a path that doubles back is split at its corner into two runs that join", ok(made) && made.runs === 2 && made.ends.joint === 2, JSON.stringify(ok(made) ? made.ends : made));
  const bend = plan({ width: 1.5, height: 4, paths: [{ points: [[-20, -20, 2], [20, -20, 2], [20, 20, 2]] }] });
  check("a right-angle bend is one mitred run", ok(bend) && bend.runs === 1, JSON.stringify(ok(bend) ? bend.ends : bend));
}

// --- Up a wall: the path turns from the floor up the side wall, the rib turns with it.
{
  const made = plan({ width: 1.5, height: 4, paths: [{ points: [[30, 0, 2], [58, 0, 2], [58, 0, 20]] }] });
  check("a path from the floor up a wall is one run", ok(made) && made.runs === 1, JSON.stringify(ok(made) ? made.ends : made));
  if (ok(made)) {
    const last = lofted(made.steps[0]!).at(-1)!;
    check("its top section stands out of the wall, toward -X", last.origin[0] > 57.9 && last.origin[2] > 19, JSON.stringify(last));
  }
}

// --- The room in front of the wall: under a lid 22 mm over the floor a 25 mm rib is kept to 21.5 mm.
{
  const lidded = shellBox(true);
  const made = plan({ width: 1.5, height: 25, paths: [{ points: [[-58, 0, 2], [58, 0, 2]] }] }, lidded);
  check("a rib under a lid plans", ok(made), JSON.stringify(made).slice(0, 300));
  if (ok(made)) {
    const tops = lofted(made.steps[0]!).map((row) => [row.origin[0], Math.max(...row.profile!.map((p) => p[1]))]);
    check("it keeps 0.5 mm under the lid and full height past it", tops.filter(([x]) => x! < -1).every(([, h]) => Math.abs(h! - 21.5) < 1e-3) && tops.filter(([x]) => x! > 2).every(([, h]) => Math.abs(h! - 25) < 1e-3), JSON.stringify(tops));
    check("and says it shortened a stretch", made.shortened.length === 1 && made.shortened[0]!.heightMm === 21.5, JSON.stringify(made.shortened));
  }
  const none = plan({ width: 1.5, height: 25, clearanceMm: 21, paths: [{ points: [[-50, 0, 2], [-10, 0, 2]] }] }, lidded);
  check("a path with no room anywhere is refused in a sentence", !ok(none) && /No stretch of these paths has room for a rib/.test(none.reason), JSON.stringify(none));
}

// --- Refusals.
{
  const off = plan({ width: 1.5, height: 4, paths: [{ points: [[0, 0, 8], [10, 0, 8]] }] });
  check("a point off the surface is refused, with where it is", !ok(off) && off.reason.startsWith("Path 1, point 1 (0, 0, 8) is more than 2 mm from the part's surface"), JSON.stringify(off));
  const thin = plan({ width: 1.5, height: 4, sinkMm: 1.9, paths: [{ points: [[-20, 0, 2], [20, 0, 2]] }] });
  check("a sink that leaves less than 0.2 mm of the wall is refused", !ok(thin) && /the wall is 2 mm thick there/.test(thin.reason), JSON.stringify(thin));
  const noWidth = plan({ height: 4, paths: [{ points: [[-20, 0, 2], [20, 0, 2]] }] });
  check("a network without a width is refused", !ok(noWidth) && noWidth.reason.startsWith("A rib network needs width"), JSON.stringify(noWidth));
  const none = ribNetPlan({ kind: "ribNet", width: 1, height: 1, paths: [{ points: [[0, 0, 0], [1, 0, 0]] }] }, null);
  check("a part with no surface is refused", !ok(none) && /has none to read/.test(none.reason));
}

// --- The same op gives the same plan.
{
  const op = { width: 1.2, height: 5, paths: [{ points: [[-40, -20, 2], [10, 25, 2], [40, -10, 2]] }, { points: [[-58, 10, 2], [58, 10, 2]] }] };
  const a = JSON.stringify(plan(op));
  const b = JSON.stringify(plan(JSON.parse(JSON.stringify(op)) as Record<string, unknown>, shellBox()));
  check("the plan is the same every time", a === b && a.includes("sections"));
}

// --- standRegion past a kink: a floor that is flat, then rises at 8°, in a 2 mm shell. Ribs up the slope stopped
// 14 mm past the kink, inside the flat floor's wall, and broke 0.2 mm through its underside; now they stop 0.5 mm in.
{
  const t = Math.tan((8 * Math.PI) / 180);
  const c = Math.cos((8 * Math.PI) / 180);
  const kink = (2 - 2 / c) / t;
  // The shell's section in X, Z, the material's outline, extruded along Y as side faces only.
  const profile: [number, number][] = [[-100, 40], [-100, 0], [0, 0], [100, 100 * t], [100, 40], [98, 40], [98, 98 * t + 2 / c], [kink, 2], [-98, 2], [-98, 40]];
  const soup: number[] = [];
  profile.forEach((p, i) => {
    const q = profile[(i + 1) % profile.length]!;
    soup.push(p[0], -60, p[1], p[0], 60, p[1], q[0], 60, q[1], p[0], -60, p[1], q[0], 60, q[1], q[0], -60, q[1]);
  });
  const s = Math.sin((8 * Math.PI) / 180);
  const frame = levelFrame({ point: [50, 0, 50 * t + 2 / c], normal: [-s, 0, c] });
  const spans = standRegion(Float32Array.from(soup), frame, 6, 0.5).spans(0, 90);
  const toKink = -(50 - kink) / c;
  check("a rib up the slope stops 0.5 mm past the kink, not inside the floor's wall", !!spans && spans.length === 1 && Math.abs(spans[0]![0] - (toKink - 0.5)) < 0.01, JSON.stringify({ spans, expect: toKink - 0.5 }));
  check("and 0.5 mm into the wall at the top of the slope", !!spans && Math.abs(spans[0]![1] - ((98 - 50) / c + 0.5)) < 0.05, JSON.stringify(spans));
}

if (failed > 0) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("rib-net: ok");
process.exit(0);
