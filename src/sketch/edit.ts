/**
 * Sketch edits (`docs/plan-gui-cad-modeling.md`, Plan B §4.2): trim, extend, offset, a corner
 * fillet, mirror, and linear and polar copies.
 *
 * Each edit returns a new sketch and leaves the one it was given unchanged. A refusal is a
 * sentence that says what to change; the sketch comes back as it was. Positive offset distance
 * is to the left of an entity's direction. A chain is walked in one direction first, so a closed
 * outline offsets to its left together: a counter-clockwise loop shrinks.
 */
import {
  EPS,
  arcFrom3,
  arcPoint,
  arcTangent,
  cornerFillet,
  curveIntersect,
  curveOf,
  curveProject,
  dist,
  leftNormal,
  lineCircleHits,
  lineLineHit,
  mirrorPoint,
  pointOn,
  projectToCircle,
  rayHits,
  rotatePoint,
  samePt,
  translatePoint,
  unit,
  type Curve,
  type Pt,
  SPLINE_THROUGH_MAX,
  projectToSpline,
  sampleSpline,
} from "./geom.ts";
import {
  addArc,
  addCircle,
  addLine,
  addPoint,
  addSpline,
  pointNear,
  prunePoints,
  sketchEntity,
  sketchPoint,
  type SketchData,
  type SketchEntity,
} from "./model.ts";

export interface EditResult {
  sketch: SketchData;
  /** Set when nothing changed, as a sentence. */
  error?: string;
}

const MISSING = "Click a line, arc, circle, or spline to trim.";

/** Removes the piece between the nearest intersections on either side of `at`. Ends count as intersections. */
export function trim(sketch: SketchData, entityId: number, at: Pt): EditResult {
  const entity = sketchEntity(sketch, entityId);
  const curve = entity && curveOf(sketch, entity);
  if (!entity || !curve) return { sketch, error: MISSING };
  const hit = curveProject(curve, at);
  if (!hit) return { sketch, error: MISSING };
  const closed = isClosed(curve);
  const params: number[] = [];
  for (const other of sketch.entities) {
    if (other.id === entity.id) continue;
    const otherCurve = curveOf(sketch, other);
    if (!otherCurve) continue;
    for (const crossing of curveIntersect(curve, otherCurve)) params.push(crossing.t0);
  }
  const spans = spansOf(params, closed);
  const index = spans.findIndex(([t0, t1]) => inSpan(hit.t, t0, t1));
  if (index < 0) return { sketch, error: MISSING };
  const kept = spans.filter((_, i) => i !== index).filter(([t0, t1]) => spanLength(curve, t0, t1) > EPS);
  let next = dropEntity(sketch, entity.id);
  for (const [t0, t1] of kept) {
    const built = entityFromSpan(next, entity, curve, t0, t1);
    if (built) next = built;
  }
  return { sketch: prunePoints(next) };
}

/** Grows the end nearer `at` until it meets another entity. */
export function extend(sketch: SketchData, entityId: number, at: Pt): EditResult {
  const entity = sketchEntity(sketch, entityId);
  const curve = entity && curveOf(sketch, entity);
  if (!entity || !curve) return { sketch, error: "Click a line, arc, or spline to extend." };
  if (curve.kind === "circle") return { sketch, error: "A circle is already closed." };
  if (curve.kind === "spline" && curve.closed) return { sketch, error: "A closed spline has no end to extend." };
  const hit = curveProject(curve, at);
  if (!hit) return { sketch, error: "Click a line, arc, or spline to extend." };
  const atStart = hit.t <= 0.5;
  const target = nearestHit(sketch, entity.id, curve, atStart);
  if (!target) return { sketch, error: "Extend this end until it meets another line or arc. Nothing is in the way yet." };
  return { sketch: prunePoints(extendTo(sketch, entity, curve, atStart, target)) };
}

/**
 * Offsets `entityIds` by `distance` millimetres, to the left of each entity when positive.
 * A connected chain is offset as one chain, so corners meet. Lines and arcs stay exact; a
 * spline is sampled.
 */
export function offset(sketch: SketchData, entityIds: readonly number[], distance: number): EditResult {
  if (!entityIds.length) return { sketch, error: "Select a line, arc, circle, or spline to offset." };
  if (!Number.isFinite(distance) || Math.abs(distance) <= EPS) return { sketch, error: "An offset needs a distance other than 0." };
  const entities = entityIds.map((id) => sketchEntity(sketch, id));
  if (entities.some((entity) => !entity)) return { sketch, error: "Select a line, arc, circle, or spline to offset." };
  const present = entities as SketchEntity[];
  const chain = orderChain(sketch, present);
  const walked = chain ?? present.map((entity) => ({ entity, forward: true }));
  let next = sketch;
  const ends: EndRef[] = [];
  for (const item of walked) {
    const built = offsetOne(next, item.entity, item.forward ? distance : -distance);
    if (built.error || !built.sketch) return { sketch, error: built.error };
    next = built.sketch;
    if (built.ends) ends.push(...built.ends);
  }
  const welded = weld(next, ends, distance);
  if (welded.error) return { sketch, error: welded.error };
  return { sketch: prunePoints(welded.sketch) };
}

