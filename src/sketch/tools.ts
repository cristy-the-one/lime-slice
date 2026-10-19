/**
 * --- S3 drawing tools ---
 * Circle, arc, polygon, slot, spline, trim, offset, fillet corner, construction, and use.
 * Pure geometry and the gesture. The editor shell (`session.ts`) owns undo, snapping, and the
 * heads-up box. No solver: a typed size or a drag places the geometry directly.
 */
import { filletCorner, offset, trim } from "./edit.ts";
import {
  arcFrom3,
  arcPoint,
  arcTangent,
  cornerFillet,
  curveOf,
  curveProject,
  dist,
  leftNormal,
  projectToLine,
  projectToSegment,
  projectToSpline,
  sampleSpline,
  tangentArc,
  unit,
  type ArcGeom,
  type Curve,
  type Pt,
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
import { refChain, type RefGeom } from "./refs.ts";

export const DRAW_TOOLS = ["circle", "arc", "polygon", "slot", "spline", "trim", "offset", "fillet", "construction", "use"] as const;
export type DrawTool = (typeof DRAW_TOOLS)[number];

export function isDrawTool(tool: string): tool is DrawTool {
  return (DRAW_TOOLS as readonly string[]).includes(tool);
}

export const DRAW_MENU: { tool: DrawTool; label: string; shortcut: string }[] = [
  { tool: "circle", label: "Circle", shortcut: "C" },
  { tool: "arc", label: "Arc", shortcut: "A" },
  { tool: "polygon", label: "Polygon", shortcut: "N" },
  { tool: "slot", label: "Slot", shortcut: "Shift+S" },
  { tool: "spline", label: "Spline", shortcut: "B" },
  { tool: "trim", label: "Trim", shortcut: "T" },
  { tool: "offset", label: "Offset", shortcut: "F" },
  { tool: "fillet", label: "Fillet corner", shortcut: "G" },
  { tool: "construction", label: "Construction", shortcut: "X" },
  { tool: "use", label: "Use", shortcut: "U" },
];

export interface DrawSelection {
  entities: number[];
  points: number[];
}

export type DrawGesture =
  | { kind: "circle"; centre: Pt }
  | { kind: "arc3"; a: Pt; b?: Pt }
  | { kind: "arcTan"; from: Pt; dir: Pt }
  | { kind: "polygon"; centre: Pt }
  | { kind: "slot"; first: Pt; second?: Pt }
  | { kind: "spline"; points: number[]; entity: number | null }
  | { kind: "offset"; ids: number[]; origin: Pt; normal: Pt; sense: 1 | -1; distance: number; sx: number; sy: number; armed: boolean }
  | { kind: "fillet"; line: number; sx: number; sy: number }
  | { kind: "filletReady"; lines: [number, number]; radius: number; sx: number; sy: number; armed: boolean };

export interface DrawState {
  /** Remembered between polygons. At least 3. */
  sides: number;
  gesture: DrawGesture | null;
  /** A refusal, shown until the next click. */
  note: string | null;
  /** Shift+A: the next arc click is tangent to the last line. */
  tangentArm: boolean;
  /** The HUD numbers last typed, so the edited field can be told from the live ones. */
  hud: number[] | null;
}

export interface DrawField {
  id: string;
  label: string;
  unit: string;
  value: number;
  places?: number;
}

export interface DrawPointer {
  phase: "down" | "move" | "up";
  /** Snapped point on the plane. */
  at: Pt;
  /** The pointer before snapping, so a trim hits the piece that was clicked. */
  raw: Pt;
  sx: number;
  sy: number;
  shift: boolean;
  double?: boolean;
  hit: { point: number | null; entity: number | null };
  /** Index into the reference segments, or null. */
  ref: number | null;
  tolMm: number;
  selection: DrawSelection;
}

export interface DrawResult {
  sketch: SketchData;
  state: DrawState;
  selection: DrawSelection;
  /** Push an undo mark. The sketch before this call is the mark. */
  committed: boolean;
}

const MIN_SIDES = 3;
const MAX_SIDES = 360;

export function freshDraw(): DrawState {
  return { sides: 6, gesture: null, note: null, tangentArm: false, hud: null };
}

export function idleDraw(state: DrawState): DrawState {
  return { ...state, gesture: null, note: null, tangentArm: false, hud: null };
}

/** Where inference snaps from, while a tool is mid-gesture. */
export function drawAnchor(sketch: SketchData, state: DrawState, tool: DrawTool): { from?: Pt; dir?: Pt } {
  const gesture = state.gesture;
  if (tool === "circle" && gesture?.kind === "circle") return { from: gesture.centre };
  if (tool === "arc" && gesture?.kind === "arc3") return gesture.b ? { from: gesture.b, dir: sub(gesture.b, gesture.a) } : { from: gesture.a };
  if (tool === "arc" && gesture?.kind === "arcTan") return { from: gesture.from, dir: gesture.dir };
  if (tool === "polygon" && gesture?.kind === "polygon") return { from: gesture.centre };
  if (tool === "slot" && gesture?.kind === "slot") return gesture.second ? { from: gesture.second, dir: sub(gesture.second, gesture.first) } : { from: gesture.first };
  if (tool === "spline" && gesture?.kind === "spline" && gesture.points.length) {
    const from = sketchPoint(sketch, gesture.points[gesture.points.length - 1]!)?.at;
    const prev = gesture.points.length >= 2 ? sketchPoint(sketch, gesture.points[gesture.points.length - 2]!)?.at : undefined;
    if (from && prev) return { from, dir: sub(from, prev) };
    if (from) return { from };
  }
  return {};
}

export function drawReadout(tool: DrawTool): string {
  switch (tool) {
    case "circle":
      return "Circle. Click the centre, then a point on the radius. Type a diameter.";
    case "arc":
      return "Arc. Click the start, the end, and a point on the arc. Hold Shift for an arc tangent to the last line. Type a radius and a sweep.";
    case "polygon":
      return "Polygon. Click the centre, then a corner. Type across corners, across flats, and the sides.";
    case "slot":
      return "Slot. Click the first centre, the second centre, then the width. Type a length and a width.";
    case "spline":
      return "Spline. Click through the points. Double-click or Esc ends it. Click the start point to close.";
    case "trim":
      return "Trim. Click the piece to remove.";
    case "offset":
      return "Offset. Click a line or a chain and drag, or type a distance.";
    case "fillet":
      return "Fillet corner. Click two lines that meet and drag the radius, or type it.";
    case "construction":
      return "Construction. Click a line to toggle it. X toggles the selection.";
    case "use":
      return "Use. Click a faint edge, or the face outline, to copy it into the sketch.";
  }
}

export function drawDimensions(state: DrawState, tool: DrawTool, at: Pt | null): { kind: DrawTool; fields: DrawField[] } | null {
  if (!at) return null;
  const gesture = state.gesture;
  if (tool === "circle" && gesture?.kind === "circle") {
    return { kind: "circle", fields: [{ id: "diameter", label: "Diameter", unit: "mm", value: dist(gesture.centre, at) * 2 }] };
  }
  if (tool === "arc" && gesture?.kind === "arcTan") {
    const arc = tangentArc(gesture.from, gesture.dir, at);
    return {
      kind: "arc",
      fields: [
        { id: "radius", label: "Radius", unit: "mm", value: arc?.radius ?? 0 },
        { id: "sweep", label: "Sweep", unit: "°", value: arc ? (arc.sweep * 180) / Math.PI : 0 },
      ],
    };
  }
  if (tool === "arc" && gesture?.kind === "arc3" && gesture.b) {
    const arc = arcFrom3(gesture.a, at, gesture.b);
    return {
      kind: "arc",
      fields: [
        { id: "radius", label: "Radius", unit: "mm", value: arc?.radius ?? 0 },
        { id: "sweep", label: "Sweep", unit: "°", value: arc ? (arc.sweep * 180) / Math.PI : 0 },
      ],
    };
  }
  if (tool === "polygon" && gesture?.kind === "polygon") {
    const size = polygonSize(gesture.centre, at, state.sides);
    return {
      kind: "polygon",
      fields: [
        { id: "corners", label: "Across corners", unit: "mm", value: size.corners },
        { id: "flats", label: "Across flats", unit: "mm", value: size.flats },
        { id: "sides", label: "Sides", unit: "", value: state.sides, places: 0 },
      ],
    };
  }
  if (tool === "slot" && gesture?.kind === "slot") {
    const second = gesture.second;
    const length = second ? dist(gesture.first, second) : dist(gesture.first, at);
    const width = second ? slotWidth(gesture.first, second, at) : 0;
    return {
      kind: "slot",
      fields: [
        { id: "length", label: "Length", unit: "mm", value: length },
        { id: "width", label: "Width", unit: "mm", value: width },
      ],
    };
  }
  if (tool === "offset" && gesture?.kind === "offset") {
    return { kind: "offset", fields: [{ id: "distance", label: "Distance", unit: "mm", value: gesture.distance }] };
  }
  if (tool === "fillet" && gesture?.kind === "filletReady") {
    return { kind: "fillet", fields: [{ id: "radius", label: "Radius", unit: "mm", value: gesture.radius }] };
  }
  return null;
}

/** A typed size, before Enter. The rubber band follows `typed`. */
export function drawPreview(state: DrawState, values: readonly number[], at: Pt | null): { state: DrawState; typed: Pt | null } {
  const gesture = state.gesture;
  if (!gesture || !at) return { state, typed: null };
  if (gesture.kind === "circle") {
    const diameter = Math.abs(values[0] ?? 0);
    const typed = pointAt(gesture.centre, at, diameter / 2);
    return { state: { ...state, hud: [diameter] }, typed };
  }
  if (gesture.kind === "arcTan") {
    const live = tangentArc(gesture.from, gesture.dir, at);
    const baseline = state.hud ?? [live?.radius ?? 0, live ? (live.sweep * 180) / Math.PI : 90];
    const which = changedField(baseline, values);
    const radius = Math.abs(which === 0 ? (values[0] ?? 0) : (values[0] ?? baseline[0] ?? 0));
    const sweepDeg = which === 1 ? (values[1] ?? 0) : (values[1] ?? baseline[1] ?? (live ? (live.sweep * 180) / Math.PI : 90));
    const built = tangentArcBySweep(gesture.from, gesture.dir, radius, (sweepDeg * Math.PI) / 180);
    return { state: { ...state, hud: [values[0] ?? 0, values[1] ?? 0] }, typed: built ? arcPoint(built, 1) : null };
  }
  if (gesture.kind === "arc3" && gesture.b) {
    const live = arcFrom3(gesture.a, at, gesture.b);
    const baseline = state.hud ?? [live?.radius ?? 0, live ? (live.sweep * 180) / Math.PI : 0];
    const which = changedField(baseline, values);
    const side = which === 1 ? Math.sign(values[1] ?? 0) || sideOf(gesture.a, gesture.b, at) : sideOf(gesture.a, gesture.b, at);
    const radius = Math.abs(which === 1 ? radiusFromSweep(gesture.a, gesture.b, values[1] ?? 0) : (values[0] ?? baseline[0] ?? 0));
    const sweep = which === 1 ? ((values[1] ?? 0) * Math.PI) / 180 : sweepNear(gesture.a, gesture.b, radius, side, at);
    const built = arcFromChord(gesture.a, gesture.b, radius, sweep);
    return { state: { ...state, hud: [values[0] ?? 0, values[1] ?? 0] }, typed: built ? arcPoint(built, 0.5) : null };
  }
  if (gesture.kind === "polygon") {
    const live = polygonSize(gesture.centre, at, state.sides);
    const baseline = state.hud ?? [live.corners, live.flats, state.sides];
    const which = changedField(baseline, values);
    const sides = clampSides(values[2] ?? state.sides);
    const dir = unit(sub(at, gesture.centre)) ?? ([1, 0] as Pt);
    // Across flats wins when that field moved. Otherwise the across-corners number is the size,
    // so changing only the side count does not collapse a circle whose pointer is still on the centre.
    const radius = which === 1 ? radiusFromFlats(values[1] ?? 0, sides) : Math.abs(values[0] ?? live.corners) / 2;
    const typed = add(gesture.centre, scale(dir, radius));
    return { state: { ...state, sides, hud: [values[0] ?? 0, values[1] ?? 0, values[2] ?? sides] }, typed };
  }
  if (gesture.kind === "slot") {
    const second = gesture.second ?? at;
    const liveLength = dist(gesture.first, second);
    const liveWidth = gesture.second ? slotWidth(gesture.first, gesture.second, at) : 0;
    const baseline = state.hud ?? [liveLength, liveWidth];
    const which = changedField(baseline, values);
    const length = Math.abs(which === 0 ? (values[0] ?? liveLength) : (values[0] ?? liveLength));
    const width = Math.abs(which === 1 ? (values[1] ?? liveWidth) : (values[1] ?? liveWidth));
    const dir = unit(sub(gesture.second ?? at, gesture.first)) ?? ([1, 0] as Pt);
    const placed = add(gesture.first, scale(dir, length));
    const normal = leftNormal(dir);
    const typed = add(mid(gesture.first, placed), scale(normal, width / 2));
    const next: DrawGesture = { kind: "slot", first: gesture.first, second: placed };
    return { state: { ...state, gesture: next, hud: [values[0] ?? 0, values[1] ?? 0] }, typed };
  }
  if (gesture.kind === "offset") {
    return { state: { ...state, gesture: { ...gesture, distance: values[0] ?? 0 }, hud: [values[0] ?? 0] }, typed: null };
  }
  if (gesture.kind === "filletReady") {
    return { state: { ...state, gesture: { ...gesture, radius: Math.abs(values[0] ?? 0) }, hud: [values[0] ?? 0] }, typed: null };
  }
  return { state: { ...state, hud: [...values] }, typed: null };
}

/** Enter on the heads-up sizes, or on a tool that has no sizes. */
export function drawCommit(sketch: SketchData, state: DrawState, tool: DrawTool, values: readonly number[], at: Pt | null, hit: DrawPointer["hit"], ref: number | null, refs: RefGeom, selection: DrawSelection): DrawResult {
  const preview = drawPreview(state, values, at);
  const armed = preview.state;
  if (tool === "circle" && armed.gesture?.kind === "circle") return commitCircle(sketch, armed, Math.abs(values[0] ?? 0) / 2, selection);
  if (tool === "arc" && (armed.gesture?.kind === "arc3" || armed.gesture?.kind === "arcTan")) return commitArc(sketch, armed, preview.typed, selection);
  if (tool === "polygon" && armed.gesture?.kind === "polygon" && preview.typed) return commitPolygon(sketch, armed, preview.typed, selection);
  if (tool === "slot" && armed.gesture?.kind === "slot" && armed.gesture.second) return commitSlot(sketch, armed, armed.gesture.second, Math.abs(values[1] ?? 0), selection);
  if (tool === "offset" && armed.gesture?.kind === "offset") return commitOffset(sketch, armed, values[0] ?? 0, selection);
  if (tool === "fillet" && armed.gesture?.kind === "filletReady") return commitFillet(sketch, armed, Math.abs(values[0] ?? 0), selection);
  if (tool === "spline") return endSpline(sketch, state, selection);
  if (tool === "trim" && hit.entity != null) return applyTrim(sketch, state, hit.entity, at ?? hitPoint(sketch, hit) ?? [0, 0], selection);
  if (tool === "use") return applyUse(sketch, state, refs, ref, selection);
  if (tool === "construction") return applyConstruction(sketch, state, constructionIds(sketch, hit, selection), selection);
  return { sketch, state: armed, selection, committed: false };
}

export function drawPointer(sketch: SketchData, state: DrawState, tool: DrawTool, ev: DrawPointer, refs: RefGeom): DrawResult {
  let next = ev.phase === "down" ? { ...state, note: null } : state;
  if (ev.phase === "move") next = { ...next, hud: null };
  if (tool === "offset") return offsetPointer(sketch, next, ev);
  if (tool === "fillet") return filletPointer(sketch, next, ev);
  if (ev.phase !== "up") return { sketch, state: next, selection: ev.selection, committed: false };
  if (tool === "circle") return circlePointer(sketch, next, ev);
  if (tool === "arc") return arcPointer(sketch, next, ev);
  if (tool === "polygon") return polygonPointer(sketch, next, ev);
  if (tool === "slot") return slotPointer(sketch, next, ev);
  if (tool === "spline") return splinePointer(sketch, next, ev);
  if (tool === "trim") {
    if (ev.hit.entity == null) return note(sketch, next, ev.selection, "Click a line, arc, circle, or spline to trim.");
    return applyTrim(sketch, next, ev.hit.entity, ev.raw, ev.selection);
  }
  if (tool === "construction") return applyConstruction(sketch, next, constructionIds(sketch, ev.hit, { entities: [], points: [] }), ev.selection);
  if (tool === "use") return applyUse(sketch, next, refs, ev.ref, ev.selection);
  return { sketch, state: next, selection: ev.selection, committed: false };
}

export function drawRubber(sketch: SketchData, state: DrawState, tool: DrawTool, at: Pt | null): Pt[] | null {
  const gesture = state.gesture;
  if (!at || !gesture) return null;
  if (gesture.kind === "circle") return circleSamples(gesture.centre, Math.max(dist(gesture.centre, at), 0));
  if (gesture.kind === "arc3" && !gesture.b) return [gesture.a, at];
  if (gesture.kind === "arc3" && gesture.b) {
    const arc = arcFrom3(gesture.a, at, gesture.b);
    return arc ? arcSamples(arc) : [gesture.a, gesture.b];
  }
  if (gesture.kind === "arcTan") {
    const arc = tangentArc(gesture.from, gesture.dir, at);
    return arc ? arcSamples(arc) : [gesture.from, at];
  }
  if (gesture.kind === "polygon") {
    const corners = regularPolygon(gesture.centre, at, state.sides);
    return corners.length ? [...corners, corners[0]!] : null;
  }
  if (gesture.kind === "slot" && !gesture.second) return [gesture.first, at];
  if (gesture.kind === "slot" && gesture.second) return slotSamples(gesture.first, gesture.second, slotWidth(gesture.first, gesture.second, at));
  if (gesture.kind === "spline") {
    const points = gesture.points.map((id) => sketchPoint(sketch, id)?.at).filter((point): point is Pt => !!point);
    if (!points.length) return null;
    const controls = [...points, at];
    return controls.length >= 2 ? sampleSpline(controls, false) : controls;
  }
  if (gesture.kind === "offset" && Math.abs(gesture.distance) > 1e-6) return offsetSamples(sketch, gesture.ids, gesture.distance * gesture.sense);
  if (gesture.kind === "filletReady" && gesture.radius > 1e-6) return filletSamples(sketch, gesture.lines[0], gesture.lines[1], gesture.radius);
  if (tool === "trim" || tool === "construction" || tool === "use") return null;
  return null;
}

/** Corners of a regular polygon. The first is `corner`, and the rest run counter-clockwise. */
export function regularPolygon(centre: Pt, corner: Pt, sides: number): Pt[] {
  const count = clampSides(sides);
  const radius = dist(centre, corner);
  if (!(radius > 1e-6)) return [];
  const a0 = Math.atan2(corner[1] - centre[1], corner[0] - centre[0]);
  const out: Pt[] = [];
  for (let i = 0; i < count; i += 1) {
    const angle = a0 + (i * 2 * Math.PI) / count;
    out.push([centre[0] + radius * Math.cos(angle), centre[1] + radius * Math.sin(angle)]);
  }
  return out;
}

/** The arc that leaves `from` along `dir`, of `radius`, sweeping `sweep` radians (positive is counter-clockwise). */
export function tangentArcBySweep(from: Pt, dir: Pt, radius: number, sweep: number): ArcGeom | null {
  const direction = unit(dir);
  if (!direction || !(radius > 1e-6) || Math.abs(sweep) < 1e-6 || Math.abs(sweep) > Math.PI * 2 - 1e-4) return null;
  const left = leftNormal(direction);
  const centre = add(from, scale(left, sweep > 0 ? radius : -radius));
  const a0 = Math.atan2(from[1] - centre[1], from[0] - centre[0]);
  return { centre, radius, a0, sweep };
}

/**
 * The arc from `a` to `b` of `radius` and signed `sweep` radians.
 * A minor counter-clockwise arc keeps its centre on the left of the chord.
 */
export function arcFromChord(a: Pt, b: Pt, radius: number, sweep: number): ArcGeom | null {
  if (!(radius > 1e-6) || Math.abs(sweep) < 1e-4 || Math.abs(sweep) > Math.PI * 2 - 1e-4) return null;
  const chord = dist(a, b);
  if (!(chord > 1e-6) || radius < chord / 2 - 1e-4) return null;
  const dir = unit(sub(b, a));
  if (!dir) return null;
  const left = leftNormal(dir);
  const h = Math.sqrt(Math.max(0, radius * radius - (chord / 2) * (chord / 2)));
  const minor = Math.abs(sweep) <= Math.PI + 1e-6;
  const ccw = sweep > 0;
  const side = ccw ? (minor ? 1 : -1) : minor ? -1 : 1;
  const centre = add(mid(a, b), scale(left, side * h));
  const a0 = Math.atan2(a[1] - centre[1], a[0] - centre[0]);
  const built = { centre, radius, a0, sweep };
  if (dist(arcPoint(built, 1), b) > Math.max(1e-3, radius * 1e-3)) return null;
  return built;
}

/** Full width of the stadium through `at`, around the centre line `c1`–`c2`. */
export function slotWidth(c1: Pt, c2: Pt, at: Pt): number {
  const hit = projectToLine(c1, c2, at);
  if (!hit) return 0;
  return hit.distance * 2;
}

/** Reference segment under `at`. An outline wins a tie, so the face boundary is one pick. */
export function hitReference(refs: RefGeom, at: Pt, tolMm: number): number | null {
  const tol = Math.max(tolMm, 1e-6);
  let best = tol;
  let index: number | null = null;
  let outline = false;
  refs.segments.forEach((segment, i) => {
    const gap = segmentGap(segment.a, segment.b, at);
    const isOutline = segment.source === "outline";
    const closer = gap < best - 1e-9 || (Math.abs(gap - best) <= 1e-9 && isOutline && !outline);
    if (gap <= tol && closer) {
      best = gap;
      index = i;
      outline = isOutline;
    }
  });
  return index;
}

export function toggleConstruction(sketch: SketchData, ids: readonly number[]): SketchData {
  const set = new Set(ids);
  if (set.size === 0) return sketch;
  return {
    ...sketch,
    entities: sketch.entities.map((entity) => {
      if (!set.has(entity.id)) return entity;
      if (entity.construction) {
        const { construction: _drop, ...rest } = entity;
        return rest as SketchEntity;
      }
      return { ...entity, construction: true as const };
    }),
  };
}

function circlePointer(sketch: SketchData, state: DrawState, ev: DrawPointer): DrawResult {
  const gesture = state.gesture;
  if (gesture?.kind !== "circle") return { sketch, state: { ...state, gesture: { kind: "circle", centre: ev.at }, hud: null }, selection: ev.selection, committed: false };
  return commitCircle(sketch, state, dist(gesture.centre, ev.at), ev.selection);
}

function commitCircle(sketch: SketchData, state: DrawState, radius: number, selection: DrawSelection): DrawResult {
  const gesture = state.gesture;
  if (gesture?.kind !== "circle") return { sketch, state, selection, committed: false };
  if (!(radius > 1e-6)) return note(sketch, state, selection, "A circle needs a diameter above 0.");
  const centre = ensurePoint(sketch, gesture.centre);
  const added = addCircle(centre.sketch, centre.id, radius);
  return { sketch: added.sketch, state: { ...state, gesture: null, note: null, hud: null }, selection, committed: true };
}

function arcPointer(sketch: SketchData, state: DrawState, ev: DrawPointer): DrawResult {
  const gesture = state.gesture;
  if (!gesture || (gesture.kind !== "arc3" && gesture.kind !== "arcTan")) {
    if (ev.shift || state.tangentArm) {
      const end = lastLineEnd(sketch);
      if (!end) return note(sketch, { ...state, tangentArm: false }, ev.selection, "Draw a line first. A tangent arc starts at its end.");
      const arc = tangentArc(end.from, end.dir, ev.at);
      if (!arc) return note(sketch, { ...state, tangentArm: false }, ev.selection, "An arc's three points are in a straight line. Move the end off the tangent.");
      return placeArc(sketch, { ...state, tangentArm: false }, arcPoint(arc, 0), arcPoint(arc, 1), arcPoint(arc, 0.5), ev.selection);
    }
    return { sketch, state: { ...state, gesture: { kind: "arc3", a: ev.at }, hud: null }, selection: ev.selection, committed: false };
  }
  if (gesture.kind === "arcTan") {
    const arc = tangentArc(gesture.from, gesture.dir, ev.at);
    if (!arc) return note(sketch, state, ev.selection, "An arc's three points are in a straight line. Move the end off the tangent.");
    return placeArc(sketch, state, arcPoint(arc, 0), arcPoint(arc, 1), arcPoint(arc, 0.5), ev.selection);
  }
  if (!gesture.b) {
    if (dist(gesture.a, ev.at) <= 1e-4) return { sketch, state, selection: ev.selection, committed: false };
    return { sketch, state: { ...state, gesture: { kind: "arc3", a: gesture.a, b: ev.at }, hud: null }, selection: ev.selection, committed: false };
  }
  return commitArc(sketch, state, ev.at, ev.selection);
}

function commitArc(sketch: SketchData, state: DrawState, through: Pt | null, selection: DrawSelection): DrawResult {
  const gesture = state.gesture;
  if (!through) return note(sketch, state, selection, "An arc needs a radius above 0.");
  if (gesture?.kind === "arcTan") {
    const arc = tangentArc(gesture.from, gesture.dir, through);
    if (!arc) return note(sketch, state, selection, "An arc's three points are in a straight line. Move the end off the tangent.");
    return placeArc(sketch, state, arcPoint(arc, 0), arcPoint(arc, 1), arcPoint(arc, 0.5), selection);
  }
  if (gesture?.kind === "arc3" && gesture.b) {
    const arc = arcFrom3(gesture.a, through, gesture.b);
    if (!arc) return note(sketch, state, selection, "An arc's three points are in a straight line. Move the middle point off that line.");
    return placeArc(sketch, state, gesture.a, gesture.b, arcPoint(arc, 0.5), selection);
  }
  return { sketch, state, selection, committed: false };
}

function placeArc(sketch: SketchData, state: DrawState, a: Pt, b: Pt, through: Pt, selection: DrawSelection): DrawResult {
  const first = ensurePoint(sketch, a);
  const second = ensurePoint(first.sketch, b);
  const added = addArc(second.sketch, first.id, second.id, through);
  return { sketch: added.sketch, state: { ...state, gesture: null, note: null, tangentArm: false, hud: null }, selection, committed: true };
}

function polygonPointer(sketch: SketchData, state: DrawState, ev: DrawPointer): DrawResult {
  const gesture = state.gesture;
  if (gesture?.kind !== "polygon") return { sketch, state: { ...state, gesture: { kind: "polygon", centre: ev.at }, hud: null }, selection: ev.selection, committed: false };
  return commitPolygon(sketch, state, ev.at, ev.selection);
}

function commitPolygon(sketch: SketchData, state: DrawState, corner: Pt, selection: DrawSelection): DrawResult {
  const gesture = state.gesture;
  if (gesture?.kind !== "polygon") return { sketch, state, selection, committed: false };
  const corners = regularPolygon(gesture.centre, corner, state.sides);
  if (corners.length < 3) return note(sketch, state, selection, "A polygon needs a size above 0 and at least 3 sides.");
  return { sketch: placeLoop(sketch, corners), state: { ...state, gesture: null, note: null, hud: null }, selection, committed: true };
}

function slotPointer(sketch: SketchData, state: DrawState, ev: DrawPointer): DrawResult {
  const gesture = state.gesture;
  if (gesture?.kind !== "slot") return { sketch, state: { ...state, gesture: { kind: "slot", first: ev.at }, hud: null }, selection: ev.selection, committed: false };
  if (!gesture.second) {
    if (dist(gesture.first, ev.at) <= 1e-4) return { sketch, state, selection: ev.selection, committed: false };
    return { sketch, state: { ...state, gesture: { kind: "slot", first: gesture.first, second: ev.at }, hud: null }, selection: ev.selection, committed: false };
  }
  return commitSlot(sketch, state, gesture.second, slotWidth(gesture.first, gesture.second, ev.at), ev.selection);
}

function commitSlot(sketch: SketchData, state: DrawState, second: Pt, width: number, selection: DrawSelection): DrawResult {
  const gesture = state.gesture;
  if (gesture?.kind !== "slot") return { sketch, state, selection, committed: false };
  const shape = slotCorners(gesture.first, second, width);
  if (!shape) return note(sketch, state, selection, "A slot needs a length and a width above 0.");
  let next = sketch;
  const ids: number[] = [];
  for (const corner of shape.corners) {
    const point = ensurePoint(next, corner);
    next = point.sketch;
    ids.push(point.id);
  }
  const [p0, p1, p2, p3] = ids as [number, number, number, number];
  next = addLine(next, p0, p1).sketch;
  next = addArc(next, p1, p2, shape.through[0]).sketch;
  next = addLine(next, p2, p3).sketch;
  next = addArc(next, p3, p0, shape.through[1]).sketch;
  return { sketch: next, state: { ...state, gesture: null, note: null, hud: null }, selection, committed: true };
}

function splinePointer(sketch: SketchData, state: DrawState, ev: DrawPointer): DrawResult {
  const gesture = state.gesture?.kind === "spline" ? state.gesture : { kind: "spline" as const, points: [], entity: null };
  if (ev.double) return endSpline(sketch, { ...state, gesture }, ev.selection);
  const points = gesture.points.map((id) => sketchPoint(sketch, id)?.at);
  const last = points[points.length - 1];
  if (last && dist(last, ev.at) <= Math.max(1e-4, ev.tolMm) && gesture.points.length >= 2 && ev.hit.point === gesture.points[gesture.points.length - 1]) {
    return endSpline(sketch, { ...state, gesture }, ev.selection);
  }
  const first = points[0];
  const closing = gesture.points.length >= 3 && ((first && dist(first, ev.at) <= Math.max(1e-4, ev.tolMm)) || ev.hit.point === gesture.points[0]);
  if (closing && gesture.entity != null) {
    const through = [...gesture.points, gesture.points[0]!];
    const closed = retargetSpline(sketch, gesture.entity, through);
    return { sketch: closed, state: { ...state, gesture: null, note: null, hud: null }, selection: ev.selection, committed: true };
  }
  const added = ensurePoint(sketch, ev.at);
  const ids = [...gesture.points, added.id];
  if (ids.length < 2) {
    return { sketch: added.sketch, state: { ...state, gesture: { kind: "spline", points: ids, entity: null }, hud: null }, selection: ev.selection, committed: false };
  }
  if (gesture.entity == null) {
    const spline = addSpline(added.sketch, ids);
    return { sketch: spline.sketch, state: { ...state, gesture: { kind: "spline", points: ids, entity: spline.id }, hud: null }, selection: ev.selection, committed: true };
  }
  return { sketch: retargetSpline(added.sketch, gesture.entity, ids), state: { ...state, gesture: { kind: "spline", points: ids, entity: gesture.entity }, hud: null }, selection: ev.selection, committed: true };
}

function endSpline(sketch: SketchData, state: DrawState, selection: DrawSelection): DrawResult {
  const gesture = state.gesture;
  if (gesture?.kind !== "spline") return { sketch, state, selection, committed: false };
  const pruned = gesture.entity == null ? prunePoints(sketch) : sketch;
  return { sketch: pruned, state: { ...state, gesture: null, note: null, hud: null }, selection, committed: false };
}

function offsetPointer(sketch: SketchData, state: DrawState, ev: DrawPointer): DrawResult {
  const gesture = state.gesture;
  if (ev.phase === "down") {
    const begun = beginOffset(sketch, ev);
    if ("error" in begun) return note(sketch, state, ev.selection, begun.error);
    return { sketch, state: { ...state, gesture: begun.gesture, note: null, hud: null }, selection: { entities: begun.gesture.ids, points: [] }, committed: false };
  }
  if (gesture?.kind !== "offset") return { sketch, state, selection: ev.selection, committed: false };
  const distance = dragDistance(gesture.origin, gesture.normal, ev.at);
  const moved = (ev.sx - gesture.sx) ** 2 + (ev.sy - gesture.sy) ** 2 > 16;
  const armed = gesture.armed || (ev.phase === "move" && moved);
  const updated: DrawGesture = { ...gesture, distance, armed };
  if (ev.phase === "up" && armed && Math.abs(distance) > 1e-6) return commitOffset(sketch, { ...state, gesture: updated }, distance, ev.selection);
  return { sketch, state: { ...state, gesture: updated }, selection: { entities: gesture.ids, points: [] }, committed: false };
}

function commitOffset(sketch: SketchData, state: DrawState, distance: number, selection: DrawSelection): DrawResult {
  const gesture = state.gesture;
  if (gesture?.kind !== "offset") return { sketch, state, selection, committed: false };
  const applied = offset(sketch, gesture.ids, distance * gesture.sense);
  if (applied.error) return note(sketch, state, selection, applied.error);
  return { sketch: applied.sketch, state: { ...state, gesture: null, note: null, hud: null }, selection: { entities: [], points: [] }, committed: true };
}

function filletPointer(sketch: SketchData, state: DrawState, ev: DrawPointer): DrawResult {
  const gesture = state.gesture;
  if (gesture?.kind === "filletReady" && ev.phase === "move") {
    const radius = filletRadius(sketch, gesture.lines[0], gesture.lines[1], ev.at) ?? gesture.radius;
    const moved = (ev.sx - gesture.sx) ** 2 + (ev.sy - gesture.sy) ** 2 > 16;
    return { sketch, state: { ...state, gesture: { ...gesture, radius, armed: gesture.armed || moved } }, selection: ev.selection, committed: false };
  }
  if (gesture?.kind === "filletReady" && ev.phase === "up") {
    if (gesture.armed && gesture.radius > 1e-6) return commitFillet(sketch, state, gesture.radius, ev.selection);
    if (!gesture.armed && ev.hit.entity != null && ev.hit.entity !== gesture.lines[0] && ev.hit.entity !== gesture.lines[1]) {
      return armFillet(sketch, state, gesture.lines[0], ev, ev.selection);
    }
    return { sketch, state, selection: ev.selection, committed: false };
  }
  if (ev.phase !== "up") {
    if (gesture?.kind === "fillet") return { sketch, state, selection: ev.selection, committed: false };
    return { sketch, state, selection: ev.selection, committed: false };
  }
  const line = closestLine(sketch, ev.raw, ev.tolMm);
  if (line == null) return note(sketch, state, ev.selection, "Click two lines to round their corner.");
  if (gesture?.kind !== "fillet") {
    return { sketch, state: { ...state, gesture: { kind: "fillet", line, sx: ev.sx, sy: ev.sy }, note: null, hud: null }, selection: { entities: [line], points: [] }, committed: false };
  }
  if (line === gesture.line) return { sketch, state, selection: ev.selection, committed: false };
  return armFillet(sketch, state, gesture.line, ev, ev.selection);
}

function armFillet(sketch: SketchData, state: DrawState, first: number, ev: DrawPointer, selection: DrawSelection): DrawResult {
  const line = closestLine(sketch, ev.raw, ev.tolMm);
  if (line == null || line === first) return note(sketch, state, selection, "Click two lines to round their corner.");
  const fit = filletCorner(sketch, first, line, 0.1);
  if (fit.error && !fit.error.startsWith("That radius")) return note(sketch, { ...state, gesture: null }, selection, fit.error);
  return {
    sketch,
    state: { ...state, gesture: { kind: "filletReady", lines: [first, line], radius: 0, sx: ev.sx, sy: ev.sy, armed: false }, note: null, hud: null },
    selection: { entities: [first, line], points: [] },
    committed: false,
  };
}

function commitFillet(sketch: SketchData, state: DrawState, radius: number, selection: DrawSelection): DrawResult {
  const gesture = state.gesture;
  if (gesture?.kind !== "filletReady") return { sketch, state, selection, committed: false };
  if (!(radius > 1e-6)) return note(sketch, state, selection, "A corner round needs a radius above 0.");
  const applied = filletCorner(sketch, gesture.lines[0], gesture.lines[1], radius);
  if (applied.error) return note(sketch, state, selection, applied.error);
  return { sketch: applied.sketch, state: { ...state, gesture: null, note: null, hud: null }, selection: { entities: [], points: [] }, committed: true };
}

function applyTrim(sketch: SketchData, state: DrawState, entityId: number, at: Pt, selection: DrawSelection): DrawResult {
  const applied = trim(sketch, entityId, at);
  if (applied.error) return note(sketch, state, selection, applied.error);
  return { sketch: applied.sketch, state: { ...state, gesture: null, note: null, hud: null }, selection: { entities: [], points: [] }, committed: true };
}

function applyConstruction(sketch: SketchData, state: DrawState, ids: number[], selection: DrawSelection): DrawResult {
  if (ids.length === 0) return note(sketch, state, selection, "Click a line to make it construction, or select one first.");
  const next = toggleConstruction(sketch, ids);
  return { sketch: next, state: { ...state, note: null, hud: null }, selection: { entities: ids, points: [] }, committed: true };
}

function applyUse(sketch: SketchData, state: DrawState, refs: RefGeom, index: number | null, selection: DrawSelection): DrawResult {
  if (index == null) return note(sketch, state, selection, "Click a faint edge or the face outline.");
  const chain = refChain(refs, index);
  if (!chain) return note(sketch, state, selection, "Click a faint edge or the face outline.");
  // The view's edges are tessellated. Runs that lie on one line or one circle are copied as that line, arc or circle.
  let next = sketch;
  let added = 0;
  for (const piece of fitPieces(chain.points, chain.closed)) {
    if (piece.kind === "circle") {
      if (hasCircle(next, piece.centre, piece.radius)) continue;
      next = addCircle(next, piece.centre, piece.radius).sketch;
    } else if (piece.kind === "arc") {
      if (hasArc(next, piece.a, piece.b, piece.through)) continue;
      const first = ensurePoint(next, piece.a);
      const second = ensurePoint(first.sketch, piece.b);
      next = addArc(second.sketch, first.id, second.id, piece.through).sketch;
    } else {
      if (hasLine(next, piece.a, piece.b)) continue;
      const first = ensurePoint(next, piece.a);
      const second = ensurePoint(first.sketch, piece.b);
      next = addLine(second.sketch, first.id, second.id).sketch;
    }
    added += 1;
  }
  if (added === 0) return note(sketch, state, selection, "That edge is already in the sketch.");
  return { sketch: next, state: { ...state, note: null, hud: null }, selection, committed: true };
}

function beginOffset(sketch: SketchData, ev: DrawPointer): { gesture: Extract<DrawGesture, { kind: "offset" }> } | { error: string } {
  let primary = ev.hit.entity;
  let ids: number[] = [];
  if (primary != null) ids = connectedIds(sketch, primary);
  else if (ev.selection.entities.length) {
    ids = [...ev.selection.entities];
    primary = ids[0] ?? null;
  } else if (ev.hit.point != null) {
    const users = entitiesAt(sketch, ev.hit.point);
    primary = users[0] ?? null;
    if (primary != null) ids = connectedIds(sketch, primary);
  }
  if (primary == null || ids.length === 0) return { error: "Select a line, arc, circle, or spline to offset." };
  const entity = sketchEntity(sketch, primary);
  const curve = entity && curveOf(sketch, entity);
  const frame = curve && leftOf(curve, ev.raw);
  if (!frame) return { error: "Select a line, arc, circle, or spline to offset." };
  return { gesture: { kind: "offset", ids, origin: frame.origin, normal: frame.normal, sense: offsetSense(sketch, ids, frame.origin, frame.normal), distance: 0, sx: ev.sx, sy: ev.sy, armed: false } };
}

function offsetSense(sketch: SketchData, ids: number[], origin: Pt, normal: Pt): 1 | -1 {
  const probe = 0.05;
  const trial = offset(sketch, ids, probe);
  if (trial.error) return 1;
  const want = add(origin, scale(normal, probe));
  let best = Infinity;
  for (const entity of trial.sketch.entities) {
    if (sketch.entities.some((old) => old.id === entity.id)) continue;
    const curve = curveOf(trial.sketch, entity);
    const hit = curve && curveProject(curve, want);
    if (hit && hit.distance < best) best = hit.distance;
  }
  return best < probe ? 1 : -1;
}

function leftOf(curve: Curve, at: Pt): { origin: Pt; normal: Pt } | null {
  if (curve.kind === "line") {
    const dir = unit(sub(curve.b, curve.a));
    if (!dir) return null;
    return { origin: projectToLine(curve.a, curve.b, at)?.pt ?? curve.a, normal: leftNormal(dir) };
  }
  if (curve.kind === "circle") {
    const dir = unit(sub(at, curve.centre)) ?? ([1, 0] as Pt);
    return { origin: add(curve.centre, scale(dir, curve.radius)), normal: dir };
  }
  if (curve.kind === "arc") {
    const hit = curveProject(curve, at);
    if (!hit) return null;
    return { origin: hit.pt, normal: leftNormal(arcTangent(curve.arc, hit.t)) };
  }
  let best = Infinity;
  let found: { origin: Pt; normal: Pt } | null = null;
  const count = curve.closed ? curve.samples.length - 1 : curve.samples.length - 1;
  for (let i = 0; i < count; i += 1) {
    const hit = projectToSegment(curve.samples[i]!, curve.samples[i + 1]!, at);
    const dir = unit(sub(curve.samples[i + 1]!, curve.samples[i]!));
    if (!hit || !dir || hit.distance >= best) continue;
    best = hit.distance;
    found = { origin: hit.pt, normal: leftNormal(dir) };
  }
  if (found) return found;
  const projected = projectToSpline(curve.samples, at, curve.closed);
  return projected ? { origin: projected.pt, normal: [0, 1] } : null;
}

function connectedIds(sketch: SketchData, startId: number): number[] {
  const start = sketchEntity(sketch, startId);
  if (!start) return [];
  if (start.kind === "circle") return [startId];
  const users = new Map<number, number[]>();
  for (const entity of sketch.entities) {
    for (const id of pointIds(entity)) {
      const list = users.get(id) ?? [];
      list.push(entity.id);
      users.set(id, list);
    }
  }
  const out: number[] = [];
  const seen = new Set<number>();
  const walk = (id: number) => {
    if (seen.has(id)) return;
    const entity = sketchEntity(sketch, id);
    if (!entity || entity.kind === "circle") return;
    seen.add(id);
    out.push(id);
    for (const point of pointIds(entity)) {
      const others = (users.get(point) ?? []).filter((other) => other !== id);
      if (others.length === 1) walk(others[0]!);
    }
  };
  walk(startId);
  return out;
}

function filletRadius(sketch: SketchData, lineA: number, lineB: number, at: Pt): number | null {
  const ends = lineEnds(sketch, lineA, lineB);
  if (!ends) return null;
  const corner = sharedCorner(ends.a0, ends.a1, ends.b0, ends.b1);
  if (!corner) return null;
  const dirA = unit(sub(corner.otherA, corner.at));
  const dirB = unit(sub(corner.otherB, corner.at));
  if (!dirA || !dirB) return null;
  const alpha = Math.atan2(Math.abs(cross(dirA, dirB)), dot(dirA, dirB));
  if (alpha < 1e-4 || Math.PI - alpha < 1e-4) return null;
  const bisector = unit(add(dirA, dirB));
  if (!bisector) return null;
  const along = dot(sub(at, corner.at), bisector);
  if (along <= 0) return 0;
  return along * Math.sin(alpha / 2);
}

function filletSamples(sketch: SketchData, lineA: number, lineB: number, radius: number): Pt[] | null {
  const ends = lineEnds(sketch, lineA, lineB);
  if (!ends) return null;
  const fillet = cornerFillet(ends.a0, ends.a1, ends.b0, ends.b1, radius);
  if ("error" in fillet) return null;
  const arc = arcFrom3(fillet.tangentA, fillet.through, fillet.tangentB);
  return arc ? arcSamples(arc) : null;
}

function offsetSamples(sketch: SketchData, ids: number[], distance: number): Pt[] | null {
  const applied = offset(sketch, ids, distance);
  if (applied.error) return null;
  const points: Pt[] = [];
  for (const entity of applied.sketch.entities) {
    if (sketch.entities.some((old) => old.id === entity.id)) continue;
    const curve = curveOf(applied.sketch, entity);
    if (!curve) continue;
    const samples = curve.kind === "line" ? [curve.a, curve.b] : curve.kind === "circle" ? circleSamples(curve.centre, curve.radius) : curve.kind === "arc" ? arcSamples(curve.arc) : curve.samples;
    if (points.length && samples.length && dist(points[points.length - 1]!, samples[0]!) < 1e-4) samples.shift();
    points.push(...samples);
  }
  return points.length >= 2 ? points : null;
}

function slotSamples(c1: Pt, c2: Pt, width: number): Pt[] | null {
  const shape = slotCorners(c1, c2, width);
  if (!shape) return null;
  const [p0, p1, p2, p3] = shape.corners;
  const cap2 = arcFrom3(p1, shape.through[0], p2);
  const cap1 = arcFrom3(p3, shape.through[1], p0);
  if (!cap2 || !cap1) return null;
  return [...arcSamples(cap1).slice(0, -1), p0, p1, ...arcSamples(cap2).slice(0, -1), p2, p3, p0];
}

function slotCorners(c1: Pt, c2: Pt, width: number): { corners: [Pt, Pt, Pt, Pt]; through: [Pt, Pt] } | null {
  if (!(width > 1e-6) || dist(c1, c2) <= 1e-6) return null;
  const dir = unit(sub(c2, c1));
  if (!dir) return null;
  const left = leftNormal(dir);
  const radius = width / 2;
  const p0 = add(c1, scale(left, radius));
  const p1 = add(c2, scale(left, radius));
  const p2 = add(c2, scale(left, -radius));
  const p3 = add(c1, scale(left, -radius));
  return { corners: [p0, p1, p2, p3], through: [add(c2, scale(dir, radius)), add(c1, scale(dir, -radius))] };
}

function polygonSize(centre: Pt, corner: Pt, sides: number): { corners: number; flats: number } {
  const radius = dist(centre, corner);
  const count = clampSides(sides);
  return { corners: radius * 2, flats: radius * 2 * Math.cos(Math.PI / count) };
}

function radiusFromFlats(flats: number, sides: number): number {
  const count = clampSides(sides);
  const cos = Math.cos(Math.PI / count);
  if (Math.abs(cos) < 1e-6) return 0;
  return Math.abs(flats) / 2 / cos;
}

function radiusFromSweep(a: Pt, b: Pt, sweepDeg: number): number {
  const chord = dist(a, b);
  const half = Math.abs(sweepDeg) * Math.PI / 360;
  const sin = Math.sin(half);
  if (Math.abs(sin) < 1e-6) return 0;
  return Math.abs(chord / (2 * sin));
}

function sweepFromRadius(a: Pt, b: Pt, radius: number, side: number, major = false): number {
  const chord = dist(a, b);
  if (!(radius > 0) || chord > radius * 2) return 0;
  const minor = 2 * Math.asin(Math.min(1, chord / (2 * radius)));
  const angle = major ? Math.PI * 2 - minor : minor;
  return (side >= 0 ? 1 : -1) * angle;
}

/** The sweep of `radius` whose midpoint sits nearer `at`, so a long arc stays long. */
function sweepNear(a: Pt, b: Pt, radius: number, side: number, at: Pt): number {
  const minor = sweepFromRadius(a, b, radius, side, false);
  const major = sweepFromRadius(a, b, radius, side, true);
  const minorArc = arcFromChord(a, b, radius, minor);
  const majorArc = arcFromChord(a, b, radius, major);
  if (!minorArc) return major;
  if (!majorArc) return minor;
  return dist(arcPoint(minorArc, 0.5), at) <= dist(arcPoint(majorArc, 0.5), at) ? minor : major;
}

/** +1 when `at` lies on the counter-clockwise side of the chord, which is the minor arc's bulge. */
function sideOf(a: Pt, b: Pt, at: Pt): number {
  const dir = sub(b, a);
  const turn = dir[0] * (at[1] - a[1]) - dir[1] * (at[0] - a[0]);
  return turn <= 0 ? 1 : -1;
}

function changedField(baseline: number[], values: readonly number[]): number {
  let index = 0;
  let best = 0;
  for (let i = 0; i < values.length; i += 1) {
    const gap = Math.abs((values[i] ?? 0) - (baseline[i] ?? 0));
    if (gap > best) {
      best = gap;
      index = i;
    }
  }
  return best > 1e-3 ? index : 0;
}

function circleSamples(centre: Pt, radius: number): Pt[] {
  if (!(radius > 0)) return [];
  const out: Pt[] = [];
  for (let i = 0; i <= 32; i += 1) {
    const angle = (i / 32) * Math.PI * 2;
    out.push([centre[0] + radius * Math.cos(angle), centre[1] + radius * Math.sin(angle)]);
  }
  return out;
}

function arcSamples(arc: ArcGeom): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i <= 16; i += 1) out.push(arcPoint(arc, i / 16));
  return out;
}

