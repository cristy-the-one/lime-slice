/**
 * Sketch geometry: intersections, projection, arcs, and spline sampling (`docs/plan-gui-cad-modeling.md`, Plan B §4.2).
 *
 * Pure functions on the plane, in millimetres. Two points within `EPS` are one point, the same
 * margin the kernel uses to close a profile loop. A spline here is a centripetal Catmull-Rom
 * through the controls, close enough to draw; the kernel's own interpolant is what a feature builds.
 */
import { sketchPoint, type Pt, type SketchData, type SketchEntity } from "./model.ts";

export type { Pt };

/** Two points within this are one. Matches the kernel's loop closure. */
export const EPS = 1e-6;

const TAU = Math.PI * 2;

export function dist(a: Pt, b: Pt): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

export function samePt(a: Pt, b: Pt, eps = EPS): boolean {
  return dist(a, b) <= eps;
}

export function sub(a: Pt, b: Pt): Pt {
  return [a[0] - b[0], a[1] - b[1]];
}

export function add(a: Pt, b: Pt): Pt {
  return [a[0] + b[0], a[1] + b[1]];
}

export function scale(a: Pt, k: number): Pt {
  return [a[0] * k, a[1] * k];
}

export function dot(a: Pt, b: Pt): number {
  return a[0] * b[0] + a[1] * b[1];
}

export function cross(a: Pt, b: Pt): number {
  return a[0] * b[1] - a[1] * b[0];
}

export function unit(a: Pt): Pt | null {
  const length = Math.hypot(a[0], a[1]);
  if (length <= EPS) return null;
  return [a[0] / length, a[1] / length];
}

/** Left perpendicular of a unit direction: the positive-offset side of a curve. */
export function leftNormal(dir: Pt): Pt {
  return [-dir[1], dir[0]];
}

export interface Projection {
  pt: Pt;
  distance: number;
  /** 0 at the start of the entity and 1 at the end. A circle is 0 at angle 0, rising counter-clockwise. */
  t: number;
}

/** A three-point arc, or a full-turn seam arc built while tracing regions. */
export interface ArcGeom {
  centre: Pt;
  radius: number;
  /** Angle of the start, radians. */
  a0: number;
  /**
   * Signed sweep to the end, radians. Positive is counter-clockwise.
   * In (−2π, 0) or (0, 2π] so a seam can name a whole circle, and never 0.
   */
  sweep: number;
}

/** The circle through three points, as the arc from `a` through `through` to `b`. Null when the three are collinear or two coincide. */
export function arcFrom3(a: Pt, through: Pt, b: Pt): ArcGeom | null {
  if (samePt(a, through) || samePt(through, b) || samePt(a, b)) return null;
  const a2 = a[0] * a[0] + a[1] * a[1];
  const t2 = through[0] * through[0] + through[1] * through[1];
  const b2 = b[0] * b[0] + b[1] * b[1];
  const det = 2 * (a[0] * (through[1] - b[1]) + through[0] * (b[1] - a[1]) + b[0] * (a[1] - through[1]));
  if (Math.abs(det) <= 1e-12) return null;
  const centre: Pt = [
    (a2 * (through[1] - b[1]) + t2 * (b[1] - a[1]) + b2 * (a[1] - through[1])) / det,
    (a2 * (b[0] - through[0]) + t2 * (a[0] - b[0]) + b2 * (through[0] - a[0])) / det,
  ];
  const radius = dist(centre, a);
  if (!(radius > EPS) || radius > 1e8) return null;
  const a0 = Math.atan2(a[1] - centre[1], a[0] - centre[0]);
  const aT = Math.atan2(through[1] - centre[1], through[0] - centre[0]);
  const aB = Math.atan2(b[1] - centre[1], b[0] - centre[0]);
  const ccw = ccwSweep(a0, aB);
  const throughCcw = ccwSweep(a0, aT);
  // The through point picks the side: the counter-clockwise arc, or the other way.
  const sweep = throughCcw < ccw - 1e-9 ? ccw : ccw - TAU;
  if (Math.abs(sweep) < 1e-9) return null;
  return { centre, radius, a0, sweep };
}

/**
 * The arc that leaves `from` along `dir` and ends at `to`. Null when `to` lies on the tangent
 * line, which would be a straight line rather than an arc. One circle fits a point, a tangent,
 * and another point; the sweep is the one whose start tangent follows `dir`.
 */