/** An arc tangent to two lines that meet at a corner, trimming both back to the arc. */
export function filletCorner(sketch: SketchData, lineA: number, lineB: number, radius: number): EditResult {
  const a = sketchEntity(sketch, lineA);
  const b = sketchEntity(sketch, lineB);
  if (!a || !b || a.kind !== "line" || b.kind !== "line" || a.id === b.id) return { sketch, error: "Click two lines to round their corner." };
  const a0 = sketchPoint(sketch, a.a);
  const a1 = sketchPoint(sketch, a.b);
  const b0 = sketchPoint(sketch, b.a);
  const b1 = sketchPoint(sketch, b.b);
  if (!a0 || !a1 || !b0 || !b1) return { sketch, error: "Click two lines to round their corner." };
  const fillet = cornerFillet(a0.at, a1.at, b0.at, b1.at, radius);
  if ("error" in fillet) return { sketch, error: fillet.error };
  const cornerId = sharedPoint(a, b);
  let next = sketch;
  next = retargetLine(next, a, cornerId, a0.at, fillet.tangentA);
  next = retargetLine(next, b, cornerId, b0.at, fillet.tangentB);
  const placedA = place(next, fillet.tangentA);
  const placedB = place(placedA.sketch, fillet.tangentB);
  const arc = addArc(placedB.sketch, placedA.id, placedB.id, fillet.through, a.construction || b.construction);
  return { sketch: prunePoints(arc.sketch) };
}

/** Copies `entityIds`, mirrored across the axis from `axisA` to `axisB`. */
export function mirror(sketch: SketchData, entityIds: readonly number[], axisA: Pt, axisB: Pt): EditResult {
  if (!entityIds.length) return { sketch, error: "Select something to mirror." };
  if (samePt(axisA, axisB)) return { sketch, error: "Pick an axis of two different points to mirror across." };
  const map = (pt: Pt) => mirrorPoint(pt, axisA, axisB);
  if (!map([0, 0])) return { sketch, error: "Pick an axis of two different points to mirror across." };
  return copyWith(sketch, entityIds, (pt) => map(pt)!);
}

/** `count` copies of `entityIds`, the ith shifted by `i` times `delta`. */
export function linearCopy(sketch: SketchData, entityIds: readonly number[], delta: Pt, count: number): EditResult {
  if (!entityIds.length) return { sketch, error: "Select something to copy." };
  if (!Number.isInteger(count) || count < 1) return { sketch, error: "A copy needs a count of at least 1." };
  if (!Number.isFinite(delta[0]) || !Number.isFinite(delta[1]) || Math.hypot(delta[0], delta[1]) <= EPS) {
    return { sketch, error: "A copy needs a distance." };
  }
  let next = sketch;
  for (let i = 1; i <= count; i++) {
    const copied = copyWith(next, entityIds, (pt) => translatePoint(pt, [delta[0] * i, delta[1] * i]));
    if (copied.error) return { sketch, error: copied.error };
    next = copied.sketch;
  }
  return { sketch: next };
}

/** `count` copies of `entityIds`, the ith turned by `i` times `angleDeg` about `centre`. */
export function polarCopy(sketch: SketchData, entityIds: readonly number[], centre: Pt, angleDeg: number, count: number): EditResult {
  if (!entityIds.length) return { sketch, error: "Select something to copy." };
  if (!Number.isInteger(count) || count < 1) return { sketch, error: "A round copy needs a count of at least 1." };
  if (!Number.isFinite(angleDeg) || Math.abs(angleDeg) <= 1e-9) return { sketch, error: "A round copy needs an angle other than 0." };
  let next = sketch;
  const step = (angleDeg * Math.PI) / 180;
  for (let i = 1; i <= count; i++) {
    const copied = copyWith(next, entityIds, (pt) => rotatePoint(pt, centre, step * i));
    if (copied.error) return { sketch, error: copied.error };
    next = copied.sketch;
  }
  return { sketch: next };
}

interface EndRef {
  /** Original joint, so two offset ends that came from one corner can be welded. */
  joint: Pt;
  entityId: number;
  which: "a" | "b";
  /** The raw offset point, before a corner weld. */
  at: Pt;
  support: Support;
}

