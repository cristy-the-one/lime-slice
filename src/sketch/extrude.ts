/**
 * --- F1 / E1. Extrude a sketch's regions, and reopen that extrude from history. ---
 *
 * The sketch stays the editing state. The op stores a copy as `sketch`, and the kernel never
 * reads it. A single outline of straight lines that needs a second depth, a draft, or a face to
 * stop at is sent as a point profile, as it always was. An arc, a spline, or a hole sends its
 * loops with those fields: the kernel builds them on the same face.
 */
import { arcFrom3, arcPoint, curveOf, dist, pointOn, projectToArc, projectToSegment, projectToSpline, sampleSpline } from "./geom.ts";
import { frameOf, toPlane, type SketchFrame } from "./frame.ts";
import { emptySketch, sketchEntity, sketchJson, type Pt, type SketchData, type Vec3 } from "./model.ts";
import { loopSignedArea, regionAt, sketchRegions, toLoops, type ProfileLoop, type ProfileSegment, type Region } from "./regions.ts";
import { extrudeOp, type ProfilePlane } from "../model-request.ts";
import { isSketchExtrudeGroup, type BooleanKind, type ExtrudeOp, type FaceRef, type GroupOp, type ModelOp, type ProfileLoop as EngineLoop, type ProfileSegment as EngineSegment, type Vec2 } from "../model-tree.ts";
import { copyLoops, drawLoop, lineLoop } from "./loops.ts";

/** A point on a boundary is this close, in millimetres. Winding is 0 exactly on the line. */
const NEAR_MM = 0.05;
/** Two sides this close are the centred extrude. */
const EQUAL_MM = 1e-4;

export const DRAFT_UP_TO_REFUSAL = "A draft up to a face is not available yet. Drop the draft, or drop the face and set a depth.";
export const UP_TO_SECOND_REFUSAL = "An extrude up to a face starts at the profile. Drop the second depth.";
export const DEPTH_REFUSAL = "An extrude needs a depth other than 0.";
/** The engine takes a profile of at most this many loops: the outline and its holes. */
export const PROFILE_LOOPS_MAX = 32;

/** Null when `loops` fit one profile; otherwise what to do, in words. */
export function tooManyHoles(loops: number): string | null {
  if (loops <= PROFILE_LOOPS_MAX) return null;
  return `This region has ${loops - 1} holes, and one profile takes ${PROFILE_LOOPS_MAX - 1}. Apply it with ${PROFILE_LOOPS_MAX - 1} or fewer holes, then cut the rest from a second sketch.`;
}

export type ModeChoice = "auto" | "new" | "fuse" | "cut" | "common";
export type ResolvedMode = "new" | BooleanKind;

export interface ExtrudeDraft {
  sketch: SketchData;
  regions: readonly Region[];
  distance: number;
  /** Null, or 0, leaves the other side off. */
  depth2: number | null;
  /** Null, or 0, leaves the draft off. */
  draftDeg: number | null;
  upTo: number | FaceRef | null;
  mode: ResolvedMode;
}

export interface ExtrudePreset {
  distance: number;
  depth2: number | null;
  draftDeg: number | null;
  upTo: number | FaceRef | null;
  choice: ModeChoice;
}

/** An extrude, or a group of sketch extrudes, reopens the sketch editor. */
export function opensSketchEditor(op: ModelOp): boolean {
  return op.kind === "extrude" || isSketchExtrudeGroup(op);
}

/** The extrude an edit starts from. A group uses its first extrude. */
export function featureExtrude(op: ModelOp): ExtrudeOp | null {
  if (op.kind === "extrude") return op;
  if (isSketchExtrudeGroup(op)) {
    const step = op.steps.find((item): item is ExtrudeOp => item.kind === "extrude");
    return step ?? null;
  }
  return null;
}

/**
 * The sketch to draw again. A stored `sketch` is copied. Without one, the loops or the point
 * profile become lines and arcs on the op's plane. Null when there is no outline.
 */
export function sketchForFeature(op: ModelOp): SketchData | null {
  const extrude = featureExtrude(op);
  if (!extrude) return null;
  if (extrude.sketch) return sketchJson(extrude.sketch);
  const plane = { origin: [...extrude.origin] as Vec3, turn: [...extrude.turn] as Vec3 };
  const loops = extrude.loops ?? (extrude.profile ? [lineLoop(extrude.profile)] : null);
  if (!loops || loops.length === 0) return null;
  let sketch = emptySketch(plane);
  for (const loop of loops) sketch = drawLoop(sketch, loop);
  return sketch.entities.length > 0 ? sketch : null;
}

