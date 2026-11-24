// A sweep along a path, as the loft sections that make it: each section on the plane square to the path, turned so its
// U axis follows the one before it (no twist), with V toward `up` at the start. The engine lofts through them.

import { orientEuler } from "../mesh-place.ts";
import type { LoftSection } from "../model-tree.ts";

type V3 = [number, number, number];

/** The engine lofts through at most this many sections. */
export const MAX_SECTIONS = 200;

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const length = (a: V3): number => Math.hypot(a[0], a[1], a[2]);
const unit = (a: V3): V3 => mul(a, 1 / (length(a) || 1));
const round = (n: number): number => Math.round(n * 1e6) / 1e6;

export interface SweepSpec {
  path: V3[];
  /** A circle's radius, one for the whole path or one per path point. */
  radius?: number | number[];
  /** With radius, an ellipse: this radius along V (toward `up`). */
  radiusV?: number | number[];
  /** A closed outline of [u, v] points instead of a circle, centred on the path, with V toward `up`. */
  profile?: [number, number][];
  /** The profile's size along the path: one factor, or one per path point. */
  scale?: number | number[];
  smooth?: boolean;
  corners?: number[];
  /** Where V points at the start of the path. Defaults to +Z, or +Y when the path starts straight up or down. */
  up?: V3;
  /** Sections between two path points, through a smooth curve: 1 keeps only the points themselves. */
  steps?: number;
  /** How the ends close: flat (the end section), round (a dome), or point (a short taper to a tip). */
  caps?: Cap;
  capStart?: Cap;
  capEnd?: Cap;
}

export type Cap = "flat" | "round" | "point";
const CAPS: readonly Cap[] = ["flat", "round", "point"];

/** A section shrunk by `k` about its centre: its radii, or its profile. */
function shrunk(section: LoftSection, k: number): LoftSection {
  const out: LoftSection = { origin: section.origin, turn: section.turn };
  if (section.radius !== undefined) {
    out.radius = round(Math.max(section.radius * k, 1e-3));
    if (section.radiusV !== undefined) out.radiusV = round(Math.max(section.radiusV * k, 1e-3));
  } else {
    out.profile = (section.profile ?? []).map(([pu, pv]) => [round(pu * k), round(pv * k)]);
    if (section.smooth) out.smooth = true;
    if (section.corners?.length) out.corners = [...section.corners];
  }
  return out;
}

/** How far a section reaches from its centre, on average across its two directions. */
function sectionSize(section: LoftSection): number {
  if (section.radius !== undefined) return (section.radius + (section.radiusV ?? section.radius)) / 2;
  return sectionReach(section.profile ?? []);
}

/**
 * The sections that close one end: a round cap as four sections shrinking along a quarter ellipse as deep as the end
 * is wide, a point as one tiny section a little past the end. `out` is the direction away from the sweep.
 */
function capSections(end: LoftSection, out: V3, cap: Cap): LoftSection[] {
  if (cap === "flat") return [];
  const size = sectionSize(end);
  const at = (d: number): V3 => end.origin.map((c, i) => round(c + out[i]! * d)) as V3;
  if (cap === "point") return [{ ...shrunk(end, 0.05), origin: at(size * 0.9) }];
  return [1, 2, 3, 4].map((j) => {
    const angle = (j / 4) * (Math.PI / 2);
    // The last section stays a sixth of the end's size: smaller pinches the loft's tip into a dimple.
    return { ...shrunk(end, Math.max(Math.cos(angle), 0.15)), origin: at(size * Math.sin(angle) * (j === 4 ? 0.97 : 1)) };
  });
}

/** A value for each path point: one number, a one-element list of that number, or a list as long as the path. */
function perPoint(value: number | number[] | undefined, count: number, name: string): number[] | { reason: string } | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number") return Array.from({ length: count }, () => value);
  if (Array.isArray(value) && value.length === 1 && typeof value[0] === "number" && Number.isFinite(value[0])) return Array.from({ length: count }, () => value[0]);
  if (!Array.isArray(value) || value.length !== count || !value.every((n) => typeof n === "number" && Number.isFinite(n))) {
    return { reason: `${name} is one number, a one-element list of that number, or a list with one number for each of the ${count} path points.` };
  }
  return value;
}