function placeLoop(sketch: SketchData, corners: readonly Pt[]): SketchData {
  let next = sketch;
  const ids: number[] = [];
  for (const corner of corners) {
    const point = ensurePoint(next, corner);
    next = point.sketch;
    ids.push(point.id);
  }
  for (let i = 0; i < ids.length; i += 1) next = addLine(next, ids[i]!, ids[(i + 1) % ids.length]!).sketch;
  return next;
}

function ensurePoint(sketch: SketchData, at: Pt): { sketch: SketchData; id: number } {
  const near = pointNear(sketch, at, 1e-4);
  if (near) return { sketch, id: near.id };
  return addPoint(sketch, at);
}

function retargetSpline(sketch: SketchData, id: number, through: number[]): SketchData {
  return { ...sketch, entities: sketch.entities.map((entity) => (entity.id === id && entity.kind === "spline" ? { ...entity, through: [...through] } : entity)) };
}

/** The tangent arc's start: the end of the last line, and that line's direction. */
export function tangentGesture(sketch: SketchData): Extract<DrawGesture, { kind: "arcTan" }> | null {
  const end = lastLineEnd(sketch);
  if (!end) return null;
  return { kind: "arcTan", from: end.from, dir: end.dir };
}

function lastLineEnd(sketch: SketchData): { from: Pt; dir: Pt } | null {
  for (let i = sketch.entities.length - 1; i >= 0; i -= 1) {
    const entity = sketch.entities[i]!;
    if (entity.kind !== "line") continue;
    const a = sketchPoint(sketch, entity.a);
    const b = sketchPoint(sketch, entity.b);
    if (!a || !b) continue;
    const dir = unit(sub(b.at, a.at));
    if (!dir) continue;
    return { from: b.at, dir };
  }
  return null;
}