/** The drag an edit opens with. A centred extrude is two equal sides. A root is a new object. */
export function presetOf(op: ModelOp, root: boolean): ExtrudePreset | null {
  const extrude = featureExtrude(op);
  if (!extrude) return null;
  const choice: ModeChoice = root ? "new" : extrude.op;
  if (extrude.symmetric) {
    const side = Math.abs(extrude.depth) / 2;
    return { distance: side, depth2: side, draftDeg: extrude.draftDeg ?? null, upTo: null, choice };
  }
  return {
    distance: extrude.depth,
    depth2: extrude.depth2 ?? null,
    draftDeg: extrude.draftDeg ?? null,
    upTo: extrude.upTo ?? null,
    choice,
  };
}

/** The outer outline of each extrude a stored op made: one per region it was applied to. */
export function featureOutlines(op: ModelOp): ProfileLoop[] {
  const steps = op.kind === "extrude" ? [op] : isSketchExtrudeGroup(op) ? op.steps.filter((step): step is ExtrudeOp => step.kind === "extrude") : [];
  return outlinesOf(steps);
}

/** Each step's outer loop, or its point profile as a loop. */
export function outlinesOf(steps: readonly { loops?: readonly EngineLoop[]; profile?: readonly Vec2[] }[]): ProfileLoop[] {
  const out: ProfileLoop[] = [];
  for (const step of steps) {
    const outer = step.loops?.[0];
    if (outer) out.push({ start: [outer.start[0], outer.start[1]], segments: outer.segments.map(copySegment) });
    else if (step.profile && step.profile.length >= 3) out.push(lineLoop(step.profile));
  }
  return out;
}

/**
 * The regions of `sketch` a stored feature was applied to, so an edit reopens with each of them picked. A region whose
 * outline is the stored one is that region; after the drawing moved, the region holding a point inside the stored outline
 * is. Empty when the drawing has none of them.
 */
export function regionsOfOutlines(sketch: SketchData, outlines: readonly ProfileLoop[]): Region[] {
  const regions = sketchRegions(sketch);
  const out: Region[] = [];
  for (const outline of outlines) {
    const inside = pointInside(outline);
    const hit = regions.find((region) => sameLoop(region.outer, outline)) ?? (inside ? regionAt(regions, inside) : null);
    if (hit && !out.includes(hit)) out.push(hit);
  }
  return dropHoles(out);
}

/**
 * Regions to extrude. Selected entities win, then the region under the pointer, then the only
 * outer region: a washer's ring, not its hole. A hole is dropped when its ring is selected too:
 * the ring's loops already include it.
 */
export function chooseRegions(sketch: SketchData, selected: readonly number[], cursor: Pt | null): Region[] {
  const regions = sketchRegions(sketch);
  if (regions.length === 0) return [];
  let chosen: Region[] = [];
  if (selected.length > 0) {
    const points = selected.map((id) => entityPoint(sketch, id)).filter((pt): pt is Pt => pt != null);
    chosen = regions.filter((region) => points.some((pt) => regionOwns(region, pt)));
  }
  if (chosen.length === 0 && cursor) {
    const hit = regionAt(regions, cursor) ?? regions.find((region) => distToLoop(region.outer, cursor) <= NEAR_MM) ?? null;
    if (hit) chosen = [hit];
  }
  if (chosen.length === 0) {
    const outer = dropHoles(regions);
    if (outer.length === 1) chosen = outer;
  }
  return dropHoles(chosen);
}

/** Area centre of the outer loop, for the arrow. */
export function regionCentroid(region: Region): Pt {
  const points = sampleLoop(region.outer);
  let twice = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    const cross = a[0] * b[1] - b[0] * a[1];
    twice += cross;
    cx += (a[0] + b[0]) * cross;
    cy += (a[1] + b[1]) * cross;
  }
  if (Math.abs(twice) < 1e-9) {
    const mean = points.reduce((sum, pt) => [sum[0] + pt[0], sum[1] + pt[1]] as Pt, [0, 0] as Pt);
    return points.length ? [mean[0] / points.length, mean[1] / points.length] : [0, 0];
  }
  return [cx / (3 * twice), cy / (3 * twice)];
}

/** Average of the region centres. */
export function regionsCentroid(regions: readonly Region[]): Pt {
  if (regions.length === 0) return [0, 0];
  const sum = regions.reduce((at, region) => {
    const centre = regionCentroid(region);
    return [at[0] + centre[0], at[1] + centre[1]] as Pt;
  }, [0, 0] as Pt);
  return [sum[0] / regions.length, sum[1] / regions.length];
}

