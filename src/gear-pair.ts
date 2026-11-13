/**
 * External spur gears on parallel axes: the same verdict as `lime_recipe::gear_pair` (`docs/collision-prototype.md`).
 * Tip circles first, then the working centre distance and the mating phase, then a segment test on the tooth outline
 * `Gear::points` builds. The window and `model_check` both call this. It does not move an assembly joint.
 */

import type { Affine } from "./model-space.ts";
import { applyPose, IDENTITY_POSE } from "./model-space.ts";
import type { PrimitiveSpec } from "./model-primitive.ts";
import { pathTo, type ModelTree, type Vec3 } from "./model-tree.ts";

/** Steps along each fillet and each involute. The same count the recipe uses. */
const PAIR_FLANK = 8;
const PI = Math.PI;

export type GearVerdict = "apart" | "meshing" | "tooClose" | "toothOnTooth" | "moduleMismatch" | "pressureMismatch";

export interface PairReport {
  verdict: GearVerdict;
  /** Whether the tooth outlines were compared. False when the tip circles do not meet, or the pair is not a mesh. */
  narrow: boolean;
  /** Whether two tooth edges crossed. */
  hit: boolean;
}

/** The numbers `Gear` carries. Backlash is millimetres at the pitch circle; shift is times the module. */
export interface Spur {
  teeth: number;
  module: number;
  pressureDeg: number;
  backlash: number;
  shift: number;
}

type P2 = [number, number];
type Polar = [number, number];

export interface WorldGear {
  objectId: string;
  /** What the card and `model_check` call it. */
  label: string;
  /** Null when the gear is the object's own solid. A number is a gear step on that solid. */
  step: number | null;
  spur: Spur;
  /** Middle of the axis. */
  centre: Vec3;
  /** Unit axis, the way the teeth turn about. */
  axis: Vec3;
  /** Unit direction of tooth 0, in the plane of the gear. */
  tooth0: Vec3;
  thickness: number;
}

export interface GearPairRow {
  a: string;
  b: string;
  names: [string, string];
  verdict: GearVerdict;
  narrow: boolean;
  hit: boolean;
  /** Present when either gear is a step rather than the object's own solid. Null is that solid. */
  steps?: [number | null, number | null];
}

function clear(verdict: GearVerdict): PairReport {
  return { verdict, narrow: false, hit: false };
}

function pitchRadius(gear: Spur): number {
  return (gear.module * gear.teeth) / 2;
}

function tipRadius(gear: Spur): number {
  return pitchRadius(gear) + gear.module * (1 + gear.shift);
}

function rootRadius(gear: Spur): number {
  return pitchRadius(gear) - gear.module * (1.25 - gear.shift);
}

function pitchDeg(gear: Spur): number {
  return 360 / gear.teeth;
}

/** Working centre distance, including profile shift. Zero shift is the sum of the pitch radii. */
function centreDistance(a: Spur, b: Spur): number {
  const a0 = pitchRadius(a) + pitchRadius(b);
  const x = a.shift + b.shift;
  if (x === 0) return a0;
  const rad = (a.pressureDeg * PI) / 180;
  const sa = Math.sin(rad);
  const ca = Math.cos(rad);
  const tanA = sa / ca;
  const target = tanA - Math.atan(tanA) + (2 * tanA * x) / (a.teeth + b.teeth);
  let w = rad;
  for (let i = 0; i < 40; i += 1) {
    const s = Math.sin(w);
    const c = Math.cos(w);
    const t = s / c;
    w -= (t - w - target) / (t * t);
  }
  return (a0 * ca) / Math.cos(w);
}

function matePhase(ownPhase: number, ownZ: number, dir: number, mateZ: number): number {
  const ownPitch = 360 / ownZ;
  const f = ((((dir - ownPhase) / ownPitch) % 1) + 1) % 1;
  return dir + 180 - (0.5 - f) * (360 / mateZ);
}

function mateTurn(ownTurn: number, ownZ: number, mateZ: number): number {
  return (-ownTurn * ownZ) / mateZ;
}