type Support =
  | { kind: "line"; point: Pt; dir: Pt }
  | { kind: "circle"; centre: Pt; radius: number }
  | { kind: "none" };

function offsetOne(sketch: SketchData, entity: SketchEntity, distance: number): { sketch?: SketchData; error?: string; ends?: EndRef[] } {
  const curve = curveOf(sketch, entity);
  if (!curve) return { error: "Select a line, arc, circle, or spline to offset." };
  if (curve.kind === "line") {
    const dir = unit([curve.b[0] - curve.a[0], curve.b[1] - curve.a[1]]);
    if (!dir) return { error: "Select a line, arc, circle, or spline to offset." };
    const normal = leftNormal(dir);
    const a: Pt = [curve.a[0] + normal[0] * distance, curve.a[1] + normal[1] * distance];
    const b: Pt = [curve.b[0] + normal[0] * distance, curve.b[1] + normal[1] * distance];
    const added = addLine(sketch, a, b, entity.construction);
    const support: Support = { kind: "line", point: a, dir };
    return {
      sketch: added.sketch,
      ends: [
        { joint: curve.a, entityId: added.id, which: "a", at: a, support },
        { joint: curve.b, entityId: added.id, which: "b", at: b, support },
      ],
    };
  }
  if (curve.kind === "circle") {
    const radius = curve.radius + distance;
    if (!(radius > EPS)) return { error: "That offset is larger than the circle. Use a smaller one." };
    const added = addCircle(sketch, curve.centre, radius, entity.construction);
    return { sketch: added.sketch, ends: [] };
  }
  if (curve.kind === "arc") {
    const sign = curve.arc.sweep >= 0 ? 1 : -1;
    const radius = curve.arc.radius - distance * sign;
    if (!(radius > EPS)) return { error: "That offset is larger than the arc. Use a smaller one." };
    const start = radial(curve.arc.centre, arcPoint(curve.arc, 0), radius);
    const end = radial(curve.arc.centre, arcPoint(curve.arc, 1), radius);
    const through = radial(curve.arc.centre, arcPoint(curve.arc, 0.5), radius);
    const added = addArc(sketch, start, end, through, entity.construction);
    const support: Support = { kind: "circle", centre: curve.arc.centre, radius };
    return {
      sketch: added.sketch,
      ends: [
        { joint: arcPoint(curve.arc, 0), entityId: added.id, which: "a", at: start, support },
        { joint: arcPoint(curve.arc, 1), entityId: added.id, which: "b", at: end, support },
      ],
    };
  }
  const samples = offsetSamples(curve.samples, distance, curve.closed);
  if (samples.length < 2) return { error: "Select a line, arc, circle, or spline to offset." };
  const through = curve.closed ? [...samples, samples[0]!] : samples;
  const added = addSpline(sketch, through, entity.construction);
  return { sketch: added.sketch, ends: [] };
}

function weld(sketch: SketchData, ends: EndRef[], distance: number): EditResult {
  const groups = new Map<string, EndRef[]>();
  for (const end of ends) {
    const key = `${Math.round(end.joint[0] / EPS)}:${Math.round(end.joint[1] / EPS)}`;
    const group = groups.get(key);
    if (group) group.push(end);
    else groups.set(key, [end]);
  }
  let next = sketch;
  for (const group of groups.values()) {
    if (group.length !== 2) continue;
    const [p, q] = group as [EndRef, EndRef];
    const hit = supportHit(p.support, q.support, midpoint(p.at, q.at));
    if (!hit) continue;
    if (dist(hit, p.joint) > Math.max(50, Math.abs(distance) * 20)) continue;
    const moved = place(next, hit);
    next = moved.sketch;
    next = pointEntity(next, p.entityId, p.which, moved.id);
    next = pointEntity(next, q.entityId, q.which, moved.id);
    next = retouchArc(next, p.entityId);
    if (q.entityId !== p.entityId) next = retouchArc(next, q.entityId);
  }
  // An offset side that flipped has been eaten by the shape.
  for (const end of ends) {
    const entity = sketchEntity(next, end.entityId);
    if (!entity || entity.kind !== "line") continue;
    const a = sketchPoint(next, entity.a);
    const b = sketchPoint(next, entity.b);
    if (!a || !b || samePt(a.at, b.at)) return { sketch, error: "That offset is larger than this shape. Use a smaller one." };
    if (end.support.kind === "line") {
      const along = (b.at[0] - a.at[0]) * end.support.dir[0] + (b.at[1] - a.at[1]) * end.support.dir[1];
      if (along <= EPS) return { sketch, error: "That offset is larger than this shape. Use a smaller one." };
    }
  }
  return { sketch: next };
}