/**
 * Join, cut, intersect, or a new object. No solid is always a new object. Auto cuts when the sketch touches the solid
 * and the distance runs into it, and joins when it touches and runs out. A sketch that does not touch the solid is a new
 * object, as Fusion's and Onshape's default is, since the engine refuses to join two solids that do not meet. A step
 * edit stays on its solid, so Auto joins there.
 */
export function resolveExtrudeMode(input: { choice: ModeChoice; hasSolid: boolean; touches: boolean; distance: number; lockNew: boolean; stepEdit?: boolean }): ResolvedMode {
  if (input.lockNew || !input.hasSolid) return "new";
  if (input.choice !== "auto") return input.choice;
  if (!input.touches) return input.stepEdit ? "fuse" : "new";
  return input.distance < 0 ? "cut" : "fuse";
}

export function cycleMode(choice: ModeChoice, lock: "root" | "step" | null): ModeChoice {
  if (lock === "root") return "new";
  const order: ModeChoice[] = lock === "step" ? ["auto", "fuse", "cut", "common"] : ["auto", "new", "fuse", "cut", "common"];
  const at = order.indexOf(choice);
  return order[(at + 1) % order.length] ?? "auto";
}

export function modeLabel(mode: ResolvedMode): string {
  if (mode === "new") return "New object";
  if (mode === "fuse") return "Join";
  if (mode === "cut") return "Cut";
  return "Intersect";
}

/** The sketch plane meets the solid's box, and a region overlaps that box on the plane. A face sketch touches. */
export function sketchTouchesSolid(frame: SketchFrame, regions: readonly Region[], box: { min: Vec3; max: Vec3 } | null, onFace: boolean): boolean {
  if (onFace) return true;
  if (!box || regions.length === 0 || !planeMeetsAabb(frame, box, NEAR_MM)) return false;
  return regions.some((region) => regionOverlapsAabb(region, frame, box));
}

/** The op, with a copy of the sketch on each extrude. An error is the kernel's sentence and is not sent. */
export function buildSketchExtrude(draft: ExtrudeDraft): { op: ModelOp } | { error: string } {
  if (draft.regions.length === 0) return { error: "Select a region to extrude." };
  const distance = draft.distance;
  const depth2 = draft.depth2 != null && draft.depth2 > 0 ? draft.depth2 : null;
  const draftDeg = draft.draftDeg != null && draft.draftDeg !== 0 ? draft.draftDeg : null;
  const upTo = draft.mode === "new" ? null : draft.upTo;
  if (upTo && depth2 != null) return { error: UP_TO_SECOND_REFUSAL };
  if (upTo && draftDeg != null) return { error: DRAFT_UP_TO_REFUSAL };
  if (!upTo && distance === 0) return { error: DEPTH_REFUSAL };
  const symmetric = !upTo && depth2 != null && Math.abs(depth2 - Math.abs(distance)) <= EQUAL_MM;
  const steps: ExtrudeOp[] = [];
  for (const region of draft.regions) {
    const crowded = tooManyHoles(1 + region.holes.length);
    if (crowded) return { error: crowded };
    const built = oneExtrude(draft.sketch, region, {
      distance,
      depth2: symmetric ? null : depth2,
      draftDeg,
      upTo,
      symmetric,
      mode: draft.mode,
    });
    if ("error" in built) return built;
    steps.push(built.op);
  }
  if (steps.length === 1) return { op: steps[0]! };
  // One copy of the drawing is enough: an edit reopens the first step's, and finds each region again from the outlines.
  const group: GroupOp = { kind: "group", label: `Extrude ${steps.length} regions`, steps: steps.map((step, index) => (index === 0 ? step : withoutDrawing(step))) };
  return { op: group };
}

function withoutDrawing(step: ExtrudeOp): ExtrudeOp {
  const { sketch: _sketch, ...rest } = step;
  return rest;
}

/** Sampled outlines, in plane coordinates, for the extrude ghost. */
export function regionSamples(region: Region): Pt[][] {
  return toLoops(region).map((loop) => sampleLoop(loop));
}