function bearingDeg(a: P2, b: P2): number {
  return (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / PI;
}

function span(a: P2, b: P2): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

/** Phase error inside half a tooth. A whole tooth looks the same, and `mate_phase` jumps by one when its fraction wraps. */
function toothErrDeg(delta: number, pitch: number): number {
  if (!(pitch > 0)) return delta;
  let d = delta % pitch;
  const half = pitch / 2;
  if (d > half) d -= pitch;
  else if (d < -half) d += pitch;
  return d;
}

function orient(a: P2, b: P2, c: P2): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function segmentsCross(a: P2, b: P2, c: P2, d: P2): boolean {
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  return o1 * o2 < 0 && o3 * o4 < 0;
}

function boxesApart(a: P2, b: P2, c: P2, d: P2): boolean {
  const ax0 = Math.min(a[0], b[0]);
  const ax1 = Math.max(a[0], b[0]);
  const ay0 = Math.min(a[1], b[1]);
  const ay1 = Math.max(a[1], b[1]);
  const bx0 = Math.min(c[0], d[0]);
  const bx1 = Math.max(c[0], d[0]);
  const by0 = Math.min(c[1], d[1]);
  const by1 = Math.max(c[1], d[1]);
  return ax1 < bx0 || bx1 < ax0 || ay1 < by0 || by1 < ay0;
}

function outlinesCross(driver: P2[], driven: P2[]): boolean {
  const an = driver.length;
  const dn = driven.length;
  if (an < 2 || dn < 2) return false;
  for (let i = 0; i < an; i += 1) {
    const a = driver[i]!;
    const b = driver[(i + 1) % an]!;
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 1e-12) continue;
    for (let j = 0; j < dn; j += 1) {
      const c = driven[j]!;
      const d = driven[(j + 1) % dn]!;
      if (Math.hypot(d[0] - c[0], d[1] - c[1]) < 1e-12) continue;
      if (!boxesApart(a, b, c, d) && segmentsCross(a, b, c, d)) return true;
    }
  }
  return false;
}

function polar(rho: number, angle: number): P2 {
  return [rho * Math.cos(angle), rho * Math.sin(angle)];
}

function psi(gear: Spur): number {
  const rad = (gear.pressureDeg * PI) / 180;
  const z = gear.teeth;
  return PI / (2 * z) + (2 * gear.shift * Math.tan(rad)) / z - gear.backlash / (2 * pitchRadius(gear));
}

type Piece = { pts: Polar[] };

/**
 * One flank, in polar `(radius, half-angle)`, as `Gear::side_with` builds it. Null when these numbers are not a gear.
 * The sampling matches the recipe's outline, including the undercut a small gear is cut with.
 */