function retouchArc(sketch: SketchData, entityId: number): SketchData {
  const entity = sketchEntity(sketch, entityId);
  if (!entity || entity.kind !== "arc") return sketch;
  const a = sketchPoint(sketch, entity.a);
  const b = sketchPoint(sketch, entity.b);
  if (!a || !b) return sketch;
  const arc = arcFrom3(a.at, entity.through, b.at);
  if (!arc) return sketch;
  const through = arcPoint(arc, 0.5);
  return {
    ...sketch,
    entities: sketch.entities.map((item) => (item.id === entityId && item.kind === "arc" ? { ...item, through } : item)),
  };
}

function supportHit(a: Support, b: Support, hint: Pt): Pt | null {
  if (a.kind === "line" && b.kind === "line") {
    const hit = lineLineHit(a.point, [a.point[0] + a.dir[0], a.point[1] + a.dir[1]], b.point, [b.point[0] + b.dir[0], b.point[1] + b.dir[1]]);
    return hit ? hit.pt : null;
  }
  if (a.kind === "line" && b.kind === "circle") return nearestCircle(a, b.centre, b.radius, hint);
  if (b.kind === "line" && a.kind === "circle") return nearestCircle(b, a.centre, a.radius, hint);
  if (a.kind === "circle" && b.kind === "circle") {
    const hits = circleHits(a.centre, a.radius, b.centre, b.radius);
    return closest(hits, hint);
  }
  return null;
}

function nearestCircle(line: Extract<Support, { kind: "line" }>, centre: Pt, radius: number, hint: Pt): Pt | null {
  const far: Pt = [line.point[0] + line.dir[0] * 1e4, line.point[1] + line.dir[1] * 1e4];
  const back: Pt = [line.point[0] - line.dir[0] * 1e4, line.point[1] - line.dir[1] * 1e4];
  const hits = lineCircleHits(back, far, centre, radius).map((hit) => hit.pt);
  return closest(hits, hint);
}

function circleHits(c0: Pt, r0: number, c1: Pt, r1: number): Pt[] {
  const dx = c1[0] - c0[0];
  const dy = c1[1] - c0[1];
  const d = Math.hypot(dx, dy);
  if (d <= EPS || d > r0 + r1 + EPS || d < Math.abs(r0 - r1) - EPS) return [];
  const along = (r0 * r0 - r1 * r1 + d * d) / (2 * d);
  const height2 = r0 * r0 - along * along;
  if (height2 < -1e-8) return [];
  const height = Math.sqrt(Math.max(0, height2));
  const mid: Pt = [c0[0] + (along * dx) / d, c0[1] + (along * dy) / d];
  if (height <= EPS) return [mid];
  return [[mid[0] - (dy * height) / d, mid[1] + (dx * height) / d], [mid[0] + (dy * height) / d, mid[1] - (dx * height) / d]];
}

function closest(points: Pt[], hint: Pt): Pt | null {
  let best: Pt | null = null;
  let bestDist = Infinity;
  for (const point of points) {
    const gap = dist(point, hint);
    if (gap < bestDist) {
      best = point;
      bestDist = gap;
    }
  }
  return best;
}

function offsetSamples(samples: readonly Pt[], distance: number, closed: boolean): Pt[] {
  const seam = closed && samples.length > 1 && samePt(samples[0]!, samples[samples.length - 1]!);
  const count = seam ? samples.length - 1 : samples.length;
  const out: Pt[] = [];
  for (let i = 0; i < count; i++) {
    const prev = closed ? samples[(i - 1 + count) % count]! : samples[Math.max(0, i - 1)]!;
    const at = samples[i]!;
    const next = closed ? samples[(i + 1) % count]! : samples[Math.min(count - 1, i + 1)]!;
    const tangent = unit([next[0] - prev[0], next[1] - prev[1]]);
    if (!tangent) continue;
    const normal = leftNormal(tangent);
    const point: Pt = [at[0] + normal[0] * distance, at[1] + normal[1] * distance];
    const last = out[out.length - 1];
    if (!last || !samePt(last, point, 1e-4)) out.push(point);
  }
  return out;
}