function closestLine(sketch: SketchData, at: Pt, tol: number): number | null {
  let best = Math.max(tol, 1e-6);
  let found: number | null = null;
  for (const entity of sketch.entities) {
    if (entity.kind !== "line") continue;
    const a = sketchPoint(sketch, entity.a)?.at;
    const b = sketchPoint(sketch, entity.b)?.at;
    if (!a || !b) continue;
    const gap = segmentGap(a, b, at);
    if (gap < best) {
      best = gap;
      found = entity.id;
    }
  }
  return found;
}

function constructionIds(sketch: SketchData, hit: { point: number | null; entity: number | null }, selection: DrawSelection): number[] {
  if (selection.entities.length) return [...selection.entities];
  if (hit.entity != null) return [hit.entity];
  if (hit.point == null) return [];
  return entitiesAt(sketch, hit.point);
}

function entitiesAt(sketch: SketchData, point: number): number[] {
  return sketch.entities.filter((entity) => pointIds(entity).includes(point)).map((entity) => entity.id);
}

type UsePiece = { kind: "line"; a: Pt; b: Pt } | { kind: "arc"; a: Pt; b: Pt; through: Pt } | { kind: "circle"; centre: Pt; radius: number };

/** How far a copied run may stray from the solid's tessellated edge, in millimetres. */
const FIT_MM = 0.02;