function oneExtrude(
  sketch: SketchData,
  region: Region,
  extent: { distance: number; depth2: number | null; draftDeg: number | null; upTo: number | FaceRef | null; symmetric: boolean; mode: ResolvedMode },
): { op: ExtrudeOp } | { error: string } {
  const loops = toLoops(region);
  const needsPoint = extent.depth2 != null || extent.draftDeg != null || extent.upTo != null;
  const plane: ProfilePlane = { origin: [...sketch.plane.origin] as Vec3, turn: [...sketch.plane.turn] as Vec3 };
  const boolean: BooleanKind = extent.mode === "new" ? "fuse" : extent.mode;
  const depth = extent.symmetric ? 2 * Math.abs(extent.distance) : extent.distance;
  const fields = {
    ...(extent.depth2 != null ? { depth2: extent.depth2 } : {}),
    ...(extent.draftDeg != null ? { draftDeg: extent.draftDeg } : {}),
    ...(extent.upTo != null ? { upTo: extent.upTo } : {}),
  };
  const sketchCopy = sketchJson(sketch);
  const profile = needsPoint ? lineProfile(loops) : null;
  if (profile) return { op: { ...extrudeOp(boolean, plane, profile, depth, extent.symmetric, {}, fields), sketch: sketchCopy } };
  // Loops carry the extent fields too: the op is the plain one with them added.
  const op = extrudeOp(boolean, plane, [], depth, extent.symmetric, {}, copyLoops(loops));
  const extended = needsPoint ? { ...op, ...extentFields(extrudeOp(boolean, plane, [], depth, extent.symmetric, {}, fields)) } : op;
  return { op: { ...extended, sketch: sketchCopy } };
}

/** The second depth, draft, and face to stop at of `op`, each only when set. */
function extentFields(op: ExtrudeOp): Pick<ExtrudeOp, "depth2" | "draftDeg" | "upTo"> {
  return {
    ...(op.depth2 !== undefined ? { depth2: op.depth2 } : {}),
    ...(op.draftDeg !== undefined ? { draftDeg: op.draftDeg } : {}),
    ...(op.upTo !== undefined ? { upTo: op.upTo } : {}),
  };
}

/** A single all-line outline, or null when an arc, a spline, or a hole would make it more than points. */
function lineProfile(loops: readonly ProfileLoop[]): Vec2[] | null {
  const outer = loops[0];
  if (!outer || loops.length !== 1) return null;
  const points: Vec2[] = [[outer.start[0], outer.start[1]]];
  for (const segment of outer.segments) {
    if (segment.kind !== "line") return null;
    points.push([segment.to[0], segment.to[1]]);
  }
  const first = points[0]!;
  const last = points[points.length - 1]!;
  if (Math.hypot(last[0] - first[0], last[1] - first[1]) <= 1e-6) points.pop();
  return points.length >= 3 ? points : null;
}

function entityPoint(sketch: SketchData, id: number): Pt | null {
  const entity = sketchEntity(sketch, id);
  if (!entity) return null;
  const curve = curveOf(sketch, entity);
  if (!curve) return null;
  return pointOn(curve, curve.kind === "circle" ? 0 : 0.5);
}

function regionOwns(region: Region, pt: Pt): boolean {
  return regionAt([region], pt) != null || distToLoop(region.outer, pt) <= NEAR_MM;
}

function dropHoles(regions: readonly Region[]): Region[] {
  return regions.filter((region) => !regions.some((other) => other !== region && isHoleOf(region, other)));
}

function isHoleOf(inner: Region, outer: Region): boolean {
  if (inner.area >= outer.area - 1e-6) return false;
  return outer.holes.some((hole) => sameLoop(hole, inner.outer));
}

function sameLoop(a: ProfileLoop, b: ProfileLoop): boolean {
  const areaA = Math.abs(loopSignedArea(a));
  const areaB = Math.abs(loopSignedArea(b));
  if (Math.abs(areaA - areaB) > 1e-3 * Math.max(1, areaA)) return false;
  return sampleLoop(a).every((pt) => distToLoop(b, pt) <= NEAR_MM);
}

export function sampleLoop(loop: ProfileLoop): Pt[] {
  const points: Pt[] = [];
  let prev = loop.start;
  const push = (pt: Pt) => {
    const last = points[points.length - 1];
    if (!last || dist(last, pt) > 1e-6) points.push(pt);
  };
  push(prev);
  for (const segment of loop.segments) {
    if (segment.kind === "line") push(segment.to);
    else if (segment.kind === "arc") {
      const arc = arcFrom3(prev, segment.through, segment.to);
      if (!arc) push(segment.to);
      else for (let step = 1; step <= 8; step += 1) push(arcPoint(arc, step / 8));
    } else {
      for (const pt of sampleSpline([prev, ...segment.through, segment.to], false, 1)) push(pt);
    }
    prev = segment.to;
  }
  const first = points[0];
  const last = points[points.length - 1];
  if (first && last && dist(first, last) <= 1e-6) points.pop();
  return points;
}

function copySegment(segment: EngineSegment): ProfileSegment {
  if (segment.kind === "line") return { kind: "line", to: [segment.to[0], segment.to[1]] };
  if (segment.kind === "arc") return { kind: "arc", through: [segment.through[0], segment.through[1]], to: [segment.to[0], segment.to[1]] };
  return { kind: "spline", through: segment.through.map((pt) => [pt[0], pt[1]] as Pt), to: [segment.to[0], segment.to[1]] };
}