export function tangentArc(from: Pt, dir: Pt, to: Pt): ArcGeom | null {
  const direction = unit(dir);
  if (!direction || samePt(from, to)) return null;
  const normal = leftNormal(direction);
  const toward = sub(to, from);
  const denom = 2 * dot(toward, normal);
  if (Math.abs(denom) <= 1e-12) return null;
  const s = dot(toward, toward) / denom;
  const centre = add(from, scale(normal, s));
  const radius = Math.abs(s);
  if (!(radius > EPS) || radius > 1e8) return null;
  const a0 = Math.atan2(from[1] - centre[1], from[0] - centre[0]);
  const a1 = Math.atan2(to[1] - centre[1], to[0] - centre[0]);
  // Travel with the requested tangent: counter-clockwise tangent is (−sin, cos).
  const ccwTangent: Pt = [-Math.sin(a0), Math.cos(a0)];
  const sweep = dot(ccwTangent, direction) >= 0 ? ccwSweep(a0, a1) : ccwSweep(a0, a1) - TAU;
  if (Math.abs(sweep) < 1e-9) return null;
  return { centre, radius, a0, sweep };
}

export function arcPoint(arc: ArcGeom, t: number): Pt {
  const theta = arc.a0 + arc.sweep * t;
  return [arc.centre[0] + arc.radius * Math.cos(theta), arc.centre[1] + arc.radius * Math.sin(theta)];
}

/** Unit tangent in the direction of increasing `t`. */
export function arcTangent(arc: ArcGeom, t: number): Pt {
  const theta = arc.a0 + arc.sweep * t;
  const sign = arc.sweep >= 0 ? 1 : -1;
  return [sign * -Math.sin(theta), sign * Math.cos(theta)];
}

/** Parameter of a point on the arc, or null when it is not on this sweep. */
export function arcParam(arc: ArcGeom, pt: Pt, eps = EPS): number | null {
  const radial = dist(pt, arc.centre);
  if (Math.abs(radial - arc.radius) > Math.max(eps, eps * arc.radius)) return null;
  const angle = Math.atan2(pt[1] - arc.centre[1], pt[0] - arc.centre[0]);
  if (arc.sweep > 0) {
    let delta = angle - arc.a0;
    while (delta < -1e-9) delta += TAU;
    while (delta >= TAU - 1e-12) delta -= TAU;
    if (delta > arc.sweep + 1e-7) return null;
    return arc.sweep === 0 ? null : delta / arc.sweep;
  }
  let delta = angle - arc.a0;
  while (delta > 1e-9) delta -= TAU;
  while (delta <= -TAU + 1e-12) delta += TAU;
  if (delta < arc.sweep - 1e-7) return null;
  return delta / arc.sweep;
}

/** Counter-clockwise sweep from `a0` to `a1`, in (0, 2π]. */
export function ccwSweep(a0: number, a1: number): number {
  let delta = a1 - a0;
  while (delta <= 1e-15) delta += TAU;
  while (delta > TAU) delta -= TAU;
  return delta;
}

/**
 * Where two infinite lines meet. `t` is the parameter on the first (`0` at `a0`, `1` at `a1`),
 * `u` on the second. Null when the lines are parallel.
 */
export function lineLineHit(a0: Pt, a1: Pt, b0: Pt, b1: Pt): { pt: Pt; t: number; u: number } | null {
  const rx = a1[0] - a0[0];
  const ry = a1[1] - a0[1];
  const sx = b1[0] - b0[0];
  const sy = b1[1] - b0[1];
  const den = rx * sy - ry * sx;
  const scaleAbs = Math.hypot(rx, ry) + Math.hypot(sx, sy);
  if (Math.abs(den) <= 1e-12 * Math.max(scaleAbs, 1)) return null;
  const qx = b0[0] - a0[0];
  const qy = b0[1] - a0[1];
  const t = (qx * sy - qy * sx) / den;
  const u = (qx * ry - qy * rx) / den;
  return { pt: [a0[0] + t * rx, a0[1] + t * ry], t, u };
}