/**
 * A polyline as lines, arcs and circles: a closed run on one circle is that circle; otherwise each longest run on one
 * line is a line, and each run of three or more pieces on one circle is an arc.
 */
export function fitPieces(points: readonly Pt[], closed: boolean): UsePiece[] {
  if (points.length < 2) return [];
  if (closed && points.length >= 6) {
    const round = circleThrough(points);
    if (round) return [{ kind: "circle", centre: round.centre, radius: round.radius }];
  }
  const run = closed ? [...points, points[0]!] : [...points];
  const out: UsePiece[] = [];
  let at = 0;
  while (at < run.length - 1) {
    let line = at + 1;
    while (line + 1 < run.length && onLine(run, at, line + 1)) line += 1;
    let arc = at;
    for (let end = at + 3; end < run.length; end += 1) {
      if (circleThrough(run.slice(at, end + 1))) arc = end;
      else break;
    }
    if (arc > line) {
      const middle = run[Math.floor((at + arc) / 2)]!;
      out.push({ kind: "arc", a: run[at]!, b: run[arc]!, through: middle });
      at = arc;
    } else {
      out.push({ kind: "line", a: run[at]!, b: run[line]! });
      at = line;
    }
  }
  return out;
}

function onLine(run: readonly Pt[], from: number, to: number): boolean {
  const a = run[from]!;
  const b = run[to]!;
  for (let i = from + 1; i < to; i += 1) {
    const hit = projectToSegment(a, b, run[i]!);
    if (!hit || hit.distance > FIT_MM) return false;
  }
  return true;
}