/** The path is not a straight line: three or more points, and one of them leaves the line through the first two. */
export function pathBends(path: readonly V3[]): boolean {
  if (path.length < 3 || path.some((point) => point.length !== 3 || !point.every((n) => typeof n === "number" && Number.isFinite(n)))) return false;
  const a = sub(path[1]!, path[0]!);
  const span = length(a);
  if (span < 1e-9) return false;
  for (let i = 2; i < path.length; i += 1) {
    const b = sub(path[i]!, path[0]!);
    if (length(cross(a, b)) > 1e-4 * span * Math.max(length(b), 1e-9)) return true;
  }
  return false;
}

const SPINE_FORM = "sweep it as sections along a spine: sections: [{origin, turn, profile}], spine: {kind: \"spline\", through: [the path points]}.";

/**
 * A bending path and a profile, as the pipe-shell a sections-and-spine sweep uses: one section at the start, oriented
 * the way the loft sections are, and a spline through the path. Round and point caps have no pipe form, so they are
 * refused with the spine form to type instead.
 */
export function bendingPathSweep(spec: SweepSpec): { sections: LoftSection[]; spine: { kind: "spline"; through: V3[] }; scale?: [number, number][] } | { reason: string } {
  const path = spec.path;
  if (!Array.isArray(path) || path.length < 2) return { reason: "A sweep needs a path of at least 2 [x, y, z] points." };
  const cap = (["caps", "capStart", "capEnd"] as const).map((key) => spec[key]).find((value) => value === "round" || value === "point");
  if (cap) return { reason: `A path with a bend cannot close with ${cap} caps; ${SPINE_FORM}` };
  const profile = spec.profile;
  if (!Array.isArray(profile) || profile.length < 3 || profile.some((point) => !Array.isArray(point) || point.length < 2 || !point.every((n) => typeof n === "number" && Number.isFinite(n)))) {
    return { reason: "A profile needs at least three [u, v] points." };
  }
  const scale = perPoint(spec.scale ?? 1, path.length, "scale");
  if (scale && "reason" in scale) return scale;
  if (scale!.some((value) => !(value > 0))) return { reason: "Each radius and scale is above 0." };
  const raw = sub(path[1]!, path[0]!);
  if (length(raw) < 1e-4) return { reason: "Path points 0 and 1 are in the same place." };
  const tangent = unit(raw);
  let up: V3 = spec.up ? unit(spec.up) : [0, 0, 1];
  if (Math.abs(dot(up, tangent)) > 0.95) up = Math.abs(tangent[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = unit(cross(up, tangent));
  const v = cross(tangent, u);
  const turn = orientEuler([u[0], v[0], tangent[0], u[1], v[1], tangent[1], u[2], v[2], tangent[2]]);
  const constant = scale!.every((value) => value === scale![0]);
  const factor = constant ? scale![0]! : 1;
  const section: LoftSection = {
    origin: path[0]!.map(round) as V3,
    turn: [round(turn.rx), round(turn.ry), round(turn.rz)],
    profile: profile.map(([pu, pv]) => [round(pu * factor), round(pv * factor)]),
  };
  if (spec.smooth) section.smooth = true;
  if (spec.smooth && spec.corners?.length) section.corners = [...spec.corners];
  let stations: [number, number][] | undefined;
  if (!constant) {
    const cum = [0];
    for (let i = 1; i < path.length; i += 1) cum.push(cum[i - 1]! + length(sub(path[i]!, path[i - 1]!)));
    const total = cum[cum.length - 1]! || 1;
    stations = cum.map((at, i) => [round(at / total), scale![i]!]);
  }
  return { sections: [section], spine: { kind: "spline", through: path.map((point) => point.map(round) as V3) }, ...(stations && stations.length >= 2 ? { scale: stations } : {}) };
}

/** Centripetal Catmull-Rom through the points, `steps` samples per span, with each value list carried along linearly. */
function densify(points: V3[], values: number[][], steps: number): { points: V3[]; values: number[][] } {
  if (steps <= 1 || points.length < 3) return { points, values };
  const out: V3[] = [];
  const outValues: number[][] = values.map(() => []);
  const at = (i: number): V3 => {
    if (i < 0) return sub(mul(points[0]!, 2), points[1]!);
    if (i >= points.length) return sub(mul(points[points.length - 1]!, 2), points[points.length - 2]!);
    return points[i]!;
  };
  for (let i = 0; i < points.length - 1; i += 1) {
    const p0 = at(i - 1);
    const p1 = at(i);
    const p2 = at(i + 1);
    const p3 = at(i + 2);
    const knot = (a: V3, b: V3) => Math.sqrt(length(sub(b, a))) || 1e-9;
    const t1 = knot(p0, p1);
    const t2 = t1 + knot(p1, p2);
    const t3 = t2 + knot(p2, p3);
    for (let k = 0; k < steps; k += 1) {
      const f = k / steps;
      const t = t1 + (t2 - t1) * f;
      const lerp = (a: V3, b: V3, ta: number, tb: number): V3 => add(mul(a, (tb - t) / (tb - ta)), mul(b, (t - ta) / (tb - ta)));
      const a1 = lerp(p0, p1, 0, t1);
      const a2 = lerp(p1, p2, t1, t2);
      const a3 = lerp(p2, p3, t2, t3);
      const b1 = lerp(a1, a2, 0, t2);
      const b2 = lerp(a2, a3, t1, t3);
      out.push(lerp(b1, b2, t1, t2));
      values.forEach((list, v) => outValues[v]!.push(list[i]! + (list[i + 1]! - list[i]!) * f));
    }
  }
  out.push(points[points.length - 1]!);
  values.forEach((list, v) => outValues[v]!.push(list[list.length - 1]!));
  return { points: out, values: outValues };
}

/** The sections a sweep lofts through, in the frame its path is given in. */
export function sweepSections(spec: SweepSpec): LoftSection[] | { reason: string } {
  const path = spec.path;
  if (!Array.isArray(path) || path.length < 2) return { reason: "A sweep needs a path of at least 2 [x, y, z] points." };
  if (path.some((p) => !Array.isArray(p) || p.length !== 3 || !p.every((n) => typeof n === "number" && Number.isFinite(n)))) {
    return { reason: "Each path point is [x, y, z] in millimetres." };
  }
  for (let i = 1; i < path.length; i += 1) {
    if (length(sub(path[i]!, path[i - 1]!)) < 1e-4) return { reason: `Path points ${i - 1} and ${i} are in the same place.` };
  }
  const circle = spec.profile === undefined;
  if (circle && spec.radius === undefined) return { reason: "A sweep needs a radius, or a profile." };
  if (!circle && spec.radius !== undefined) return { reason: "A sweep takes a radius or a profile, not both." };
  const n = path.length;
  const radius = perPoint(spec.radius, n, "radius");
  const radiusV = perPoint(spec.radiusV, n, "radiusV");
  const scale = perPoint(spec.scale ?? 1, n, "scale");
  for (const list of [radius, radiusV, scale]) if (list && "reason" in list) return list;
  const lists = [radius, radiusV, scale] as (number[] | undefined)[];
  if (lists.some((list) => list && list.some((v) => !(v > 0)))) return { reason: "Each radius and scale is above 0." };
  for (const key of ["caps", "capStart", "capEnd"] as const) {
    if (spec[key] !== undefined && !CAPS.includes(spec[key]!)) return { reason: `${key} is flat, round, or point.` };
  }
  const capStart = spec.capStart ?? spec.caps ?? "flat";
  const capEnd = spec.capEnd ?? spec.caps ?? "flat";
  const steps = spec.steps === undefined ? 3 : Math.round(spec.steps);
  if (!(steps >= 1 && steps <= 12)) return { reason: "steps is 1 to 12 sections a span." };
  const carried = lists.map((list) => list ?? Array.from({ length: n }, () => 0));
  const dense = densify(path as V3[], carried, steps);
  if (dense.points.length > MAX_SECTIONS) {
    return { reason: `This sweep makes ${dense.points.length} sections; the most is ${MAX_SECTIONS}. Use fewer path points or a lower steps.` };
  }
  const pts = dense.points;
  const tangent = (i: number): V3 => unit(sub(pts[Math.min(i + 1, pts.length - 1)]!, pts[Math.max(i - 1, 0)]!));
  // Start V toward `up`, square to the path; then carry U along, each time squared to the new tangent.
  const t0 = tangent(0);
  let up: V3 = spec.up ? unit(spec.up as V3) : [0, 0, 1];
  if (Math.abs(dot(up, t0)) > 0.95) up = spec.up ? (Math.abs(t0[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]) : [0, 1, 0];
  let u = unit(cross(up, t0));
  const sections: LoftSection[] = [];
  for (let i = 0; i < pts.length; i += 1) {
    const w = tangent(i);
    if (i > 0) {
      const squared = sub(u, mul(w, dot(u, w)));
      if (length(squared) < 1e-6) return { reason: `The path doubles back on itself near point ${pts[i]!.map(round).join(", ")}.` };
      u = unit(squared);
    }
    const v = cross(w, u);
    const turn = orientEuler([u[0], v[0], w[0], u[1], v[1], w[1], u[2], v[2], w[2]]);
    const origin = pts[i]!.map(round) as V3;
    const section: LoftSection = { origin, turn: [round(turn.rx), round(turn.ry), round(turn.rz)] };
    if (circle) {
      section.radius = round(dense.values[0]![i]!);
      if (radiusV) section.radiusV = round(dense.values[1]![i]!);
    } else {
      const k = dense.values[2]![i]!;
      section.profile = spec.profile!.map(([pu, pv]) => [round(pu * k), round(pv * k)]);
      if (spec.smooth) section.smooth = true;
      if (spec.smooth && spec.corners?.length) section.corners = [...spec.corners];
    }
    sections.push(section);
  }
  // Ends closed past the path's ends, along its direction there, so the path's own length is kept.
  const startCap = capSections(sections[0]!, mul(tangent(0), -1), capStart).reverse();
  const endCap = capSections(sections[sections.length - 1]!, tangent(pts.length - 1), capEnd);
  if (sections.length + startCap.length + endCap.length > MAX_SECTIONS) {
    return { reason: `This sweep and its caps make more than ${MAX_SECTIONS} sections. Use fewer path points or a lower steps.` };
  }
  sections.unshift(...startCap);
  sections.push(...endCap);
  // A bend tighter than the section is wide folds the loft through itself.
  for (let i = 1; i < pts.length - 1; i += 1) {
    const a = sub(pts[i]!, pts[i - 1]!);
    const b = sub(pts[i + 1]!, pts[i]!);
    const turnAngle = Math.acos(Math.max(-1, Math.min(1, dot(unit(a), unit(b)))));
    const span = Math.min(length(a), length(b));
    const bendRadius = turnAngle > 1e-6 ? span / (2 * Math.sin(turnAngle / 2)) : Infinity;
    const size = circle ? Math.max(dense.values[0]![i]!, radiusV ? dense.values[1]![i]! : 0) : sectionReach(spec.profile!) * dense.values[2]![i]!;
    if (bendRadius < size * 0.98) {
      return { reason: `The path bends too tightly near (${pts[i]!.map((x) => round(Math.round(x * 100) / 100)).join(", ")}) for a section ${round(size)} mm across its centre: add path points to round the bend, or make the section smaller there.` };
    }
  }
  return sections;
}

/**
 * `count` points spaced evenly along the smooth curve through `points`, each with the curve's direction there: the
 * first at the start, the last at the end (or, with `closed`, the curve back to the start, the last a step short).
 */
export function pathSamples(points: V3[], count: number, closed = false): { point: V3; tangent: V3 }[] | { reason: string } {
  if (!Array.isArray(points) || points.length < 2) return { reason: "A path needs at least 2 [x, y, z] points." };
  if (points.some((p) => !Array.isArray(p) || p.length !== 3 || !p.every((n) => typeof n === "number" && Number.isFinite(n)))) return { reason: "Each path point is [x, y, z] in millimetres." };
  if (!(count >= 1)) return { reason: "A path pattern's count is at least 1." };
  const loop = closed ? [...points, points[0]!] : points;
  const dense = densify(loop, [], 16).points;
  const lengths = [0];
  for (let i = 1; i < dense.length; i += 1) lengths.push(lengths[i - 1]! + length(sub(dense[i]!, dense[i - 1]!)));
  const total = lengths[lengths.length - 1]!;
  if (!(total > 1e-6)) return { reason: "The path has no length." };
  const out: { point: V3; tangent: V3 }[] = [];
  for (let k = 0; k < count; k += 1) {
    const s = count === 1 ? 0 : closed ? (total * k) / count : (total * k) / (count - 1);
    let i = 1;
    while (i < lengths.length - 1 && lengths[i]! < s) i += 1;
    const span = lengths[i]! - lengths[i - 1]! || 1;
    const f = Math.min(1, Math.max(0, (s - lengths[i - 1]!) / span));
    const a = dense[i - 1]!;
    const b = dense[i]!;
    out.push({ point: add(a, mul(sub(b, a), f)).map(round) as V3, tangent: unit(sub(b, a)) });
  }
  return out;
}

/** Points along the smooth curve through `points`, `steps` to each span. */
export function splinePoints(points: V3[], steps: number): V3[] {
  return densify(points, [], steps).points;
}

/** How far a profile reaches from its origin. */
function sectionReach(profile: [number, number][]): number {
  return Math.max(...profile.map(([u, v]) => Math.hypot(u, v)));
}