function orderChain(sketch: SketchData, entities: SketchEntity[]): { entity: SketchEntity; forward: boolean }[] | null {
  const links = entities.map((entity) => linkOf(sketch, entity)).filter((link): link is Link => link !== null);
  if (links.length !== entities.length || links.length === 0) return null;
  const at = new Map<string, { link: Link; start: boolean }[]>();
  const touch = (key: string, link: Link, start: boolean) => {
    const list = at.get(key) ?? [];
    list.push({ link, start });
    at.set(key, list);
  };
  for (const link of links) {
    touch(link.startKey, link, true);
    touch(link.endKey, link, false);
  }
  const degrees = [...at.values()].map((list) => list.length);
  if (degrees.some((degree) => degree > 2)) return null;
  const open = [...at.entries()].filter(([, list]) => list.length === 1);
  if (open.length !== 0 && open.length !== 2) return null;
  const startKey = open[0]?.[0] ?? links[0]!.startKey;
  const used = new Set<number>();
  const ordered: { entity: SketchEntity; forward: boolean }[] = [];
  let key = startKey;
  while (ordered.length < links.length) {
    const options = (at.get(key) ?? []).filter((item) => !used.has(item.link.entity.id));
    const step = options[0];
    if (!step) return null;
    used.add(step.link.entity.id);
    const forward = step.start;
    ordered.push({ entity: step.link.entity, forward });
    key = forward ? step.link.endKey : step.link.startKey;
  }
  return ordered;
}

interface Link {
  entity: SketchEntity;
  startKey: string;
  endKey: string;
}

function linkOf(sketch: SketchData, entity: SketchEntity): Link | null {
  if (entity.kind === "circle") return null;
  if (entity.kind === "line" || entity.kind === "arc") {
    const a = sketchPoint(sketch, entity.a);
    const b = sketchPoint(sketch, entity.b);
    if (!a || !b) return null;
    return { entity, startKey: keyOf(a.at), endKey: keyOf(b.at) };
  }
  const first = sketchPoint(sketch, entity.through[0] ?? -1);
  const last = sketchPoint(sketch, entity.through[entity.through.length - 1] ?? -1);
  if (!first || !last) return null;
  if (entity.through[0] === entity.through[entity.through.length - 1]) return null;
  return { entity, startKey: keyOf(first.at), endKey: keyOf(last.at) };
}

function nearestHit(sketch: SketchData, entityId: number, curve: Curve, atStart: boolean): Pt | null {
  let best: Pt | null = null;
  let bestDist = Infinity;
  if (curve.kind === "line") {
    const origin = atStart ? curve.a : curve.b;
    const toward = atStart ? curve.a : curve.b;
    const away = atStart ? curve.b : curve.a;
    const direction: Pt = [toward[0] - away[0], toward[1] - away[1]];
    for (const other of sketch.entities) {
      if (other.id === entityId) continue;
      const otherCurve = curveOf(sketch, other);
      if (!otherCurve) continue;
      for (const hit of rayHits(origin, direction, otherCurve)) {
        if (hit.distance < bestDist) {
          best = hit.pt;
          bestDist = hit.distance;
        }
      }
    }
    return best;
  }
  if (curve.kind === "arc") {
    const origin = arcPoint(curve.arc, atStart ? 0 : 1);
    const tangent = arcTangent(curve.arc, atStart ? 0 : 1);
    const direction = atStart ? [-tangent[0], -tangent[1]] as Pt : tangent;
    for (const other of sketch.entities) {
      if (other.id === entityId) continue;
      const otherCurve = curveOf(sketch, other);
      if (!otherCurve) continue;
      for (const hit of rayHits(origin, direction, otherCurve)) {
        // Keep the hit on the same circle: extend along the arc, not along a straight tangent,
        // when the other curve meets this circle further along.
        const onCircle = Math.abs(dist(hit.pt, curve.arc.centre) - curve.arc.radius) <= Math.max(EPS, curve.arc.radius * 1e-6);
        if (!onCircle) continue;
        if (hit.distance < bestDist) {
          best = hit.pt;
          bestDist = hit.distance;
        }
      }
    }
    if (best) return best;
    // The tangent ray can miss a curve the circle itself still meets. Search the circle past this end.
    return extendArcHit(sketch, entityId, curve, atStart);
  }
  if (curve.kind !== "spline" || curve.samples.length < 2) return null;
  const samples = curve.samples;
  const origin = atStart ? samples[0]! : samples[samples.length - 1]!;
  const prev = atStart ? samples[1]! : samples[samples.length - 2]!;
  const direction: Pt = [origin[0] - prev[0], origin[1] - prev[1]];
  for (const other of sketch.entities) {
    if (other.id === entityId) continue;
    const otherCurve = curveOf(sketch, other);
    if (!otherCurve) continue;
    for (const hit of rayHits(origin, direction, otherCurve)) {
      if (hit.distance < bestDist) {
        best = hit.pt;
        bestDist = hit.distance;
      }
    }
  }
  return best;
}