/** A point inside a closed outline: its area centre when that is inside, else a hair inside the middle of an edge. */
function pointInside(loop: ProfileLoop): Pt | null {
  const poly = sampleLoop(loop);
  if (poly.length < 3) return null;
  const centre = regionCentroid({ outer: loop, holes: [], area: 0 });
  if (windingOf(poly, centre) !== 0) return centre;
  let twice = 0;
  for (let i = 0; i < poly.length; i += 1) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    twice += a[0] * b[1] - b[0] * a[1];
  }
  const side = twice >= 0 ? 1 : -1;
  for (let i = 0; i < poly.length; i += 1) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    const length = dist(a, b);
    if (length < 1e-9) continue;
    const left: Pt = [(-(b[1] - a[1]) / length) * side, ((b[0] - a[0]) / length) * side];
    for (const step of [1e-3, 1e-2, 0.1, 1]) {
      const pt: Pt = [(a[0] + b[0]) / 2 + left[0] * step, (a[1] + b[1]) / 2 + left[1] * step];
      if (windingOf(poly, pt) !== 0) return pt;
    }
  }
  return null;
}

function windingOf(poly: readonly Pt[], pt: Pt): number {
  let wind = 0;
  for (let i = 0; i < poly.length; i += 1) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    const across = (b[0] - a[0]) * (pt[1] - a[1]) - (b[1] - a[1]) * (pt[0] - a[0]);
    if (a[1] <= pt[1]) {
      if (b[1] > pt[1] && across > 0) wind += 1;
    } else if (b[1] <= pt[1] && across < 0) wind -= 1;
  }
  return wind;
}

function distToLoop(loop: ProfileLoop, pt: Pt): number {
  let best = Infinity;
  let prev = loop.start;
  for (const segment of loop.segments) {
    best = Math.min(best, distToSegment(prev, segment, pt));
    prev = segment.to;
  }
  return best;
}

function distToSegment(from: Pt, segment: ProfileSegment, pt: Pt): number {
  if (segment.kind === "line") return projectToSegment(from, segment.to, pt)?.distance ?? dist(pt, from);
  if (segment.kind === "arc") {
    const arc = arcFrom3(from, segment.through, segment.to);
    return arc ? projectToArc(arc, pt).distance : (projectToSegment(from, segment.to, pt)?.distance ?? dist(pt, from));
  }
  const samples = sampleSpline([from, ...segment.through, segment.to], false, 0.5);
  return projectToSpline(samples, pt)?.distance ?? dist(pt, from);
}

function planeMeetsAabb(frame: SketchFrame, box: { min: Vec3; max: Vec3 }, tol: number): boolean {
  let min = Infinity;
  let max = -Infinity;
  for (const corner of aabbCorners(box)) {
    const height = toPlane(frame, corner).height;
    min = Math.min(min, height);
    max = Math.max(max, height);
  }
  return min <= tol && max >= -tol;
}

function regionOverlapsAabb(region: Region, frame: SketchFrame, box: { min: Vec3; max: Vec3 }): boolean {
  let minU = Infinity;
  let maxU = -Infinity;
  let minV = Infinity;
  let maxV = -Infinity;
  for (const corner of aabbCorners(box)) {
    const uv = toPlane(frame, corner).uv;
    minU = Math.min(minU, uv[0]);
    maxU = Math.max(maxU, uv[0]);
    minV = Math.min(minV, uv[1]);
    maxV = Math.max(maxV, uv[1]);
  }
  let left = Infinity;
  let right = -Infinity;
  let bottom = Infinity;
  let top = -Infinity;
  for (const pt of sampleLoop(region.outer)) {
    left = Math.min(left, pt[0]);
    right = Math.max(right, pt[0]);
    bottom = Math.min(bottom, pt[1]);
    top = Math.max(top, pt[1]);
  }
  return right >= minU && left <= maxU && top >= minV && bottom <= maxV;
}

function aabbCorners(box: { min: Vec3; max: Vec3 }): Vec3[] {
  const [x0, y0, z0] = box.min;
  const [x1, y1, z1] = box.max;
  return [
    [x0, y0, z0], [x1, y0, z0], [x0, y1, z0], [x1, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x0, y1, z1], [x1, y1, z1],
  ];
}

/** The solid-frame plane a sketch stores. The extrude uses it directly. */
export function solidFrameOf(sketch: SketchData): SketchFrame {
  return frameOf(sketch.plane);
}
