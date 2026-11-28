/**
 * Close a loop picks on a real plate (L3b): a hole beside a click, and coaxial pins that meet.
 * Run: node --experimental-strip-types --no-warnings src/pose-loop-pick.test.ts
 */
import assert from "node:assert/strict";
import { closeLoop, closureGapMm } from "./pose-loops.ts";
import { IDENTITY_POSE, type Affine } from "./model-space.ts";
import type { ParsedSolid } from "./model-reply.ts";
import type { Vec3 } from "./model-tree.ts";
import { turnHinge } from "./pose.ts";
import type { Assembly, Member } from "./assembly.ts";
import { coaxialPinAt, loopPickStatus, pickLoopFace } from "./pose-loop-pick.ts";

const near = (a: readonly number[], b: readonly number[], tol = 1e-6) => a.every((v, i) => Math.abs(v - b[i]!) <= tol);

function ring(radius: number, y: number, n: number): Vec3[] {
  const out: Vec3[] = [];
  for (let i = 0; i < n; i += 1) {
    const a = 2 * Math.PI * i / n;
    out.push([radius * Math.cos(a), y, radius * Math.sin(a)]);
  }
  return out;
}

/** A plate from y = 0 to y = 6 with a hole of radius 4 about Y. Face 0 is the top, face 1 the hole wall. */
function plate(): ParsedSolid {
  const n = 16;
  const top = ring(4, 6, n);
  const positions: number[] = [];
  const triangles: number[] = [];
  const add = (face: number, a: Vec3, b: Vec3, c: Vec3) => { positions.push(...a, ...b, ...c); triangles.push(face); };
  for (let i = 0; i < n; i += 1) {
    const a = top[i]!;
    const b = top[(i + 1) % n]!;
    const mid = 2 * Math.PI * (i + 0.5) / n;
    const outer: Vec3 = [10 * Math.cos(mid), 6, 10 * Math.sin(mid)];
    add(0, a, b, outer);
    const ai = 2 * Math.PI * i / n;
    const bi = 2 * Math.PI * ((i + 1) % n) / n;
    const a0: Vec3 = [4 * Math.cos(ai), 0, 4 * Math.sin(ai)];
    const b0: Vec3 = [4 * Math.cos(bi), 0, 4 * Math.sin(bi)];
    const a1: Vec3 = [4 * Math.cos(ai), 6, 4 * Math.sin(ai)];
    const b1: Vec3 = [4 * Math.cos(bi), 6, 4 * Math.sin(bi)];
    // Outward for a hole points toward the axis.
    add(1, a0, b0, a1);
    add(1, b0, b1, a1);
  }
  const edge = top.flat();
  const decoy = ring(1, 6, n).flat();
  return {
    id: 0, volumeMm3: 1, positions: new Float32Array(positions), triangles: new Uint32Array(triangles),
    faces: [
      { id: 0, areaMm2: 100, normal: [0, 1, 0] },
      { id: 1, areaMm2: 150, surface: "cylinder", radiusMm: 4, axisPoint: [0, 0, 0], axis: [0, 1, 0] },
    ],
    edges: [
      { id: 0, lengthMm: 25, points: new Float32Array(edge) },
      { id: 1, lengthMm: 6, points: new Float32Array(decoy) },
    ],
    fingerprint: null, editable: true,
  };
}

/** The same hole wall, wound so the material is inside: a pin. */
function pin(): ParsedSolid {
  const solid = plate();
  const positions = Array.from(solid.positions);
  const swapped: number[] = [];
  for (let i = 0; i < solid.triangles.length; i += 1) {
    const o = i * 9;
    if (solid.triangles[i] !== 1) { swapped.push(...positions.slice(o, o + 9)); continue; }
    swapped.push(...positions.slice(o, o + 3), ...positions.slice(o + 6, o + 9), ...positions.slice(o + 3, o + 6));
  }
  return { ...solid, positions: new Float32Array(swapped), faces: solid.faces.map((face) => face.id === 1 ? { ...face, radiusMm: 4 } : face) };
}

const solid = plate();
const beside = pickLoopFace(solid, 0, [4.5, 6, 0]);
assert.ok(beside, "a click 0.5 mm outside the hole snaps to it");
assert.equal(beside.kind, "hole");
assert.equal(loopPickStatus(beside.kind, beside.diameterMm, "Link L"), "Hole Ø8 on Link L");
assert.ok(near(beside.at, [0, 3, 0]), `pivot ${beside.at} should be mid-thickness`);
assert.ok(Math.abs(Math.hypot(...beside.axis) - 1) < 1e-9);
assert.ok(Math.abs(Math.abs(beside.axis[1]!) - 1) < 1e-6, "the hole axis is Y");