/** Intersections of the segment `a0`–`a1` with the segment `b0`–`b1`, including ends and T-junctions. */
export function segmentSegmentHits(a0: Pt, a1: Pt, b0: Pt, b1: Pt): { pt: Pt; t: number; u: number }[] {
  const hit = lineLineHit(a0, a1, b0, b1);
  if (hit) {
    const slackT = EPS / Math.max(dist(a0, a1), EPS);
    const slackU = EPS / Math.max(dist(b0, b1), EPS);
    if (hit.t >= -slackT && hit.t <= 1 + slackT && hit.u >= -slackU && hit.u <= 1 + slackU) {
      const t = clamp01(hit.t);
      const u = clamp01(hit.u);
      return [{ pt: [a0[0] + t * (a1[0] - a0[0]), a0[1] + t * (a1[1] - a0[1])], t, u }];
    }
    return [];
  }
  // Collinear: each end of one that lies on the other is a split, so an overlap becomes two vertices.
  const hits: { pt: Pt; t: number; u: number }[] = [];
  for (const pt of [b0, b1]) {
    const on = pointOnSegment(a0, a1, pt);
    if (on) hits.push({ pt: on.pt, t: on.t, u: pointOnSegment(b0, b1, pt)?.t ?? 0 });
  }
  for (const pt of [a0, a1]) {
    const on = pointOnSegment(b0, b1, pt);
    if (on) hits.push({ pt: on.pt, t: pointOnSegment(a0, a1, pt)?.t ?? 0, u: on.t });
  }
  return dedupeHits(hits);
}

/** Closest point on the infinite line, with `t` unclamped. */
export function projectToLine(a0: Pt, a1: Pt, pt: Pt): Projection | null {
  const delta = sub(a1, a0);
  const length2 = dot(delta, delta);
  if (length2 <= EPS * EPS) return null;
  const t = dot(sub(pt, a0), delta) / length2;
  const at: Pt = [a0[0] + t * delta[0], a0[1] + t * delta[1]];
  return { pt: at, distance: dist(pt, at), t };
}

/** Closest point on the segment, clamped to the ends. */
export function projectToSegment(a0: Pt, a1: Pt, pt: Pt): Projection | null {
  const hit = projectToLine(a0, a1, pt);
  if (!hit) return null;
  const t = clamp01(hit.t);
  const at: Pt = [a0[0] + t * (a1[0] - a0[0]), a0[1] + t * (a1[1] - a0[1])];
  return { pt: at, distance: dist(pt, at), t };
}

export function lineCircleHits(a0: Pt, a1: Pt, centre: Pt, radius: number): { pt: Pt; t: number }[] {
  const dx = a1[0] - a0[0];
  const dy = a1[1] - a0[1];
  const fx = a0[0] - centre[0];
  const fy = a0[1] - centre[1];
  const quadA = dx * dx + dy * dy;
  if (quadA <= EPS * EPS) return [];
  const quadB = 2 * (fx * dx + fy * dy);
  const quadC = fx * fx + fy * fy - radius * radius;
  const disc = quadB * quadB - 4 * quadA * quadC;
  if (disc < -1e-8 * Math.max(1, radius)) return [];
  const root = Math.sqrt(Math.max(0, disc));
  const ts = disc <= 1e-10 * Math.max(1, radius) ? [-quadB / (2 * quadA)] : [(-quadB - root) / (2 * quadA), (-quadB + root) / (2 * quadA)];
  return ts.map((t) => ({ pt: [a0[0] + t * dx, a0[1] + t * dy] as Pt, t }));
}

export function circleCircleHits(c0: Pt, r0: number, c1: Pt, r1: number): Pt[] {
  const dx = c1[0] - c0[0];
  const dy = c1[1] - c0[1];
  const d = Math.hypot(dx, dy);
  if (d <= EPS && Math.abs(r0 - r1) <= EPS) return [];
  if (d > r0 + r1 + EPS || d < Math.abs(r0 - r1) - EPS || d <= EPS) return [];
  const along = (r0 * r0 - r1 * r1 + d * d) / (2 * d);
  const height2 = r0 * r0 - along * along;
  if (height2 < -1e-8) return [];
  const height = Math.sqrt(Math.max(0, height2));
  const mid: Pt = [c0[0] + (along * dx) / d, c0[1] + (along * dy) / d];
  if (height <= EPS) return [mid];
  const px = (-dy * height) / d;
  const py = (dx * height) / d;
  return [[mid[0] + px, mid[1] + py], [mid[0] - px, mid[1] - py]];
}