/**
 * The circle through every point within `FIT_MM`, from the first, a middle and a late point; null when there is none.
 * Each piece turns at most 20° about the centre and the pieces are near one length, as a tessellated curve's are, so
 * a square, or a decagon pocket on the face outline, stays straight sides.
 */
function circleThrough(points: readonly Pt[]): { centre: Pt; radius: number } | null {
  if (points.length < 4) return null;
  const arc = arcFrom3(points[0]!, points[Math.floor(points.length / 3)]!, points[Math.floor((2 * points.length) / 3)]!);
  if (!arc || !(arc.radius < 1e4)) return null;
  if (!points.every((point) => Math.abs(dist(point, arc.centre) - arc.radius) <= FIT_MM)) return null;
  const most = 2 * arc.radius * Math.sin((10 * Math.PI) / 180);
  const chords = points.slice(1).map((point, i) => dist(points[i]!, point));
  if (chords.some((chord) => chord > most)) return null;
  const longest = Math.max(...chords);
  if (chords.some((chord) => chord < longest * 0.85)) return null;
  return { centre: arc.centre, radius: arc.radius };
}

function hasCircle(sketch: SketchData, centre: Pt, radius: number): boolean {
  return sketch.entities.some((entity) => {
    if (entity.kind !== "circle") return false;
    const at = sketchPoint(sketch, entity.centre)?.at;
    return !!at && dist(at, centre) <= 1e-3 && Math.abs(entity.radius - radius) <= 1e-3;
  });
}