const inside = pickLoopFace(solid, 0, [0.2, 6, 0]);
assert.ok(inside && inside.kind === "hole" && near(inside.at, [0, 3, 0]) && inside.diameterMm === 8, "inside the hole, the decoy circle that does not bound the face loses");

const onRim = pickLoopFace(solid, 0, [5, 6, 0]);
assert.ok(onRim && near(onRim.at, [0, 3, 0]), "1 mm outside the rim still snaps");
assert.equal(pickLoopFace(solid, 0, [5.2, 6, 0]), null, "1.2 mm outside keeps today's refusal");

const wall = pickLoopFace(solid, 1, [4, 3, 0]);
assert.ok(wall && wall.kind === "hole" && wall.diameterMm === 8 && near(wall.at, [0, 3, 0]), "the hole wall itself is a hole");

const boss = pickLoopFace(pin(), 1, [4, 3, 0]);
assert.ok(boss && boss.kind === "pin" && boss.diameterMm === 8, "a boss wound outward is a pin");
assert.equal(loopPickStatus("pin", 8, "Ram"), "Pin Ø8 on Ram");

// Two holes. The nearer rim wins.
{
  const n = 16;
  const positions: number[] = [];
  const triangles: number[] = [];
  const add = (face: number, a: Vec3, b: Vec3, c: Vec3) => { positions.push(...a, ...b, ...c); triangles.push(face); };
  const edges: { id: number; lengthMm: number; points: Float32Array }[] = [];
  const holeAt = (face: number, cx: number, radius: number) => {
    const pts = ring(radius, 6, n).map((p) => [p[0] + cx, p[1], p[2]] as Vec3);
    edges.push({ id: edges.length, lengthMm: 20, points: new Float32Array(pts.flat()) });
    for (let i = 0; i < n; i += 1) {
      const a = pts[i]!;
      const b = pts[(i + 1) % n]!;
      const mid = 2 * Math.PI * (i + 0.5) / n;
      add(0, a, b, [cx + (radius + 6) * Math.cos(mid), 6, (radius + 6) * Math.sin(mid)]);
      const ai = 2 * Math.PI * i / n;
      const bi = 2 * Math.PI * ((i + 1) % n) / n;
      const a0: Vec3 = [cx + radius * Math.cos(ai), 0, radius * Math.sin(ai)];
      const b0: Vec3 = [cx + radius * Math.cos(bi), 0, radius * Math.sin(bi)];
      const a1: Vec3 = [cx + radius * Math.cos(ai), 6, radius * Math.sin(ai)];
      const b1: Vec3 = [cx + radius * Math.cos(bi), 6, radius * Math.sin(bi)];
      add(face, a0, b0, a1);
      add(face, b0, b1, a1);
    }
  };
  holeAt(1, 0, 4);
  holeAt(2, 20, 3);
  const both: ParsedSolid = {
    id: 0, volumeMm3: 1, positions: new Float32Array(positions), triangles: new Uint32Array(triangles),
    faces: [
      { id: 0, areaMm2: 100, normal: [0, 1, 0] },
      { id: 1, areaMm2: 80, surface: "cylinder", radiusMm: 4, axisPoint: [0, 0, 0], axis: [0, 1, 0] },
      { id: 2, areaMm2: 60, surface: "cylinder", radiusMm: 3, axisPoint: [20, 0, 0], axis: [0, 1, 0] },
    ],
    edges, fingerprint: null, editable: true,
  };
  const right = pickLoopFace(both, 0, [20, 6, 3.4]);
  assert.ok(right && near(right.at, [20, 3, 0]) && right.diameterMm === 6, `nearest hole ${right && JSON.stringify(right)}`);
}

// A polygonal hole, the way the can-press link is extruded: no analytic cylinder, and no single edge is long enough to fit.
{
  const n = 16;
  const positions: number[] = [];
  const triangles: number[] = [];
  const add = (face: number, a: Vec3, b: Vec3, c: Vec3) => { positions.push(...a, ...b, ...c); triangles.push(face); };
  const edges: { id: number; lengthMm: number; points: Float32Array }[] = [];
  for (let i = 0; i < n; i += 1) {
    const a0 = 2 * Math.PI * i / n;
    const a1 = 2 * Math.PI * ((i + 1) % n) / n;
    const innerA: Vec3 = [4 * Math.cos(a0), 6, 4 * Math.sin(a0)];
    const innerB: Vec3 = [4 * Math.cos(a1), 6, 4 * Math.sin(a1)];
    const outerA: Vec3 = [10 * Math.cos(a0), 6, 10 * Math.sin(a0)];
    const outerB: Vec3 = [10 * Math.cos(a1), 6, 10 * Math.sin(a1)];
    add(0, innerA, innerB, outerB);
    add(0, innerA, outerB, outerA);
    edges.push({ id: i, lengthMm: 1, points: new Float32Array([...innerA, ...innerB]) });
  }
  add(1, [0, 0, 0], [1, 0, 0], [0, 0, 1]);
  const faceted: ParsedSolid = {
    id: 0, volumeMm3: 1, positions: new Float32Array(positions), triangles: new Uint32Array(triangles),
    faces: [{ id: 0, areaMm2: 100, normal: [0, 1, 0] }, { id: 1, areaMm2: 1, normal: [0, -1, 0] }],
    edges, fingerprint: null, editable: true,
  };
  const snapped = pickLoopFace(faceted, 0, [4.5, 6, 0]);
  assert.ok(snapped && snapped.kind === "hole" && near(snapped.at, [0, 3, 0], 1e-6) && Math.abs(snapped.diameterMm - 8) < 1e-6, `faceted hole ${snapped && JSON.stringify(snapped)}`);
  assert.equal(loopPickStatus(snapped!.kind, snapped!.diameterMm, "Link L"), "Hole Ø8 on Link L");
  assert.equal(pickLoopFace(faceted, 0, [5.2, 6, 0]), null, "a faceted plate still refuses a click 1.2 mm outside the hole");
}