export function projectToCircle(centre: Pt, radius: number, pt: Pt): Projection | null {
  if (!(radius > EPS)) return null;
  const delta = sub(pt, centre);
  const length = Math.hypot(delta[0], delta[1]);
  const angle = length <= EPS ? 0 : Math.atan2(delta[1], delta[0]);
  const at: Pt = [centre[0] + radius * Math.cos(angle), centre[1] + radius * Math.sin(angle)];
  let t = angle / TAU;
  if (t < 0) t += 1;
  return { pt: at, distance: dist(pt, at), t };
}

export function projectToArc(arc: ArcGeom, pt: Pt): Projection {
  const radial = projectToCircle(arc.centre, arc.radius, pt)!;
  const param = arcParam(arc, radial.pt, Math.max(EPS, arc.radius * 1e-6));
  if (param !== null) return { pt: radial.pt, distance: dist(pt, radial.pt), t: clamp01(param) };
  const start = arcPoint(arc, 0);
  const end = arcPoint(arc, 1);
  const ds = dist(pt, start);
  const de = dist(pt, end);
  return ds <= de ? { pt: start, distance: ds, t: 0 } : { pt: end, distance: de, t: 1 };
}

/**
 * Centripetal Catmull-Rom through `points`. A closed spline wraps; an open one reflects a phantom
 * control past each end so the curve leaves along the first and last chords. Samples include every
 * control, exactly. `stepMm` is the longest gap between samples.
 */
export function sampleSpline(points: readonly Pt[], closed: boolean, stepMm = 0.5): Pt[] {
  const controls = dropDuplicates(points);
  if (controls.length === 0) return [];
  if (controls.length === 1) return [[controls[0][0], controls[0][1]]];
  const out: Pt[] = [];
  const spans = closed ? controls.length : controls.length - 1;
  for (let i = 0; i < spans; i++) {
    const p1 = controls[i]!;
    const p2 = controls[(i + 1) % controls.length]!;
    const p0 = closed ? controls[(i - 1 + controls.length) % controls.length]! : i === 0 ? reflect(p1, p2) : controls[i - 1]!;
    const p3 = closed
      ? controls[(i + 2) % controls.length]!
      : i + 2 >= controls.length
        ? reflect(p2, p1)
        : controls[i + 2]!;
    const steps = Math.max(4, Math.ceil(dist(p1, p2) / Math.max(stepMm, 0.05)));
    const chunk = catmullSpan(p0, p1, p2, p3, steps);
    if (out.length) chunk.shift();
    out.push(...chunk);
  }
  if (!closed) {
    const last = controls[controls.length - 1]!;
    const end = out[out.length - 1];
    if (!end || !samePt(end, last, 1e-9)) out.push([last[0], last[1]]);
  } else if (out.length) {
    out[out.length - 1] = [out[0]![0], out[0]![1]];
  }
  return out;
}

export function projectToSpline(samples: readonly Pt[], pt: Pt, closed = false): Projection | null {
  if (samples.length === 0) return null;
  if (samples.length === 1) return { pt: [samples[0][0], samples[0][1]], distance: dist(pt, samples[0]), t: 0 };
  const count = closed ? samples.length - 1 : samples.length - 1;
  let best: Projection | null = null;
  let lengthBefore = 0;
  let total = 0;
  const lengths: number[] = [];
  for (let i = 0; i < count; i++) {
    const a = samples[i]!;
    const b = samples[i + 1]!;
    const length = dist(a, b);
    lengths.push(length);
    total += length;
  }
  if (total <= EPS) return { pt: [samples[0][0], samples[0][1]], distance: dist(pt, samples[0]), t: 0 };
  for (let i = 0; i < count; i++) {
    const hit = projectToSegment(samples[i]!, samples[i + 1]!, pt);
    if (!hit) continue;
    const t = (lengthBefore + hit.t * lengths[i]!) / total;
    if (!best || hit.distance < best.distance) best = { pt: hit.pt, distance: hit.distance, t };
    lengthBefore += lengths[i]!;
  }
  return best;
}

export type Curve =
  | { kind: "line"; a: Pt; b: Pt }
  | { kind: "arc"; arc: ArcGeom }
  | { kind: "circle"; centre: Pt; radius: number }
  | { kind: "spline"; controls: Pt[]; closed: boolean; samples: Pt[] };