function extendArcHit(sketch: SketchData, entityId: number, curve: Extract<Curve, { kind: "arc" }>, atStart: boolean): Pt | null {
  const circle: Curve = { kind: "circle", centre: curve.arc.centre, radius: curve.arc.radius };
  let best: { pt: Pt; sweep: number } | null = null;
  const originAngle = curve.arc.a0 + (atStart ? 0 : curve.arc.sweep);
  const ccw = atStart ? curve.arc.sweep < 0 : curve.arc.sweep > 0;
  for (const other of sketch.entities) {
    if (other.id === entityId) continue;
    const otherCurve = curveOf(sketch, other);
    if (!otherCurve) continue;
    for (const hit of curveIntersect(circle, otherCurve)) {
      const angle = Math.atan2(hit.pt[1] - curve.arc.centre[1], hit.pt[0] - curve.arc.centre[0]);
      let sweep = angle - originAngle;
      if (ccw) {
        while (sweep <= 1e-6) sweep += Math.PI * 2;
        while (sweep > Math.PI * 2) sweep -= Math.PI * 2;
      } else {
        while (sweep >= -1e-6) sweep -= Math.PI * 2;
        while (sweep < -Math.PI * 2) sweep += Math.PI * 2;
      }
      const amount = Math.abs(sweep);
      if (amount <= 1e-4 || amount >= Math.PI * 2 - 1e-3) continue;
      if (!best || amount < Math.abs(best.sweep)) best = { pt: hit.pt, sweep };
    }
  }
  return best?.pt ?? null;
}

function extendTo(sketch: SketchData, entity: SketchEntity, curve: Curve, atStart: boolean, to: Pt): SketchData {
  if (entity.kind === "line") {
    const which = atStart ? "a" : "b";
    const oldId = which === "a" ? entity.a : entity.b;
    const placed = place(sketch, to);
    if (placed.id === oldId) return sketch;
    return pointEntity(placed.sketch, entity.id, which, placed.id);
  }
  if (entity.kind === "arc" && curve.kind === "arc") {
    const start = atStart ? to : arcPoint(curve.arc, 0);
    const end = atStart ? arcPoint(curve.arc, 1) : to;
    const through = arcPoint(curve.arc, 0.5);
    const grown = arcFrom3(start, through, end) ?? arcFrom3(start, arcPoint(curve.arc, atStart ? 0.25 : 0.75), end);
    if (!grown) return sketch;
    const mid = arcPoint(grown, 0.5);
    const which = atStart ? "a" : "b";
    const placed = place(sketch, to);
    let next = pointEntity(placed.sketch, entity.id, which, placed.id);
    next = {
      ...next,
      entities: next.entities.map((item) => (item.id === entity.id && item.kind === "arc" ? { ...item, through: mid } : item)),
    };
    return next;
  }
  if (entity.kind === "spline") {
    const endId = atStart ? entity.through[0]! : entity.through[entity.through.length - 1]!;
    const placed = place(sketch, to);
    const line = addLine(placed.sketch, endId, placed.id, entity.construction);
    return line.sketch;
  }
  return sketch;
}

function entityFromSpan(sketch: SketchData, entity: SketchEntity, curve: Curve, t0: number, t1: number): SketchData | null {
  const a = pointOn(curve, t0);
  const b = pointOn(curve, t1);
  if (samePt(a, b) && !(curve.kind === "circle" && t1 - t0 > 0.5)) return null;
  if (curve.kind === "line" || (curve.kind === "arc" && entity.kind === "line")) {
    const start = place(sketch, a);
    const end = place(start.sketch, b);
    return addLine(end.sketch, start.id, end.id, entity.construction).sketch;
  }
  if (curve.kind === "arc" || curve.kind === "circle") {
    const mid = pointOn(curve, (t0 + t1) / 2);
    const start = place(sketch, a);
    const end = place(start.sketch, b);
    const arc = arcFrom3(a, mid, b);
    if (!arc) return addLine(end.sketch, start.id, end.id, entity.construction).sketch;
    return addArc(end.sketch, start.id, end.id, mid, entity.construction).sketch;
  }
  if (curve.kind === "spline" && entity.kind === "spline") {
    const points = keptSpline(curve, t0, t1);
    if (points.length < 2) return null;
    return addSpline(sketch, points, entity.construction).sketch;
  }
  return null;
}

/**
 * The points of the spline kept between `t0` and `t1`: the cut ends and the old spline's own points between them, so
 * the piece keeps its shape with a handful of points. Where the new curve strays more than 0.02 mm from the old one,
 * the old curve's sample farthest off is added, until it follows; never every 0.5 mm sample.
 */