const id = IDENTITY_POSE;
const linkAt: Vec3 = [0, 36.5, 200];
const ramAt: Vec3 = [0, 0, 200];
const foot = coaxialPinAt({ at: linkAt, axis: [0, 1, 0] }, id, { at: ramAt, axis: [0, 1, 0] }, id);
assert.ok(foot, "coaxial cylinders 36.5 mm apart along one axis store the foot");
assert.ok(near(foot, linkAt), `foot ${foot}`);

const shifted: Affine = { m: id.m, t: [0.2, 0, 0] };
const shiftedFoot = coaxialPinAt({ at: linkAt, axis: [0, 1, 0] }, id, { at: ramAt, axis: [0, 1, 0] }, shifted);
assert.ok(shiftedFoot && near(shiftedFoot, [0, 36.5, 200]), `foot in the shifted frame ${shiftedFoot}`);

const anti = coaxialPinAt({ at: linkAt, axis: [0, 1, 0] }, id, { at: ramAt, axis: [0, -1, 0] }, id);
assert.ok(anti && near(anti, linkAt), "an opposite axis is still the same line");

const deg = Math.PI / 180;
const tilt = (degrees: number): Vec3 => [Math.sin(degrees * deg), Math.cos(degrees * deg), 0];
assert.ok(coaxialPinAt({ at: [0, 0, 0], axis: [0, 1, 0] }, id, { at: [0, 0, 0], axis: tilt(1) }, id), "1° is within the parallel test");
assert.equal(coaxialPinAt({ at: [0, 0, 0], axis: [0, 1, 0] }, id, { at: [0, 0, 0], axis: tilt(1.5) }, id), null, "1.5° is not parallel");
assert.ok(coaxialPinAt({ at: linkAt, axis: [0, 1, 0] }, id, { at: [0.5, 0, 200], axis: [0, 1, 0] }, id), "0.5 mm apart still counts");
assert.equal(coaxialPinAt({ at: linkAt, axis: [0, 1, 0] }, id, { at: [0.6, 0, 200], axis: [0, 1, 0] }, id), null, "0.6 mm apart does not");

const frame: Member = { object: "frame", parent: null, offset: [0, 0, 0], turn: [0, 0, 0] };
const rest = (object: string): Member => ({ object, parent: "frame", offset: [0, 0, 0], turn: [0, 0, 0], joint: { kind: "hinge", pivot: [0, 0, 0], axis: [0, -1, 0], angle: 0, min: -360, max: 360 } });
const link = turnHinge(rest("link"), 0);
const ram = turnHinge(rest("ram"), 0);
if ("reason" in link || "reason" in ram) throw new Error("hinge");
const assembly: Assembly = { id: "p", name: "p", members: [frame, link, ram] };
const names = (name: string) => name;
const poseOf = () => id;
const refused = closeLoop(assembly, { member: "link", at: linkAt, to: "ram", toAt: ramAt }, names, poseOf);
assert.ok("reason" in refused, "the two midpoints, 36.5 mm apart on one axis, cannot close");
const closed = closeLoop(assembly, { member: "link", at: linkAt, to: "ram", toAt: foot, along: [0, 1, 0] }, names, poseOf);
assert.ok(!("reason" in closed), "reason" in closed ? closed.reason : "");
assert.ok(closureGapMm(closed.assembly, poseOf) <= 0.01, `line gap ${"reason" in closed ? "" : closureGapMm(closed.assembly, poseOf)}`);
const pinned = closeLoop(assembly, { member: "link", at: linkAt, to: "ram", toAt: foot }, names, poseOf);
assert.ok(!("reason" in pinned) && closureGapMm(pinned.assembly, poseOf) <= 0.01);

console.log("pose loop pick: coaxial foot and hole snap ok");