/** The drawable curve of an entity, or null when it has no length. A collinear arc is the straight line between its ends. */
export function curveOf(sketch: SketchData, entity: SketchEntity): Curve | null {
  if (entity.kind === "line") {
    const a = sketchPoint(sketch, entity.a);
    const b = sketchPoint(sketch, entity.b);
    if (!a || !b || samePt(a.at, b.at)) return null;
    return { kind: "line", a: a.at, b: b.at };
  }
  if (entity.kind === "arc") {
    const a = sketchPoint(sketch, entity.a);
    const b = sketchPoint(sketch, entity.b);
    if (!a || !b) return null;
    const arc = arcFrom3(a.at, entity.through, b.at);
    if (!arc) {
      if (samePt(a.at, b.at)) return null;
      return { kind: "line", a: a.at, b: b.at };
    }
    return { kind: "arc", arc };
  }
  if (entity.kind === "circle") {
    const centre = sketchPoint(sketch, entity.centre);
    if (!centre || !(entity.radius > EPS)) return null;
    return { kind: "circle", centre: centre.at, radius: entity.radius };
  }
  const controls: Pt[] = [];
  for (const id of entity.through) {
    const point = sketchPoint(sketch, id);
    if (!point) return null;
    controls.push(point.at);
  }
  const closed = splineClosed(entity.through, controls);
  const unique = closed && entity.through.length >= 2 && (entity.through[0] === entity.through[entity.through.length - 1] || samePt(controls[0]!, controls[controls.length - 1]!))
    ? controls.slice(0, -1)
    : controls;
  if (unique.length < 2) return null;
  return { kind: "spline", controls: unique, closed, samples: sampleSpline(unique, closed) };
}

function splineClosed(ids: readonly number[], points: readonly Pt[]): boolean {
  if (points.length < 3) return false;
  if (ids[0] === ids[ids.length - 1]) return true;
  return samePt(points[0]!, points[points.length - 1]!);
}

export function curveProject(curve: Curve, at: Pt): Projection | null {
  if (curve.kind === "line") return projectToSegment(curve.a, curve.b, at);
  if (curve.kind === "arc") return projectToArc(curve.arc, at);
  if (curve.kind === "circle") return projectToCircle(curve.centre, curve.radius, at);
  return projectToSpline(curve.samples, at, curve.closed);
}

/** A point at parameter `t`. Closed curves wrap, so `t` may lie outside [0, 1]. */
export function pointOn(curve: Curve, t: number): Pt {
  if (curve.kind === "line") return [curve.a[0] + t * (curve.b[0] - curve.a[0]), curve.a[1] + t * (curve.b[1] - curve.a[1])];
  if (curve.kind === "arc") return arcPoint(curve.arc, t);
  if (curve.kind === "circle") {
    const angle = t * TAU;
    return [curve.centre[0] + curve.radius * Math.cos(angle), curve.centre[1] + curve.radius * Math.sin(angle)];
  }
  return pointOnPolyline(curve.samples, t);
}

export interface CurveHit {
  pt: Pt;
  t0: number;
  t1: number;
}

/** Intersections of two curves, including an end of one that lies on the other. */
export function curveIntersect(a: Curve, b: Curve): CurveHit[] {
  if (a.kind === "line" && b.kind === "line") {
    return segmentSegmentHits(a.a, a.b, b.a, b.b).map((hit) => ({ pt: hit.pt, t0: hit.t, t1: hit.u }));
  }
  if (a.kind === "line" && b.kind === "circle") return lineWithCircle(a.a, a.b, b.centre, b.radius, true);
  if (a.kind === "circle" && b.kind === "line") return swapHits(lineWithCircle(b.a, b.b, a.centre, a.radius, true));
  if (a.kind === "line" && b.kind === "arc") return lineWithArc(a.a, a.b, b.arc, true);
  if (a.kind === "arc" && b.kind === "line") return swapHits(lineWithArc(b.a, b.b, a.arc, true));
  if (a.kind === "circle" && b.kind === "circle") return circles(a.centre, a.radius, b.centre, b.radius);
  if (a.kind === "circle" && b.kind === "arc") return circleWithArc(a.centre, a.radius, b.arc);
  if (a.kind === "arc" && b.kind === "circle") return swapHits(circleWithArc(b.centre, b.radius, a.arc));
  if (a.kind === "arc" && b.kind === "arc") return arcWithArc(a.arc, b.arc);
  if (a.kind === "spline") return splineWith(a, b);
  if (b.kind === "spline") return swapHits(splineWith(b, a));
  return [];
}