function flank(gear: Spur, steps: number): Piece[] | null {
  if (!Number.isInteger(gear.teeth) || gear.teeth < 6 || gear.teeth > 150) return null;
  if (!(gear.module >= 0.05 && gear.module <= 50)) return null;
  if (!(gear.pressureDeg >= 10 && gear.pressureDeg <= 30)) return null;
  if (!(gear.shift >= -1 && gear.shift <= 1)) return null;
  if (!(gear.backlash >= 0 && gear.backlash <= gear.module)) return null;
  const rad = (gear.pressureDeg * PI) / 180;
  const sa = Math.sin(rad);
  const ca = Math.cos(rad);
  const tanA = sa / ca;
  const m = gear.module;
  const r = pitchRadius(gear);
  const rb = r * ca;
  const ra = tipRadius(gear);
  const rf = rootRadius(gear);
  const invA = tanA - Math.atan(tanA);
  const halfTooth = psi(gear);
  const invHalf = (rho: number) => {
    const t = Math.sqrt(Math.max(0, rho * rho - rb * rb)) / rb;
    return halfTooth + invA - (t - Math.atan(t));
  };
  if (invHalf(ra) <= 0) return null;
  const wTip = (PI * m) / 4 + gear.backlash / 2 - 1.25 * m * tanA;
  const round = Math.max(0, Math.min(0.38 * m, m * (1.2 - gear.shift), (0.95 * wTip * ca) / (1 - sa)));
  const xc = rf + round;
  const yc = (PI * m) / 2 - wTip + (round * (1 - sa)) / ca;
  const reach = r - xc;
  const seen = (p: P2, s: number): Polar => {
    const sn = Math.sin(s);
    const cs = Math.cos(s);
    const g: P2 = [p[0] * cs - p[1] * sn, p[0] * sn + p[1] * cs];
    return [Math.hypot(g[0], g[1]), Math.atan2(g[1], g[0])];
  };
  const filletAt = (s: number): Polar => {
    const c: P2 = [xc, yc - r * s];
    const d: P2 = [c[0] - r, c[1]];
    const len = Math.hypot(d[0], d[1]);
    const q: P2 = len > 0 ? [c[0] + (round * d[0]) / len, c[1] + (round * d[1]) / len] : [xc - round, c[1]];
    return seen(q, s);
  };
  const lowAt = (s: number): Polar => seen([xc - round * sa, yc - r * s - round * ca], s);
  const sRoot = yc / r;
  const sLow = (yc + (reach * ca) / sa) / r;
  const depth = r - (xc - round * sa);
  const tForm = (r * sa - depth / sa) / rb;
  const sample = (f: (s: number) => Polar, s0: number, s1: number): Polar[] => {
    const out: Polar[] = [];
    for (let i = 0; i <= steps; i += 1) out.push(f(s0 + ((s1 - s0) * i) / steps));
    return out;
  };
  const involuteFrom = (rho0: number, rho1: number): Polar[] => {
    const tOf = (rho: number) => Math.sqrt(Math.max(0, rho * rho - rb * rb)) / rb;
    const t0 = tOf(rho0);
    const t1 = tOf(rho1);
    const out: Polar[] = [];
    for (let i = 0; i <= steps; i += 1) {
      const t = t0 + ((t1 - t0) * i) / steps;
      const rho = i === 0 ? rho0 : i === steps ? rho1 : rb * Math.sqrt(1 + t * t);
      out.push([rho, halfTooth + invA - (t - Math.atan(t))]);
    }
    return out;
  };
  const pieces: Piece[] = [];
  let seam = 0;
  const join = (next: Polar[]) => {
    const last = pieces[pieces.length - 1];
    if (last && next[0]) {
      const n = last.pts.length - 1;
      const end = last.pts[n] ?? [0, 0];
      const a = polar(end[0], end[1]);
      const b = polar(next[0][0], next[0][1]);
      seam = Math.max(seam, Math.hypot(a[0] - b[0], a[1] - b[1]));
      last.pts[n] = [next[0][0], next[0][1]];
    }
    pieces.push({ pts: next });
  };
  if (tForm > 0) {
    const form = rb * Math.sqrt(1 + tForm * tForm);
    if (sLow > sRoot) join(sample(filletAt, sRoot, sLow));
    else if (form > rf + 1e-9) join([[rf, invHalf(form)], [form, invHalf(form)]]);
    join(involuteFrom(form, ra));
  } else {
    const path = (s: number) => (s <= sLow ? filletAt(s) : lowAt(s));
    const gap = (s: number) => {
      const [rho, angle] = path(s);
      return rho < rb ? -1 : angle - invHalf(rho);
    };
    let sEnd = Math.max(sLow, sRoot);
    let step = 0.01;
    while (path(sEnd)[0] < ra && step < 1e3) {
      sEnd += step;
      step *= 1.5;
    }
    const crossings: number[] = [];
    const walk = 600;
    let prevS = sRoot;
    let prevG = -1;
    for (let i = 1; i <= walk; i += 1) {
      const s = sRoot + ((sEnd - sRoot) * i) / walk;
      const g = gap(s);
      if (g < 0 !== prevG < 0) {
        let lo = prevS;
        let hi = s;
        for (let k = 0; k < 90; k += 1) {
          const mid = 0.5 * (lo + hi);
          if (gap(mid) < 0 === prevG < 0) lo = mid;
          else hi = mid;
        }
        crossings.push(hi);
      }
      prevS = s;
      prevG = g;
    }
    if (crossings.length % 2 === 0) return null;
    let from = sRoot;
    for (let k = 0; k < crossings.length; k += 1) {
      const s = crossings[k]!;
      if (k % 2 === 0) {
        const spans: [number, number][] = [
          [from, Math.min(s, sLow)],
          [Math.max(from, sLow), s],
        ];
        for (const [a, b] of spans) {
          if (b > a) join(sample(b <= sLow ? filletAt : lowAt, a, b));
        }
      } else {
        const last = pieces[pieces.length - 1];
        const rho0 = last ? last.pts[last.pts.length - 1]![0] : rb;
        join(involuteFrom(rho0, path(s)[0]));
        from = s;
      }
    }
    const last = pieces[pieces.length - 1];
    const rho0 = last ? last.pts[last.pts.length - 1]![0] : rb;
    if (last) last.pts[last.pts.length - 1] = [rho0, invHalf(rho0)];
    join(involuteFrom(rho0, ra));
  }
  if (!Number.isFinite(seam) || seam > 1e-6 * m) return null;
  if (pieces.some((piece) => piece.pts.some((p) => p[1] <= 0 || p[0] > ra + 1e-9))) return null;
  const first = pieces[0]?.pts[0];
  if (first) first[0] = rf;
  return pieces;
}

