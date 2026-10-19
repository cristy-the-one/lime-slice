/**
 * Picking sketch geometry on the plane and in a screen box.
 * Left-to-right selects what is enclosed. Right-to-left selects what the box crosses.
 */
import { curveOf, pointOn, type Curve } from "./geom.ts";
import { sketchPoint, type Pt, type SketchData, type SketchEntity } from "./model.ts";

export interface Screen {
  x: number;
  y: number;
}

export interface ScreenBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface SketchHit {
  point: number | null;
  entity: number | null;
}

/** The point under `at`, or the entity, within `tolMm`. A point wins over the curve it sits on. */
export function hitSketch(sketch: SketchData, at: Pt, tolMm: number): SketchHit {
  const tol = Math.max(tolMm, 1e-6);
  let point: number | null = null;
  let best = tol;
  for (const item of sketch.points) {
    const dist = Math.hypot(item.at[0] - at[0], item.at[1] - at[1]);
    if (dist <= best) {
      best = dist;
      point = item.id;
    }
  }
  if (point != null) return { point, entity: null };
  let entity: number | null = null;
  best = tol;
  for (const item of sketch.entities) {
    const curve = curveOf(sketch, item);
    if (!curve) continue;
    const dist = curveDistance(curve, at);
    if (dist != null && dist <= best) {
      best = dist;
      entity = item.id;
    }
  }
  return { point: null, entity };
}

export interface BoxPick {
  entities: number[];
  points: number[];
}

/**
 * `project` maps a plane point to the screen. A point the camera cannot see is skipped.
 * `crossing` is a right-to-left box: an entity counts when the box touches it. Otherwise
 * every sample of the entity has to sit inside the box.
 */
export function boxPick(
  sketch: SketchData,
  box: ScreenBox,
  crossing: boolean,
  project: (at: Pt) => Screen | null,
): BoxPick {
  const points: number[] = [];
  for (const point of sketch.points) {
    const screen = project(point.at);
    if (screen && inside(screen, box)) points.push(point.id);
  }
  const entities: number[] = [];
  for (const entity of sketch.entities) {
    const samples = entitySamples(sketch, entity);
    if (samples.length === 0) continue;
    const screens = samples.map((at) => project(at));
    if (screens.some((screen) => screen == null)) {
      if (!crossing) continue;
    }
    const known = screens.filter((screen): screen is Screen => screen != null);
    if (known.length === 0) continue;
    const hits = known.some((screen) => inside(screen, box)) || (crossing && known.length >= 2 && segmentCrosses(known, box));
    const enclosed = known.length === samples.length && known.every((screen) => inside(screen, box));
    if (crossing ? hits : enclosed) entities.push(entity.id);
  }
  return { entities, points };
}

/** Screen x of the release is left of the press: the box was dragged right to left. */
export function boxCrosses(startX: number, endX: number): boolean {
  return endX < startX;
}

function curveDistance(curve: Curve, at: Pt): number | null {
  if (curve.kind === "line") return segmentDistance(curve.a, curve.b, at);
  if (curve.kind === "circle") return Math.abs(Math.hypot(at[0] - curve.centre[0], at[1] - curve.centre[1]) - curve.radius);
  const samples = curve.kind === "arc" ? arcSamples(curve) : curve.samples;
  let best = Infinity;
  for (let i = 1; i < samples.length; i += 1) {
    const dist = segmentDistance(samples[i - 1]!, samples[i]!, at);
    if (dist != null && dist < best) best = dist;
  }
  return Number.isFinite(best) ? best : null;
}

function segmentDistance(a: Pt, b: Pt, at: Pt): number | null {
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const length = abx * abx + aby * aby;
  const t = length === 0 ? 0 : Math.max(0, Math.min(1, ((at[0] - a[0]) * abx + (at[1] - a[1]) * aby) / length));
  return Math.hypot(at[0] - (a[0] + abx * t), at[1] - (a[1] + aby * t));
}

function arcSamples(curve: Extract<Curve, { kind: "arc" }>): Pt[] {
  const steps = 8;
  const out: Pt[] = [];
  for (let i = 0; i <= steps; i += 1) out.push(pointOn(curve, i / steps));
  return out;
}

function entitySamples(sketch: SketchData, entity: SketchEntity): Pt[] {
  const curve = curveOf(sketch, entity);
  if (!curve) return [];
  if (curve.kind === "line") return [curve.a, curve.b];
  if (curve.kind === "circle") {
    const out: Pt[] = [];
    for (let i = 0; i < 8; i += 1) out.push(pointOn(curve, i / 8));
    return out;
  }
  if (curve.kind === "arc") return arcSamples(curve);
  return curve.samples;
}

function inside(screen: Screen, box: ScreenBox): boolean {
  const x0 = Math.min(box.x0, box.x1);
  const x1 = Math.max(box.x0, box.x1);
  const y0 = Math.min(box.y0, box.y1);
  const y1 = Math.max(box.y0, box.y1);
  return screen.x >= x0 && screen.x <= x1 && screen.y >= y0 && screen.y <= y1;
}

/** True when some consecutive pair of projected samples crosses the box without both ends inside. */
function segmentCrosses(samples: Screen[], box: ScreenBox): boolean {
  for (let i = 1; i < samples.length; i += 1) {
    if (lineHitsRect(samples[i - 1]!, samples[i]!, box)) return true;
  }
  return false;
}

function lineHitsRect(a: Screen, b: Screen, box: ScreenBox): boolean {
  const x0 = Math.min(box.x0, box.x1);
  const x1 = Math.max(box.x0, box.x1);
  const y0 = Math.min(box.y0, box.y1);
  const y1 = Math.max(box.y0, box.y1);
  if (inside(a, box) || inside(b, box)) return true;
  return (
    segments(a, b, { x: x0, y: y0 }, { x: x1, y: y0 }) ||
    segments(a, b, { x: x1, y: y0 }, { x: x1, y: y1 }) ||
    segments(a, b, { x: x1, y: y1 }, { x: x0, y: y1 }) ||
    segments(a, b, { x: x0, y: y1 }, { x: x0, y: y0 })
  );
}

function segments(a: Screen, b: Screen, c: Screen, d: Screen): boolean {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const cdx = d.x - c.x;
  const cdy = d.y - c.y;
  const denom = abx * cdy - aby * cdx;
  if (Math.abs(denom) < 1e-9) return false;
  const t = ((c.x - a.x) * cdy - (c.y - a.y) * cdx) / denom;
  const u = ((c.x - a.x) * aby - (c.y - a.y) * abx) / denom;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1;
}

/** The points an entity names, for a drag that moves the whole entity. */
export function entityPointIds(sketch: SketchData, entityId: number): number[] {
  const entity = sketch.entities.find((item) => item.id === entityId);
  if (!entity) return [];
  if (entity.kind === "line" || entity.kind === "arc") return [entity.a, entity.b];
  if (entity.kind === "circle") return [entity.centre];
  return [...entity.through];
}

export function pointAt(sketch: SketchData, id: number): Pt | null {
  return sketchPoint(sketch, id)?.at ?? null;
}