function hasArc(sketch: SketchData, a: Pt, b: Pt, through: Pt): boolean {
  return sketch.entities.some((entity) => {
    if (entity.kind !== "arc") return false;
    const start = sketchPoint(sketch, entity.a)?.at;
    const end = sketchPoint(sketch, entity.b)?.at;
    if (!start || !end) return false;
    const same = (dist(start, a) <= 1e-3 && dist(end, b) <= 1e-3) || (dist(start, b) <= 1e-3 && dist(end, a) <= 1e-3);
    return same && dist(entity.through, through) <= 0.05;
  });
}

function hasLine(sketch: SketchData, a: Pt, b: Pt): boolean {
  return sketch.entities.some((entity) => {
    if (entity.kind !== "line") return false;
    const start = sketchPoint(sketch, entity.a)?.at;
    const end = sketchPoint(sketch, entity.b)?.at;
    if (!start || !end) return false;
    return (dist(start, a) <= 1e-4 && dist(end, b) <= 1e-4) || (dist(start, b) <= 1e-4 && dist(end, a) <= 1e-4);
  });
}

function lineEnds(sketch: SketchData, lineA: number, lineB: number): { a0: Pt; a1: Pt; b0: Pt; b1: Pt } | null {
  const a = sketchEntity(sketch, lineA);
  const b = sketchEntity(sketch, lineB);
  if (!a || !b || a.kind !== "line" || b.kind !== "line") return null;
  const a0 = sketchPoint(sketch, a.a)?.at;
  const a1 = sketchPoint(sketch, a.b)?.at;
  const b0 = sketchPoint(sketch, b.a)?.at;
  const b1 = sketchPoint(sketch, b.b)?.at;
  if (!a0 || !a1 || !b0 || !b1) return null;
  return { a0, a1, b0, b1 };
}