/** The outline `Gear::points` returns, tooth 0 on `phaseDeg`. Null when the numbers are not a gear. */
export function gearPoints(gear: Spur, phaseDeg: number, perFlank = PAIR_FLANK): P2[] | null {
  const n = Math.max(2, perFlank);
  const side = flank(gear, n);
  if (!side || side.length === 0) return null;
  const up: Polar[] = [];
  for (const piece of side) {
    const pts = up.length ? piece.pts.slice(1) : piece.pts;
    for (const p of pts) up.push(p);
  }
  const tip = up[up.length - 1];
  const root = up[0];
  if (!tip || !root) return null;
  const z = gear.teeth;
  const rf = rootRadius(gear);
  const pitch = (2 * PI) / z;
  const pts: P2[] = [];
  const arc = (rho: number, a0: number, a1: number) => {
    const steps = Math.max(1, Math.ceil(Math.abs(a1 - a0) / ((3 * PI) / 180)));
    for (let i = 1; i < steps; i += 1) pts.push(polar(rho, a0 + ((a1 - a0) * i) / steps));
  };
  for (let k = 0; k < z; k += 1) {
    const c = ((phaseDeg + pitchDeg(gear) * k) * PI) / 180;
    for (const p of up) pts.push(polar(p[0], c - p[1]));
    arc(tip[0], c - tip[1], c + tip[1]);
    for (let i = up.length - 1; i >= 0; i -= 1) pts.push(polar(up[i]![0], c + up[i]![1]));
    arc(rf, c + root[1], c + pitch - root[1]);
  }
  return pts;
}

function placed(gear: Spur, centre: P2, phaseDeg: number): P2[] | null {
  const local = gearPoints(gear, phaseDeg);
  if (!local) return null;
  return local.map((p) => [p[0] + centre[0], p[1] + centre[1]]);
}

/**
 * Two external spur gears in one plane. Phases are tooth 0 from +U, degrees, in that plane.
 * A driver angle belongs to `drivenTurn`, which applies `mate_turn` and does not add a joint.
 */
export function classify(driver: Spur, driven: Spur, driverAt: P2, drivenAt: P2, driverPhaseDeg: number, drivenPhaseDeg: number): PairReport {
  if (Math.abs(driver.module - driven.module) > 1e-9) return clear("moduleMismatch");
  if (Math.abs(driver.pressureDeg - driven.pressureDeg) > 1e-6) return clear("pressureMismatch");
  const distance = span(driverAt, drivenAt);
  if (distance > tipRadius(driver) + tipRadius(driven) + 1e-9) return clear("apart");
  const a = placed(driver, driverAt, driverPhaseDeg);
  const b = placed(driven, drivenAt, drivenPhaseDeg);
  const working = centreDistance(driver, driven);
  const backlash = driver.backlash + driven.backlash;
  const tooClose = distance + 1e-9 < working - backlash;
  const expect = matePhase(driverPhaseDeg, driver.teeth, bearingDeg(driverAt, drivenAt), driven.teeth);
  const errMm = Math.abs(toothErrDeg(drivenPhaseDeg - expect, pitchDeg(driven))) * (PI / 180) * pitchRadius(driven);
  const quarterMm = pitchRadius(driven) * (pitchDeg(driven) / 4) * (PI / 180);
  const tooth = errMm > quarterMm + 1e-9;
  const pressure = (driver.pressureDeg * PI) / 180;
  const ca = Math.cos(pressure);
  const tanA = ca === 0 ? 0 : Math.sin(pressure) / ca;
  const allowed = backlash / 2 + (distance - working) * tanA;
  const pastPlay = errMm > allowed + 1e-9;
  // The outline cannot be built (Gear refuses these numbers). Not a mesh, and not a new token:
  // toothOnTooth stands in until one is chosen. Too close stays too close.
  if (!a || !b) return { verdict: tooClose ? "tooClose" : "toothOnTooth", narrow: false, hit: false };
  const hit = outlinesCross(a, b);
  const verdict: GearVerdict = tooClose ? "tooClose" : tooth || pastPlay || hit ? "toothOnTooth" : "meshing";
  return { verdict, narrow: true, hit };
}

