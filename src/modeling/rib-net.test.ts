/**
 * The rib network's plan (src/modeling/rib-net.ts) on hand-made meshes, with no modeler: snapping, wall ends, joints,
 * tapers, the room in front of the wall, the wall under the sink, refusals in a sentence, and a plan that is the same
 * every time. Also the ground of `standRegion` past a kink in a sloped floor (the leak the probe of 2026-11-17 found).
 */
import { levelFrame } from "./frames.ts";
import { standRegion } from "./plane-region.ts";
import { boxOf as boxOfMesh, toolMesh } from "./inspect.ts";
import { ribNetPlan, ribNetReport, ribShape, type RibNetPlan, type RibProfile, type RibShape } from "./rib-net.ts";
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

// --- What a network adds (volumeMm3), against the closed form of what it builds.
{
  // Wall to wall: 116 × 1.5 × 6 over the floor (the sunk half millimetre and the ends into the walls add nothing).
  const wall = plan({ width: 1.5, height: 6, paths: [{ points: [[-58, 0, 2], [58, 0, 2]] }] });
  check("volume, wall to wall: 116 × 1.5 × 6", ok(wall) && Math.abs(wall.volumeMm3 - 116 * 1.5 * 6) < 0.5, ok(wall) ? String(wall.volumeMm3) : "");
  // One loose end tapering over its 5 mm height: 38 mm less half the taper's 5 mm, × 1.2 × 5.
  const loose = plan({ width: 1.2, height: 5, paths: [{ points: [[20, 0, 2], [58, 0, 2]] }] });
  check("volume, a loose end: the taper takes half its length off", ok(loose) && Math.abs(loose.volumeMm3 - (38 - 2.5) * 1.2 * 5) < 0.5, ok(loose) ? String(loose.volumeMm3) : "");
  // A path's own taper at its free first point (15 mm, 3 × the height) over the network's; its end at the wall ignores
  // its taper and runs into the wall. The path's ends are reported.
  const own = plan({ width: 1.2, height: 5, taper: 2, paths: [{ points: [[20, 0, 2], [58, 0, 2]], taperMm: [15, 40] }] });
  check("a path's own taper at its free end: half of 15 mm off, the wall end runs in", ok(own) && Math.abs(own.volumeMm3 - (38 - 7.5) * 1.2 * 5) < 0.5 && own.ends.tapered === 1 && own.ends.wall === 1 && JSON.stringify(own.pathEnds) === '[["free","wall"]]', ok(own) ? JSON.stringify({ v: own.volumeMm3, ends: own.ends, pathEnds: own.pathEnds }) : own.reason);
  const fallback = plan({ width: 1.2, height: 5, taper: 2, paths: [{ points: [[20, 0, 2], [58, 0, 2]], taperMm: [null, null] }] });
  check("null takes the network's taper", ok(fallback) && Math.abs(fallback.volumeMm3 - (38 - 1) * 1.2 * 5) < 0.5, ok(fallback) ? String(fallback.volumeMm3) : "");
  const bad = plan({ width: 1.2, height: 5, paths: [{ points: [[20, 0, 2], [58, 0, 2]], taperMm: [-1, 0] }] });
  check("a bad taperMm is refused in a sentence", !ok(bad) && /taperMm is \[start, end\]/.test(bad.reason), JSON.stringify(bad));
  // Two crossing ribs, every end tapered: their lengths less the tapers, less the crossing they share once.
  const crossing = plan({ width: 2, height: 4, paths: [{ points: [[-40, 0, 2], [40, 0, 2]] }, { points: [[0, -30, 2], [0, 30, 2]] }] });
  const want = (80 - 4) * 2 * 4 + (60 - 4) * 2 * 4 - 2 * 2 * 4;
  check("volume, a crossing counted once", ok(crossing) && Math.abs(crossing.volumeMm3 - want) < 0.5, ok(crossing) ? `${crossing.volumeMm3} against ${want}` : "");
  // A T: the branch runs from the wall to the trunk's centre line; half the trunk's width of it is in the trunk.
  const tee = plan({ width: 2, height: 4, paths: [{ points: [[-58, 0, 2], [58, 0, 2]] }, { points: [[0, 38, 2], [0, 0, 2]] }] });
  check("volume, a T: the branch's end in the trunk counted once", ok(tee) && Math.abs(tee.volumeMm3 - (116 * 2 * 4 + (38 - 1) * 2 * 4)) < 0.5, ok(tee) ? String(tee.volumeMm3) : "");
}