function keptSpline(curve: Extract<Curve, { kind: "spline" }>, t0: number, t1: number): Pt[] {
  const span = sampledSpan(curve.samples, t0, t1);
  if (span.length < 2) return [];
  const picked = new Set<number>([0, span.length - 1]);
  for (const control of curve.controls) {
    const t = projectToSpline(curve.samples, control, curve.closed)?.t ?? -1;
    if (!(t > t0 + 1e-6 && t < t1 - 1e-6)) continue;
    let nearest = 0;
    span.forEach((point, index) => {
      if (dist(point, control) < dist(span[nearest]!, control)) nearest = index;
    });
    picked.add(nearest);
  }
  const points = () => [...picked].sort((a, b) => a - b).map((index) => [span[index]![0], span[index]![1]] as Pt);
  // Each pass adds the sample farthest off between every two kept points, so a long wave settles in a few passes.
  for (let pass = 0; pass < 12 && picked.size < Math.min(span.length, SPLINE_THROUGH_MAX + 2); pass += 1) {
    const redrawn = sampleSpline(points(), false);
    const kept = [...picked].sort((a, b) => a - b);
    let added = false;
    for (let k = 1; k < kept.length; k += 1) {
      let worst = -1;
      let worstGap = 0.02;
      // Only the redrawn samples near this stretch can be nearest, so a long wave is not searched end to end.
      const stretch = span.slice(kept[k - 1]!, kept[k]! + 1);
      const lo = [Math.min(...stretch.map((p) => p[0])) - 1, Math.min(...stretch.map((p) => p[1])) - 1];
      const hi = [Math.max(...stretch.map((p) => p[0])) + 1, Math.max(...stretch.map((p) => p[1])) + 1];
      const near = redrawn.filter((p) => p[0] >= lo[0]! && p[0] <= hi[0]! && p[1] >= lo[1]! && p[1] <= hi[1]!);
      for (let index = kept[k - 1]! + 1; index < kept[k]!; index += 1) {
        const gap = near.length >= 2 ? projectToSpline(near, span[index]!)?.distance ?? Infinity : Infinity;
        if (gap > worstGap) {
          worst = index;
          worstGap = gap;
        }
      }
      if (worst >= 0 && picked.size < SPLINE_THROUGH_MAX + 2) {
        picked.add(worst);
        added = true;
      }
    }
    if (!added) break;
  }
  return points();
}

function sampledSpan(samples: readonly Pt[], t0: number, t1: number): Pt[] {
  if (samples.length < 2) return [];
  const lengths: number[] = [];
  let total = 0;
  for (let i = 0; i < samples.length - 1; i++) {
    const length = dist(samples[i]!, samples[i + 1]!);
    lengths.push(length);
    total += length;
  }
  if (total <= EPS) return [];
  const out: Pt[] = [pointAlong(samples, lengths, total, t0)];
  let covered = 0;
  for (let i = 0; i < lengths.length; i++) {
    covered += lengths[i]!;
    const t = covered / total;
    if (t > t0 + 1e-6 && t < t1 - 1e-6) out.push([samples[i + 1]![0], samples[i + 1]![1]]);
  }
  out.push(pointAlong(samples, lengths, total, Math.min(1, t1)));
  return out;
}

function pointAlong(samples: readonly Pt[], lengths: number[], total: number, t: number): Pt {
  let target = Math.min(1, Math.max(0, t)) * total;
  for (let i = 0; i < lengths.length; i++) {
    const length = lengths[i]!;
    if (target <= length || i === lengths.length - 1) {
      const u = length <= EPS ? 0 : target / length;
      const a = samples[i]!;
      const b = samples[i + 1]!;
      return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u];
    }
    target -= length;
  }
  const last = samples[samples.length - 1]!;
  return [last[0], last[1]];
}

function spansOf(params: number[], closed: boolean): [number, number][] {
  const values: number[] = [];
  for (const param of params) {
    const value = closed ? wrap(param) : clamp(param);
    if (!values.some((kept) => Math.abs(kept - value) < 1e-8)) values.push(value);
  }
  values.sort((a, b) => a - b);
  if (!closed) {
    if (!values.some((value) => value <= 1e-8)) values.unshift(0);
    if (!values.some((value) => value >= 1 - 1e-8)) values.push(1);
    const spans: [number, number][] = [];
    for (let i = 0; i < values.length - 1; i++) {
      if (values[i + 1]! - values[i]! > 1e-8) spans.push([values[i]!, values[i + 1]!]);
    }
    return spans;
  }
  if (!values.length) return [[0, 1]];
  const spans: [number, number][] = [];
  for (let i = 0; i < values.length; i++) {
    const t0 = values[i]!;
    const t1 = i + 1 < values.length ? values[i + 1]! : values[0]! + 1;
    if (t1 - t0 > 1e-8) spans.push([t0, t1]);
  }
  return spans;
}