/** Intersections of a ray (`origin` + positive distance · `dir`) with a curve. `dir` need not be a unit. */
export function rayHits(origin: Pt, dir: Pt, curve: Curve): { pt: Pt; distance: number }[] {
  const direction = unit(dir);
  if (!direction) return [];
  const far = add(origin, scale(direction, 1e6));
  const ray: Curve = { kind: "line", a: origin, b: far };
  const hits = curveIntersect(ray, curve);
  const out: { pt: Pt; distance: number }[] = [];
  for (const hit of hits) {
    const distance = dist(origin, hit.pt);
    const forward = dot(sub(hit.pt, origin), direction);
    if (forward > EPS) out.push({ pt: hit.pt, distance });
  }
  out.sort((p, q) => p.distance - q.distance);
  return out;
}

/**
 * An arc tangent to two line segments that already meet at a corner. The corner is a shared end.
 * The arc sits in the wedge the two segments form, and the tangent points lie on the segments.
 */
export function cornerFillet(
  a0: Pt,
  a1: Pt,
  b0: Pt,
  b1: Pt,
  radius: number,
): { tangentA: Pt; tangentB: Pt; through: Pt; centre: Pt } | { error: string } {
  if (!(radius > 0) || !Number.isFinite(radius)) return { error: "A corner round needs a radius above 0." };
  const corner = sharedEnd(a0, a1, b0, b1);
  if (!corner) {
    const crossing = lineLineHit(a0, a1, b0, b1);
    if (crossing && in01(crossing.t) && in01(crossing.u) && !endpointHit(crossing.t) && !endpointHit(crossing.u)) {
      return { error: "These lines cross. Trim them so they meet at the corner you want to round." };
    }
    return { error: "These lines do not meet, so there is no corner to round." };
  }
  const dirA = unit(sub(corner.otherA, corner.at));
  const dirB = unit(sub(corner.otherB, corner.at));
  if (!dirA || !dirB) return { error: "These lines do not meet, so there is no corner to round." };
  const alpha = Math.atan2(Math.abs(cross(dirA, dirB)), dot(dirA, dirB));
  if (alpha < 1e-4 || Math.PI - alpha < 1e-4) return { error: "These lines are straight, so there is no corner to round." };
  const tangentLength = radius / Math.tan(alpha / 2);
  if (dist(corner.at, corner.otherA) < tangentLength - 1e-6 || dist(corner.at, corner.otherB) < tangentLength - 1e-6) {
    return { error: "That radius does not fit these two lines. Use a smaller one." };
  }
  const bisector = unit(add(dirA, dirB));
  if (!bisector) return { error: "These lines are straight, so there is no corner to round." };
  const centre = add(corner.at, scale(bisector, radius / Math.sin(alpha / 2)));
  return {
    tangentA: add(corner.at, scale(dirA, tangentLength)),
    tangentB: add(corner.at, scale(dirB, tangentLength)),
    through: sub(centre, scale(bisector, radius)),
    centre,
  };
}

/** `p` reflected through the line `a`–`b`. Null when the axis has no length. */
export function mirrorPoint(p: Pt, a: Pt, b: Pt): Pt | null {
  const axis = sub(b, a);
  const length2 = dot(axis, axis);
  if (length2 <= EPS * EPS) return null;
  const t = dot(sub(p, a), axis) / length2;
  const on = add(a, scale(axis, t));
  return sub(scale(on, 2), p);
}

export function rotatePoint(p: Pt, centre: Pt, angleRad: number): Pt {
  const dx = p[0] - centre[0];
  const dy = p[1] - centre[1];
  const c = Math.cos(angleRad);
  const s = Math.sin(angleRad);
  return [centre[0] + dx * c - dy * s, centre[1] + dx * s + dy * c];
}

export function translatePoint(p: Pt, delta: Pt): Pt {
  return [p[0] + delta[0], p[1] + delta[1]];
}

function sharedEnd(a0: Pt, a1: Pt, b0: Pt, b1: Pt): { at: Pt; otherA: Pt; otherB: Pt } | null {
  const pairs: [Pt, Pt, Pt, Pt][] = [
    [a0, a1, b0, b1],
    [a0, a1, b1, b0],
    [a1, a0, b0, b1],
    [a1, a0, b1, b0],
  ];
  for (const [a, otherA, b, otherB] of pairs) {
    if (samePt(a, b)) return { at: a, otherA, otherB };
  }
  return null;
}

function endpointHit(t: number): boolean {
  return t <= 1e-6 || t >= 1 - 1e-6;
}