// --- A rib that meets the wall at a slant still runs into it, and the floor's corner reads the room it has.
{
  // 6° off square: at its end one corner of the rib is already in the wall. It used to taper; it runs into the wall.
  const slant = plan({ width: 1.35, height: 6, paths: [{ points: [[0, 10, 2], [2.94, 38, 2]] }] });
  check("a slanted end against a wall runs into it", ok(slant) && slant.ends.wall === 1 && slant.ends.tapered === 1, ok(slant) ? JSON.stringify(slant.ends) : slant.reason);
  // A path that starts on the corner where floor meets wall: the room up runs along the wall's plane, not into it.
  const corner = plan({ width: 1.35, height: 6, paths: [{ points: [[0, -38, 2], [0, 38, 2]] }] });
  check("a rib from corner to corner: nothing skipped, both ends into the walls", ok(corner) && corner.skipped.length === 0 && corner.ends.wall === 2 && Math.abs(corner.volumeMm3 - 76 * 1.35 * 6) < 0.5, ok(corner) ? JSON.stringify({ skipped: corner.skipped, ends: corner.ends, volume: corner.volumeMm3 }) : corner.reason);
}

// --- Heights per stretch: one run that steps down in its middle and up again, not three runs end to end.
{
  const made = plan({ width: 1.35, height: 6, paths: [{ points: [[-58, 0, 2], [-10, 0, 2], [10, 0, 2], [58, 0, 2]], heights: [6, 3, 6] }] });
  check("a path with heights per stretch plans as one run", ok(made) && made.runs === 1 && made.ends.wall === 2 && made.ends.joint === 0 && made.shortened.length === 0 && made.skipped.length === 0, ok(made) ? JSON.stringify({ runs: made.runs, ends: made.ends, shortened: made.shortened }) : made.reason);
  const tops = ok(made) ? lofted(made.steps[0]!).map((row) => ({ x: row.origin[0], top: Math.max(...row.profile!.map((p) => p[1])) })) : [];
  check("it stands 3 mm over the middle stretch and 6 mm elsewhere", tops.length > 2 && tops.filter((t) => t.x > -9.9 && t.x < 9.9).every((t) => Math.abs(t.top - 3) < 1e-6) && tops.filter((t) => Math.abs(t.x) > 13).every((t) => Math.abs(t.top - 6) < 1e-6), JSON.stringify(tops));
  // 116 mm × 1.35 at 6, less the middle 20 mm at 3 and a ramp a sample long each side.
  const want = 116 * 1.35 * 6 - 20 * 1.35 * 3;
  check("its volume: the steps cost a ramp each, under 2 %", ok(made) && made.volumeMm3 < want + 1e-6 && made.volumeMm3 > 0.98 * want, ok(made) ? `${made.volumeMm3} against ${want}` : "");
  const bad = plan({ width: 1.35, height: 6, paths: [{ points: [[-58, 0, 2], [58, 0, 2]], heights: [7] }] });
  check("heights above the path's height are refused in a sentence", !ok(bad) && /heights is one height per stretch/.test(bad.reason), ok(bad) ? "planned" : bad.reason);
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

// ===== Profiles: drafted, tee, and a flared root on any of them. =====

type P2 = [number, number];
/** A polygon's area, positive counter-clockwise. */
const area = (poly: readonly P2[]) => poly.reduce((sum, p, i) => sum + p[0] * poly[(i + 1) % poly.length]![1] - poly[(i + 1) % poly.length]![0] * p[1], 0) / 2;
/** Its area over the surface: all of it less the sunk rectangle under v = 0 (the bottom edge is its second corner). */
const above = (poly: readonly P2[], sink: number) => area(poly) - 2 * poly[1]![0] * sink;
/** Whether no two of its edges cross or touch but at the corner they share, and no edge has no length. */
function simple(poly: readonly P2[]): boolean {
  const n = poly.length;
  const cross2 = (o: P2, a: P2, b: P2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  for (let i = 0; i < n; i += 1) {
    const a = poly[i]!;
    const b = poly[(i + 1) % n]!;
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 1e-9) return false;
    for (let j = i + 2; j < n; j += 1) {
      if (i === 0 && j === n - 1) continue;
      const c = poly[j]!;
      const d = poly[(j + 1) % n]!;
      const d1 = cross2(c, d, a);
      const d2 = cross2(c, d, b);
      const d3 = cross2(a, b, c);
      const d4 = cross2(a, b, d);
      if (((d1 > 1e-12 && d2 < -1e-12) || (d1 < -1e-12 && d2 > 1e-12)) && ((d3 > 1e-12 && d4 < -1e-12) || (d3 < -1e-12 && d4 > 1e-12))) return false;
    }
  }
  return true;
}
const profile = (kind: RibProfile["kind"], over: Partial<RibProfile> = {}): RibProfile => ({ kind, width: 1.5, draftDeg: 0, rootRadius: 0, flangeWidth: 0, flangeThickness: 0, flangeChamferDeg: 0, ...over });
const shapeOf = (p: RibProfile, h: number, sink = 0.5, tol = 0.05): RibShape => {
  const made = ribShape(p, h, sink, tol);
  if ("reason" in made) throw new Error(made.reason);
  return made;
};
/** The area the chords add over the true arcs: two roots of n chords, each a circular segment. */
const chordExcess = (s: RibShape, sweep: number) => (s.arcChords ? 2 * s.arcChords * ((s.profile.rootRadius ** 2) / 2) * (sweep / s.arcChords - Math.sin(sweep / s.arcChords)) : 0);
/** The area a root fillet adds between a wall and a side at angle phi to it. */
const fillet = (r: number, phi: number) => r * r * (1 / Math.tan(phi / 2) - (Math.PI - phi) / 2);

// --- Section areas against the analytic ones, and the root arc within the chord tolerance.
{
  const w = 1.5;
  const h = 6;
  const r = 0.75;
  const straight = shapeOf(profile("straight", { rootRadius: r }), h);
  const s0 = straight.section(h);
  const wantStraight = w * h + 2 * fillet(r, Math.PI / 2) + chordExcess(straight, Math.PI / 2);
  check("a straight rib with a 0.75 mm root: its area over the wall is w·h + 2 r²(1 − π/4) plus the chords' segments", Math.abs(above(s0, 0.5) - wantStraight) < 1e-9, JSON.stringify({ got: above(s0, 0.5), want: wantStraight, chords: straight.arcChords }));
  check("its footprint is w + 2r and it has 2 + 2 × (2 + chords) corners", Math.abs(straight.foot - (w / 2 + r)) < 1e-12 && s0.length === 2 * (3 + straight.arcChords), JSON.stringify({ foot: straight.foot, corners: s0.length }));
  // Every root corner on the circle about (w/2 + r, r), and each chord within the tolerance of it.
  const right = s0.slice(2, 3 + straight.arcChords);
  const onCircle = right.every((p) => Math.abs(Math.hypot(p[0] - (w / 2 + r), p[1] - r) - r) < 1e-12);
  const sagitta = r * (1 - Math.cos(Math.PI / 2 / straight.arcChords / 2));
  check(`the root arc: ${straight.arcChords} chords, each within ${Math.round(sagitta * 1e4) / 1e4} mm of the circle (tolerance 0.05)`, onCircle && sagitta <= 0.05 && right.length === straight.arcChords + 1, JSON.stringify(right));

  const draft = 1;
  const th = Math.tan((draft * Math.PI) / 180);
  const drafted = shapeOf(profile("drafted", { draftDeg: draft, rootRadius: 0.5 * (w - h * th) }), h);
  const d0 = drafted.section(h);
  const rd = drafted.profile.rootRadius;
  const phi = Math.PI / 2 + (draft * Math.PI) / 180;
  const wantDrafted = w * h + 2 * fillet(rd, phi) + chordExcess(drafted, Math.PI - phi);
  check("a drafted rib, 1° a side, its root half its top width: area w·h (w at half height) + 2 fillets at 91° + chord segments", Math.abs(above(d0, 0.5) - wantDrafted) < 1e-9, JSON.stringify({ got: above(d0, 0.5), want: wantDrafted }));
  check("its top is w − h·tan 1° wide and its sides lean 1°", Math.abs(2 * drafted.halfAt(h, h) - (w - h * th)) < 1e-9 && Math.abs(2 * drafted.halfAt(h, h / 2) - w) < 1e-9, JSON.stringify([2 * drafted.halfAt(h, h), 2 * drafted.halfAt(h, h / 2)]));
  const bare = shapeOf(profile("drafted", { draftDeg: 2 }), h);
  check("a drafted rib with a sharp root is a trapezoid of area w·h", Math.abs(above(bare.section(h), 0.5) - w * h) < 1e-9 && bare.section(h).length === 6);

  const tee = shapeOf(profile("tee", { rootRadius: 0.75, flangeWidth: 4.5, flangeThickness: 1.5, flangeChamferDeg: 45 }), h);
  const t0 = tee.section(h);
  const fa = 4.5 / 2 - w / 2;
  const wantTee = w * h + 2 * fa * 1.5 + fa * fa + 2 * fillet(0.75, Math.PI / 2) + chordExcess(tee, Math.PI / 2);
  check("a tee (web 1.5, flange 4.5 × 1.5, 45° chamfer, 0.75 root): area web + flange + chamfer triangles + fillets + chords", Math.abs(above(t0, 0.5) - wantTee) < 1e-9, JSON.stringify({ got: above(t0, 0.5), want: wantTee }));
  check("its reach is the flange's half-width and its footprint the root's", tee.reach === 2.25 && tee.foot === 1.5, JSON.stringify([tee.reach, tee.foot]));
  const square = shapeOf(profile("tee", { flangeWidth: 4.5, flangeThickness: 1.5, flangeChamferDeg: 0 }), h);
  check("a square tee with a sharp root: web + flange, 10 corners", Math.abs(above(square.section(h), 0.5) - (w * h + 2 * fa * 1.5)) < 1e-9 && square.section(h).length === 10,String(square.section(h).length));
  // The 45° chamfer: the edge from the web's top to the flange's underside rises as far as it runs out.
  const web = t0.findIndex((p, i) => i > 1 && Math.abs(p[0] - w / 2) < 1e-12 && p[1] > 1);
  const out = t0[web + 1]!;
  check("the chamfer under the flange is 45° to the wall", Math.abs(out[1] - t0[web]![1] - (out[0] - t0[web]![0])) < 1e-12, JSON.stringify([t0[web], out]));
  for (const [name, s] of [["straight", straight], ["drafted", drafted], ["tee", tee], ["square tee", square], ["sharp drafted", bare]] as const) {
    check(`${name}: every section from the full height to the surface is a simple polygon with the same corners`, [1, 0.9, 0.75, 0.5, 0.3, 0.2, 0.1, 0.05, 0.01, 0].every((f) => s.section(h * f).length === s.section(h).length && simple(s.section(h * f))));
    check(`${name}: at height 0 nothing stands over the wall`, Math.abs(above(s.section(0), 0.5)) < 1e-12 && s.section(0).every((p) => p[1] <= 1e-12));
  }
  // The flange rides at the top while the rib is lower (a face in front of the wall) and above hb.
  check("a lower tee keeps its flange whole at its top", [h, 5, tee.hb].every((hk) => Math.abs(tee.halfAt(hk, hk - 0.75) - 2.25) < 1e-9 && Math.max(...tee.section(hk).map((p) => p[1])) === hk), String(tee.hb));
  check("under hb the flange narrows into the web as it comes down", tee.halfAt(tee.hb / 2, (tee.hb / 2) * 0.99) < 2.25 && tee.halfAt(tee.hb / 4, (tee.hb / 4) * 0.99) < tee.halfAt(tee.hb / 2, (tee.hb / 2) * 0.99));
  check("the same profile gives the same section", JSON.stringify(shapeOf(profile("tee", { rootRadius: 0.75, flangeWidth: 4.5, flangeThickness: 1.5, flangeChamferDeg: 45 }), h).section(4.2)) === JSON.stringify(tee.section(4.2)));
}

// --- Profiles in a plan: wall to wall each is one extrude, a taper is a loft through hb, the reply counts profiles.
{
  for (const kind of ["drafted", "tee"] as const) {
    const made = plan({ width: 1.5, height: 6, profile: kind, paths: [{ points: [[-58, 0, 2], [58, 0, 2]] }] });
    check(`a ${kind} rib wall to wall is one extrude, both ends into a wall`, ok(made) && made.runs === 1 && made.steps[0]!.kind === "extrude" && made.ends.wall === 2 && made.stepProfile[0] === kind, JSON.stringify(ok(made) ? made.steps[0] : made).slice(0, 300));
    if (ok(made) && made.steps[0]!.kind === "extrude") check(`  and it runs from 0.5 mm into one wall to 0.5 mm into the other`, Math.abs(made.steps[0]!.depth - 117) < 1e-6 && Math.abs(made.steps[0]!.origin[0] + 58.5) < 1e-6, JSON.stringify(made.steps[0]!.origin));
  }
  const rooted = plan({ width: 1.5, height: 6, rootRadius: 0.75, paths: [{ points: [[-58, 0, 2], [58, 0, 2]] }] });
  check("a straight rib with a root is an extrude too", ok(rooted) && rooted.steps[0]!.kind === "extrude");
  const taper = plan({ width: 1.5, height: 6, profile: "tee", paths: [{ points: [[20, 0, 2], [58, 0, 2]] }] });
  check("a tapered tee is one loft: 0 at the free end, hb, then full height", ok(taper) && taper.steps.length === 1 && lofted(taper.steps[0]!).length === 4, JSON.stringify(ok(taper) ? lofted(taper.steps[0]!).map((s) => [s.origin[0], Math.max(...s.profile!.map((p) => p[1]))]) : taper));
  if (ok(taper)) {
    const tops = lofted(taper.steps[0]!).map((s) => Math.max(...s.profile!.map((p) => p[1])));
    check("  its heights rise 0, hb, 6, 6 along it, every section the same corners", Math.abs(tops[0]!) < 1e-9 && tops[1]! > 0 && tops[1]! < 6 && Math.abs(tops[2]! - 6) < 1e-9 && new Set(lofted(taper.steps[0]!).map((s) => s.profile!.length)).size === 1, JSON.stringify(tops));
  }
  const mixed = plan({ width: 1.5, height: 6, paths: [{ points: [[-58, 0, 2], [58, 0, 2]], profile: "drafted" }, { points: [[0, 38, 2], [0, 0, 2]], profile: "tee" }, { points: [[-30, -38, 2], [-30, 30, 2]] }] });
  check("mixed profiles: a tee ending on a drafted rib is a joint, a straight rib crosses the drafted one", ok(mixed) && mixed.ends.joint === 1 && mixed.ends.wall === 4 && mixed.stepProfile.join() === "drafted,tee,straight", JSON.stringify(ok(mixed) ? [mixed.ends, mixed.stepProfile] : mixed));
  if (ok(mixed)) {
    const teeStep = mixed.steps[1]!;
    const minHalf = 0.75 - (6 * Math.tan(Math.PI / 180)) / 2;
    // The tee runs from 0.5 mm into the wall at y 38 to past the drafted rib's centre by its narrowest half (its top).
    check("  the tee runs on past the drafted rib's centre by the drafted top's half-width", teeStep.kind === "extrude" && Math.abs(teeStep.origin[1] - 38.5) < 1e-6 && Math.abs(teeStep.depth - (38.5 + minHalf)) < 1e-6, JSON.stringify(teeStep).slice(0, 300));
    const report = ribNetReport(mixed, 123.4, []);
    check("  the reply counts runs by profile", JSON.stringify(report.profiles) === JSON.stringify({ drafted: 1, tee: 1, straight: 1 }) && /3 runs \(1 straight, 1 drafted, 1 tee\)/.test(String(report.note)), JSON.stringify(report));
  }
  // Under the lid a 25 mm tee is kept to 21.5 mm with its flange at the top.
  const lidded = plan({ width: 1.5, height: 25, profile: "tee", paths: [{ points: [[-58, 0, 2], [58, 0, 2]] }] }, shellBox(true));
  check("a tee under the lid plans, kept lower", ok(lidded) && lidded.shortened.length === 1 && lidded.shortened[0]!.heightMm === 21.5, JSON.stringify(ok(lidded) ? lidded.shortened : lidded));
  if (ok(lidded)) {
    const under = lofted(lidded.steps[0]!).filter((s) => s.origin[0] < -1);
    check("  its flange rides at 21.5 mm under the lid, as wide as at full height", under.length > 0 && under.every((s) => Math.abs(Math.max(...s.profile!.map((p) => p[1])) - 21.5) < 1e-6 && Math.abs(Math.max(...s.profile!.map((p) => p[0])) - 2.25) < 1e-6), JSON.stringify(under.map((s) => s.profile)).slice(0, 300));
  }
  // A 312-run lattice of each profile (13 × 13 nodes, every end a joint): every run one box or extrude.
  const paths: { points: number[][] }[] = [];
  const xs = Array.from({ length: 13 }, (_, i) => -54 + i * 9);
  const ys = Array.from({ length: 13 }, (_, j) => -33 + j * 5.5);
  for (const y of ys) for (let i = 0; i + 1 < xs.length; i += 1) paths.push({ points: [[xs[i]!, y, 2], [xs[i + 1]!, y, 2]] });
  for (const x of xs) for (let j = 0; j + 1 < ys.length; j += 1) paths.push({ points: [[x, ys[j]!, 2], [x, ys[j + 1]!, 2]] });
  for (const kind of ["straight", "drafted", "tee"] as const) {
    const started = performance.now();
    const made = plan({ width: 1.2, height: 5, profile: kind, paths });
    const ms = Math.round(performance.now() - started);
    check(`${paths.length} paths of ${kind} plan as ${paths.length} straight runs (${ms} ms to plan)`, ok(made) && made.runs === paths.length && made.steps.every((s) => s.kind === (kind === "straight" ? "boolean" : "extrude")), JSON.stringify(ok(made) ? made.runs : made).slice(0, 300));
  }
}

// --- Refusals in a sentence.
{
  const closed = plan({ width: 1, height: 30, profile: "drafted", draftDeg: 2, paths: [{ points: [[-58, 0, 2], [58, 0, 2]] }] });
  check("a draft that closes the rib at its height is refused", !ok(closed) && /a 2° draft closes a 1 mm rib to nothing at the top of its 30 mm height/.test(closed.reason), JSON.stringify(closed));
  const narrow = plan({ width: 1.5, height: 6, profile: "tee", flangeWidth: 1.5, paths: [{ points: [[-58, 0, 2], [58, 0, 2]] }] });
  check("a flange no wider than its web is refused", !ok(narrow) && /flangeWidth \(1.5 mm\) must be wider than its web/.test(narrow.reason), JSON.stringify(narrow));
  const tall = plan({ width: 1.5, height: 3, profile: "tee", paths: [{ points: [[-58, 0, 2], [58, 0, 2]] }] });
  check("a root and flange taller than the rib are refused", !ok(tall) && /need the rib to stand more than 3.85 mm tall; it is 3 mm/.test(tall.reason), JSON.stringify(tall));
  const rootTall = plan({ width: 1.5, height: 2, rootRadius: 3, paths: [{ points: [[-58, 0, 2], [58, 0, 2]] }] });
  check("a root radius larger than the rib is tall is refused", !ok(rootTall) && /a 3 mm root needs the rib to stand more than 3.1 mm tall/.test(rootTall.reason), JSON.stringify(rootTall));
  const ledge = plan({ width: 1.2, height: 4, rootRadius: 0.6, paths: [{ points: [[59, -30, 30], [59, 30, 30]] }] });
  check("a root wider than the rim it stands on is refused", !ok(ledge) && /footprint \(its 0.6 mm root\) runs off the wall there/.test(ledge.reason), JSON.stringify(ledge));
  const besides = plan({ width: 1.5, height: 6, profile: "tee", paths: [{ points: [[-40, 37, 2], [40, 37, 2]] }] });
  check("a flange that would run into a side wall beside the rib is refused", !ok(besides) && /a face stands 1 mm beside the rib at its flange/.test(besides.reason), JSON.stringify(besides));
  const unknown = plan({ width: 1.5, height: 6, profile: "round", paths: [{ points: [[-58, 0, 2], [58, 0, 2]] }] });
  check("an unknown profile is refused", !ok(unknown) && /profile is "straight", "drafted" or "tee"/.test(unknown.reason), JSON.stringify(unknown));
  const perPath = plan({ width: 1.5, height: 6, paths: [{ points: [[-58, 0, 2], [58, 0, 2]], profile: "drafted", draftDeg: 20 }] });
  check("a path's own draft out of range is refused with its path", !ok(perPath) && /^Path 1: draftDeg is the draft of each side of a drafted rib, from 0 to 15°/.test(perPath.reason), JSON.stringify(perPath));
}

// --- Profiles: the same op gives the same plan.
{
  const op = { width: 1.2, height: 5, profile: "tee", paths: [{ points: [[-40, -20, 2], [10, 25, 2], [40, -10, 2]] }, { points: [[-58, 10, 2], [58, 10, 2]], profile: "drafted" }] };
  const a = JSON.stringify(plan(op));
  const b = JSON.stringify(plan(JSON.parse(JSON.stringify(op)) as Record<string, unknown>, shellBox()));
  check("a profiled plan is the same every time", a === b && a.includes("sections") && a.includes("extrude"));
}

if (failed > 0) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("rib-net: ok");
process.exit(0);