function sharedCorner(a0: Pt, a1: Pt, b0: Pt, b1: Pt): { at: Pt; otherA: Pt; otherB: Pt } | null {
  const pairs: [Pt, Pt, Pt, Pt][] = [
    [a0, a1, b0, b1],
    [a0, a1, b1, b0],
    [a1, a0, b0, b1],
    [a1, a0, b1, b0],
  ];
  for (const [at, otherA, other, otherB] of pairs) {
    if (dist(at, other) <= 1e-4) return { at, otherA, otherB };
  }
  return null;
}

function pointIds(entity: SketchEntity): number[] {
  if (entity.kind === "line" || entity.kind === "arc") return [entity.a, entity.b];
  if (entity.kind === "circle") return [entity.centre];
  return [...entity.through];
}

function hitPoint(sketch: SketchData, hit: { point: number | null; entity: number | null }): Pt | null {
  if (hit.point == null) return null;
  return sketchPoint(sketch, hit.point)?.at ?? null;
}

function note(sketch: SketchData, state: DrawState, selection: DrawSelection, text: string): DrawResult {
  return { sketch, state: { ...state, note: text }, selection, committed: false };
}

function dragDistance(origin: Pt, normal: Pt, at: Pt): number {
  return (at[0] - origin[0]) * normal[0] + (at[1] - origin[1]) * normal[1];
}

function segmentGap(a: Pt, b: Pt, at: Pt): number {
  const hit = projectToSegment(a, b, at);
  return hit ? hit.distance : Math.min(dist(at, a), dist(at, b));
}

function pointAt(origin: Pt, toward: Pt, radius: number): Pt {
  const dir = unit(sub(toward, origin)) ?? ([1, 0] as Pt);
  return add(origin, scale(dir, radius));
}

function mid(a: Pt, b: Pt): Pt {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}

function sub(a: Pt, b: Pt): Pt {
  return [a[0] - b[0], a[1] - b[1]];
}

function add(a: Pt, b: Pt): Pt {
  return [a[0] + b[0], a[1] + b[1]];
}

function scale(a: Pt, k: number): Pt {
  return [a[0] * k, a[1] * k];
}

function dot(a: Pt, b: Pt): number {
  return a[0] * b[0] + a[1] * b[1];
}

function cross(a: Pt, b: Pt): number {
  return a[0] * b[1] - a[1] * b[0];
}

function clampSides(sides: number): number {
  if (!Number.isFinite(sides)) return 6;
  return Math.min(MAX_SIDES, Math.max(MIN_SIDES, Math.round(sides)));
}