/** `classify` after the driver turns `angleDeg` and the driven gear turns with it by the tooth ratio. */
export function drivenTurn(driver: Spur, driven: Spur, driverAt: P2, drivenAt: P2, driverPhaseDeg: number, drivenPhaseDeg: number, angleDeg: number): PairReport {
  return classify(driver, driven, driverAt, drivenAt, driverPhaseDeg + angleDeg, drivenPhaseDeg + mateTurn(angleDeg, driver.teeth, driven.teeth));
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function normalize(v: Vec3): Vec3 {
  const len = Math.hypot(v[0], v[1], v[2]);
  return len > 0 ? [v[0] / len, v[1] / len, v[2] / len] : [0, 0, 0];
}

/** `turn` degrees about X, then Y, then Z, as a gear's primitive is turned. */
function euler(v: Vec3, turn: Vec3): Vec3 {
  const rx = (turn[0] * PI) / 180;
  const ry = (turn[1] * PI) / 180;
  const rz = (turn[2] * PI) / 180;
  const sx = Math.sin(rx);
  const cx = Math.cos(rx);
  const sy = Math.sin(ry);
  const cy = Math.cos(ry);
  const sz = Math.sin(rz);
  const cz = Math.cos(rz);
  let x = v[0];
  let y = v[1];
  let z = v[2];
  const y1 = y * cx - z * sx;
  const z1 = y * sx + z * cx;
  y = y1;
  z = z1;
  const x2 = x * cy + z * sy;
  const z2 = -x * sy + z * cy;
  x = x2;
  z = z2;
  return [x * cz - y * sz, x * sz + y * cz, z];
}

function poseDir(pose: Affine, v: Vec3): Vec3 {
  const m = pose.m;
  return [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
}

function spurOf(spec: PrimitiveSpec): Spur | null {
  if (spec.primitive !== "gear") return null;
  const teeth = spec.teeth ?? 0;
  const module = spec.module ?? 0;
  if (!Number.isInteger(teeth) || !(module > 0)) return null;
  return { teeth, module, pressureDeg: spec.pressureDeg ?? 20, backlash: spec.backlash ?? 0.1, shift: spec.profileShift ?? 0 };
}

/** A gear primitive standing at `pose`. Null for any other primitive. */
export function placeGear(spec: PrimitiveSpec, pose: Affine, objectId: string, label: string, step: number | null): WorldGear | null {
  const spur = spurOf(spec);
  if (!spur || !(spec.height > 0)) return null;
  const phase = ((spec.phaseDeg ?? 0) * PI) / 180;
  const local: Vec3 = [spec.origin[0], spec.origin[1], spec.origin[2] + spec.height / 2];
  return {
    objectId,
    label,
    step,
    spur,
    centre: applyPose(pose, local),
    axis: normalize(poseDir(pose, euler([0, 0, 1], spec.turn))),
    tooth0: normalize(poseDir(pose, euler([Math.cos(phase), Math.sin(phase), 0], spec.turn))),
    thickness: spec.height,
  };
}

/** Gears on the current history: the root, when it is a gear, and each fused gear step. */
export function gearsInTree(tree: ModelTree, pose: Affine, objectId: string, objectName: string): WorldGear[] {
  let root: PrimitiveSpec | null = tree.root.kind === "primitive" ? tree.root.solid : null;
  const steps: WorldGear[] = [];
  for (const id of pathTo(tree, tree.current)) {
    const node = tree.nodes.get(id);
    const op = node?.op;
    if (!op) continue;
    if (op.kind === "root") {
      root = op;
      continue;
    }
    if (op.kind === "boolean" && op.primitive === "gear" && op.op === "fuse") {
      const gear = placeGear(op, pose, objectId, node?.name ?? node?.label ?? objectName, id);
      if (gear) steps.push(gear);
    }
  }
  const own = root ? placeGear(root, pose, objectId, objectName, null) : null;
  return own ? [own, ...steps] : steps;
}

/**
 * The pair in the plane of `a`'s axis. Null when the axes are not parallel within a degree, the same way up:
 * a flipped gear is not this check. Slabs that do not overlap along the axis are apart, and the outlines are not built.
 */
export function worldPair(a: WorldGear, b: WorldGear): PairReport | null {
  const aligned = dot(a.axis, b.axis);
  if (!(aligned > Math.cos((1 * PI) / 180))) return null;
  const along = Math.abs(dot([b.centre[0] - a.centre[0], b.centre[1] - a.centre[1], b.centre[2] - a.centre[2]], a.axis));
  if (along >= (a.thickness + b.thickness) / 2 - 1e-6) return clear("apart");
  const helper: Vec3 = Math.abs(a.axis[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = normalize(cross(helper, a.axis));
  const v = normalize(cross(a.axis, u));
  const project = (p: Vec3): P2 => {
    const d: Vec3 = [p[0] - a.centre[0], p[1] - a.centre[1], p[2] - a.centre[2]];
    return [dot(d, u), dot(d, v)];
  };
  const phase = (tooth: Vec3) => (Math.atan2(dot(tooth, v), dot(tooth, u)) * 180) / PI;
  return classify(a.spur, b.spur, [0, 0], project(b.centre), phase(a.tooth0), phase(b.tooth0));
}

/** The mate to show: a meshing gear if there is one, otherwise the nearest gear this check can see. */
export function nearestVerdict(self: WorldGear, others: readonly WorldGear[]): { other: WorldGear; report: PairReport } | null {
  let best: { other: WorldGear; report: PairReport; distance: number } | null = null;
  for (const other of others) {
    if (other.objectId === self.objectId && other.step === self.step && other.objectId !== "") continue;
    const report = worldPair(self, other);
    if (!report) continue;
    const distance = Math.hypot(other.centre[0] - self.centre[0], other.centre[1] - self.centre[1], other.centre[2] - self.centre[2]);
    const meshing = report.verdict === "meshing";
    const bestMeshing = best?.report.verdict === "meshing";
    // A mesh wins over anything else. Every other verdict is ranked by distance, not by plate order.
    const better = !best || (meshing && !bestMeshing) || (meshing === bestMeshing && distance < best.distance);
    if (better) best = { other, report, distance };
  }
  return best ? { other: best.other, report: best.report } : null;
}

/** The sentence on the gear card. */
export function verdictSentence(name: string, verdict: GearVerdict): string {
  switch (verdict) {
    case "meshing":
      return `Meshes with ${name}.`;
    case "apart":
      return `Clear of ${name}.`;
    case "tooClose":
      return `Too close to ${name}.`;
    case "toothOnTooth":
      return `Teeth cross ${name}.`;
    case "moduleMismatch":
      return `Module does not match ${name}.`;
    case "pressureMismatch":
      return `Pressure angle does not match ${name}.`;
  }
}

function pairKey(gear: WorldGear): string {
  return `${gear.objectId}\0${gear.step ?? -1}\0${gear.label}`;
}

/** Every pair that includes `objectId`, in a stable order. Axes that are not parallel are left out. */
export function gearPairRows(gears: readonly WorldGear[], objectId: string): GearPairRow[] {
  const rows: { key: string; row: GearPairRow }[] = [];
  for (let i = 0; i < gears.length; i += 1) {
    for (let j = i + 1; j < gears.length; j += 1) {
      const a = gears[i]!;
      const b = gears[j]!;
      if (a.objectId !== objectId && b.objectId !== objectId) continue;
      const report = worldPair(a, b);
      if (!report) continue;
      const [left, right] = pairKey(a) <= pairKey(b) ? [a, b] : [b, a];
      const row: GearPairRow = {
        a: left.objectId,
        b: right.objectId,
        names: [left.label, right.label],
        verdict: report.verdict,
        narrow: report.narrow,
        hit: report.hit,
      };
      if (left.step !== null || right.step !== null) row.steps = [left.step, right.step];
      rows.push({ key: `${pairKey(left)}\0${pairKey(right)}`, row });
    }
  }
  rows.sort((p, q) => (p.key < q.key ? -1 : p.key > q.key ? 1 : 0));
  return rows.map((entry) => entry.row);
}

/** A gear spec at the origin, for a caller that already placed the primitive in the frame it cares about. */
export function gearAt(spec: PrimitiveSpec, objectId = "", label = ""): WorldGear | null {
  return placeGear(spec, IDENTITY_POSE, objectId, label, null);
}