function in01(t: number): boolean {
  return t >= -1e-6 && t <= 1 + 1e-6;
}

function lineWithCircle(a0: Pt, a1: Pt, centre: Pt, radius: number, bounded: boolean): CurveHit[] {
  const hits = lineCircleHits(a0, a1, centre, radius);
  const out: CurveHit[] = [];
  for (const hit of hits) {
    if (bounded && (hit.t < -1e-6 || hit.t > 1 + 1e-6)) continue;
    const t = clamp01(hit.t);
    const pt: Pt = [a0[0] + t * (a1[0] - a0[0]), a0[1] + t * (a1[1] - a0[1])];
    const radial = projectToCircle(centre, radius, pt)!;
    out.push({ pt, t0: t, t1: radial.t });
  }
  return dedupeCurve(out);
}

function lineWithArc(a0: Pt, a1: Pt, arc: ArcGeom, bounded: boolean): CurveHit[] {
  const hits = lineCircleHits(a0, a1, arc.centre, arc.radius);
  const out: CurveHit[] = [];
  for (const hit of hits) {
    if (bounded && (hit.t < -1e-6 || hit.t > 1 + 1e-6)) continue;
    const t = clamp01(hit.t);
    const pt: Pt = [a0[0] + t * (a1[0] - a0[0]), a0[1] + t * (a1[1] - a0[1])];
    const param = arcParam(arc, pt);
    if (param === null) continue;
    out.push({ pt, t0: t, t1: param });
  }
  return dedupeCurve(out);
}

function circles(c0: Pt, r0: number, c1: Pt, r1: number): CurveHit[] {
  return circleCircleHits(c0, r0, c1, r1).map((pt) => ({
    pt,
    t0: projectToCircle(c0, r0, pt)!.t,
    t1: projectToCircle(c1, r1, pt)!.t,
  }));
}

function circleWithArc(centre: Pt, radius: number, arc: ArcGeom): CurveHit[] {
  const out: CurveHit[] = [];
  for (const pt of circleCircleHits(centre, radius, arc.centre, arc.radius)) {
    const param = arcParam(arc, pt);
    if (param === null) continue;
    out.push({ pt, t0: projectToCircle(centre, radius, pt)!.t, t1: param });
  }
  return out;
}

function arcWithArc(a: ArcGeom, b: ArcGeom): CurveHit[] {
  const out: CurveHit[] = [];
  for (const pt of circleCircleHits(a.centre, a.radius, b.centre, b.radius)) {
    const t0 = arcParam(a, pt);
    const t1 = arcParam(b, pt);
    if (t0 === null || t1 === null) continue;
    out.push({ pt, t0, t1 });
  }
  return out;
}

function splineWith(spline: Extract<Curve, { kind: "spline" }>, other: Curve): CurveHit[] {
  const hits: CurveHit[] = [];
  const samples = spline.samples;
  const count = samples.length - 1;
  for (let i = 0; i < count; i++) {
    const a = samples[i]!;
    const b = samples[i + 1]!;
    if (samePt(a, b)) continue;
    const segment: Curve = { kind: "line", a, b };
    if (other.kind === "spline") {
      for (const hit of polylineHits(segment, other.samples)) hits.push({ pt: hit.pt, t0: splineParam(spline, hit.pt), t1: splineParam(other, hit.pt) });
    } else {
      for (const hit of curveIntersect(segment, other)) hits.push({ pt: hit.pt, t0: splineParam(spline, hit.pt), t1: hit.t1 });
    }
  }
  return dedupeCurve(hits);
}

function polylineHits(segment: Extract<Curve, { kind: "line" }>, samples: readonly Pt[]): { pt: Pt; t: number }[] {
  const hits: { pt: Pt; t: number }[] = [];
  for (let i = 0; i < samples.length - 1; i++) {
    const a = samples[i]!;
    const b = samples[i + 1]!;
    if (samePt(a, b)) continue;
    for (const hit of segmentSegmentHits(segment.a, segment.b, a, b)) hits.push({ pt: hit.pt, t: hit.t });
  }
  return hits;
}

function splineParam(spline: Extract<Curve, { kind: "spline" }>, pt: Pt): number {
  return projectToSpline(spline.samples, pt, spline.closed)?.t ?? 0;
}

function swapHits(hits: CurveHit[]): CurveHit[] {
  return hits.map((hit) => ({ pt: hit.pt, t0: hit.t1, t1: hit.t0 }));
}