function inSpan(t: number, t0: number, t1: number): boolean {
  let value = t;
  if (value < t0 - 1e-8) value += 1;
  return value >= t0 - 1e-7 && value <= t1 + 1e-7;
}

function spanLength(curve: Curve, t0: number, t1: number): number {
  if (curve.kind === "line") return dist(pointOn(curve, t0), pointOn(curve, t1));
  if (curve.kind === "arc") return Math.abs((t1 - t0) * curve.arc.sweep) * curve.arc.radius;
  if (curve.kind === "circle") return (t1 - t0) * curve.radius * Math.PI * 2;
  return dist(pointOn(curve, t0), pointOn(curve, Math.min(1, t1)));
}

function copyWith(sketch: SketchData, entityIds: readonly number[], xform: (pt: Pt) => Pt): EditResult {
  const map = new Map<number, number>();
  let next = sketch;
  const pointFor = (id: number): number => {
    const cached = map.get(id);
    if (cached !== undefined) return cached;
    const point = sketchPoint(next, id);
    if (!point) return id;
    const added = addPoint(next, xform(point.at), point.fixed);
    next = added.sketch;
    map.set(id, added.id);
    return added.id;
  };
  let copied = 0;
  for (const id of entityIds) {
    const entity = sketchEntity(sketch, id);
    if (!entity) continue;
    copied += 1;
    if (entity.kind === "line") {
      const a = pointFor(entity.a);
      const b = pointFor(entity.b);
      next = addLine(next, a, b, entity.construction).sketch;
    } else if (entity.kind === "arc") {
      const a = pointFor(entity.a);
      const b = pointFor(entity.b);
      const through = xform(entity.through);
      next = addArc(next, a, b, through, entity.construction).sketch;
    } else if (entity.kind === "circle") {
      const centre = pointFor(entity.centre);
      next = addCircle(next, centre, entity.radius, entity.construction).sketch;
    } else {
      const through = entity.through.map((pid) => pointFor(pid));
      next = addSpline(next, through, entity.construction).sketch;
    }
  }
  if (!copied) return { sketch, error: "Select something to copy." };
  return { sketch: next };
}

function retargetLine(sketch: SketchData, line: Extract<SketchEntity, { kind: "line" }>, cornerId: number | null, cornerAt: Pt, tangent: Pt): SketchData {
  const a = sketchPoint(sketch, line.a);
  const b = sketchPoint(sketch, line.b);
  if (!a || !b) return sketch;
  const which = cornerId === line.a || (cornerId === null && samePt(a.at, cornerAt)) ? "a" : "b";
  const placed = place(sketch, tangent);
  return pointEntity(placed.sketch, line.id, which, placed.id);
}

function sharedPoint(a: Extract<SketchEntity, { kind: "line" }>, b: Extract<SketchEntity, { kind: "line" }>): number | null {
  if (a.a === b.a || a.a === b.b) return a.a;
  if (a.b === b.a || a.b === b.b) return a.b;
  return null;
}

function pointEntity(sketch: SketchData, entityId: number, which: "a" | "b", pointId: number): SketchData {
  return {
    ...sketch,
    entities: sketch.entities.map((entity) => {
      if (entity.id !== entityId) return entity;
      if ((entity.kind === "line" || entity.kind === "arc") && (which === "a" || which === "b")) {
        return which === "a" ? { ...entity, a: pointId } : { ...entity, b: pointId };
      }
      return entity;
    }),
  };
}

function dropEntity(sketch: SketchData, id: number): SketchData {
  return { ...sketch, entities: sketch.entities.filter((entity) => entity.id !== id) };
}

function place(sketch: SketchData, pt: Pt): { sketch: SketchData; id: number } {
  const found = pointNear(sketch, pt, EPS);
  if (found) return { sketch, id: found.id };
  return addPoint(sketch, pt);
}

function radial(centre: Pt, point: Pt, radius: number): Pt {
  const hit = projectToCircle(centre, radius, point);
  return hit ? hit.pt : point;
}

function midpoint(a: Pt, b: Pt): Pt {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}

function keyOf(pt: Pt): string {
  return `${Math.round(pt[0] / EPS)}:${Math.round(pt[1] / EPS)}`;
}

function isClosed(curve: Curve): boolean {
  return curve.kind === "circle" || (curve.kind === "spline" && curve.closed);
}

function wrap(t: number): number {
  let value = t % 1;
  if (value < 0) value += 1;
  if (value > 1 - 1e-9) return 0;
  return value;
}

function clamp(t: number): number {
  if (t < 0) return 0;
  if (t > 1) return 1;
  return t;
}
