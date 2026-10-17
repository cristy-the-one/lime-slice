// A sweep along a path, as the loft sections that make it: each section on the plane square to the path, turned so its
// U axis follows the one before it (no twist), with V toward `up` at the start. The engine lofts through them.

import { orientEuler } from "../src/mesh-place.ts";
import type { LoftSection } from "../src/model-tree.ts";

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
}

/** A value for each path point: one number for all, or a list as long as the path. */
function perPoint(value: number | number[] | undefined, count: number, name: string): number[] | { reason: string } | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number") return Array.from({ length: count }, () => value);
  if (!Array.isArray(value) || value.length !== count || !value.every((n) => typeof n === "number" && Number.isFinite(n))) {
    return { reason: `${name} is one number, or a list with one number for each of the ${count} path points.` };
  }
  return value;
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

/** How far a profile reaches from its origin. */
function sectionReach(profile: [number, number][]): number {
  return Math.max(...profile.map(([u, v]) => Math.hypot(u, v)));
}