function dedupeHits(hits: { pt: Pt; t: number; u: number }[]): { pt: Pt; t: number; u: number }[] {
  const out: { pt: Pt; t: number; u: number }[] = [];
  for (const hit of hits) {
    if (!out.some((kept) => samePt(kept.pt, hit.pt))) out.push(hit);
  }
  return out;
}

function dedupeCurve(hits: CurveHit[]): CurveHit[] {
  const out: CurveHit[] = [];
  for (const hit of hits) {
    if (!out.some((kept) => samePt(kept.pt, hit.pt))) out.push(hit);
  }
  return out;
}

function pointOnSegment(a: Pt, b: Pt, pt: Pt): { pt: Pt; t: number } | null {
  const hit = projectToLine(a, b, pt);
  if (!hit || hit.distance > EPS) return null;
  if (hit.t < -1e-6 || hit.t > 1 + 1e-6) return null;
  const t = clamp01(hit.t);
  return { pt: [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])], t };
}

function pointOnPolyline(samples: readonly Pt[], t: number): Pt {
  if (samples.length === 0) return [0, 0];
  if (samples.length === 1 || t <= 0) return [samples[0]![0], samples[0]![1]];
  const closed = samePt(samples[0]!, samples[samples.length - 1]!);
  const count = samples.length - 1;
  let total = 0;
  const lengths: number[] = [];
  for (let i = 0; i < count; i++) {
    const length = dist(samples[i]!, samples[i + 1]!);
    lengths.push(length);
    total += length;
  }
  if (total <= EPS) return [samples[0]![0], samples[0]![1]];
  let target = t * total;
  if (closed) {
    target = ((t % 1) + 1) % 1 * total;
  }
  if (target >= total) return [samples[samples.length - 1]![0], samples[samples.length - 1]![1]];
  for (let i = 0; i < count; i++) {
    const length = lengths[i]!;
    if (target <= length || i === count - 1) {
      const u = length <= EPS ? 0 : target / length;
      const a = samples[i]!;
      const b = samples[i + 1]!;
      return [a[0] + u * (b[0] - a[0]), a[1] + u * (b[1] - a[1])];
    }
    target -= length;
  }
  const last = samples[samples.length - 1]!;
  return [last[0], last[1]];
}

function catmullSpan(p0: Pt, p1: Pt, p2: Pt, p3: Pt, steps: number): Pt[] {
  const tj = (ti: number, a: Pt, b: Pt) => ti + Math.sqrt(Math.max(dist(a, b), 1e-12));
  const t0 = 0;
  const t1 = tj(t0, p0, p1);
  const t2 = tj(t1, p1, p2);
  const t3 = tj(t2, p2, p3);
  const out: Pt[] = [];
  for (let i = 0; i <= steps; i++) {
    if (i === 0) {
      out.push([p1[0], p1[1]]);
      continue;
    }
    if (i === steps) {
      out.push([p2[0], p2[1]]);
      continue;
    }
    const t = t1 + ((t2 - t1) * i) / steps;
    out.push(catmullPoint(p0, p1, p2, p3, t0, t1, t2, t3, t));
  }
  return out;
}

function catmullPoint(p0: Pt, p1: Pt, p2: Pt, p3: Pt, t0: number, t1: number, t2: number, t3: number, t: number): Pt {
  const a1 = lerp(p0, p1, t, t0, t1);
  const a2 = lerp(p1, p2, t, t1, t2);
  const a3 = lerp(p2, p3, t, t2, t3);
  const b1 = lerp(a1, a2, t, t0, t2);
  const b2 = lerp(a2, a3, t, t1, t3);
  return lerp(b1, b2, t, t1, t2);
}

function lerp(a: Pt, b: Pt, t: number, ta: number, tb: number): Pt {
  if (Math.abs(tb - ta) < 1e-15) return [a[0], a[1]];
  const s = (t - ta) / (tb - ta);
  return [a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s];
}

function reflect(pivot: Pt, other: Pt): Pt {
  return [2 * pivot[0] - other[0], 2 * pivot[1] - other[1]];
}

function dropDuplicates(points: readonly Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const point of points) {
    const last = out[out.length - 1];
    if (last && samePt(last, point)) continue;
    out.push([point[0], point[1]]);
  }
  return out;
}

function clamp01(t: number): number {
  if (t < 0) return 0;
  if (t > 1) return 1;
  return t;
}
