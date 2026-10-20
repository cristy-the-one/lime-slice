/**
 * Which part of a shape a parameter handle changes.
 * Hovering a handle, dragging it, or focusing its number used to light the whole object.
 * This names the edges, circle, or arc that belong to that one number, plus a dimension the label can sit on.
 * Coordinates are either the primitive ghost's own frame (origin at 0, untilted) or model space, as `space` says.
 * A control with no edge to point at still returns a tooltip and its field, with `mapped` false.
 */

import type { DragHandle, Vec3 } from "./model-drag.ts";
import { dragLabel } from "./model-drag.ts";
import { turnCentre, type PrimitiveSpec } from "./model-primitive.ts";
import { axesOf, type Workplane } from "./workplane.ts";

export interface AspectDimension {
  from: Vec3;
  to: Vec3;
  text: string;
}

export interface HandleAspect {
  fields: readonly string[];
  /** "Width X 20 mm", the same sentence as the handle's tooltip. */
  tip: string;
  color: DragHandle["color"];
  /** Segments, six numbers each. */
  lines: number[];
  dimension: AspectDimension | null;
  /** `mesh` lines are still in the primitive's own frame. `body` is the open solid's frame. `world` is model space. */
  space: "mesh" | "body" | "world";
  /** Dim everything that this control does not change. */
  dim: boolean;
  /** False when no edge, circle, or arc belongs to this control. The tooltip and the field still link. */
  mapped: boolean;
}

export interface HoleMark {
  x: number;
  y: number;
  z: number;
  radius: number;
  depth: number;
  dir?: Vec3;
  bore?: { radius: number; depth: number };
}

export interface AspectContext {
  spec?: PrimitiveSpec | null;
  pieces?: readonly PrimitiveSpec[];
  hole?: HoleMark | null;
  /** A blend's edge, as a polyline in the solid's frame. */
  edgePoints?: ArrayLike<number> | null;
  /** An extrude or push/pull prism, in the solid's frame. */
  soup?: ArrayLike<number> | null;
  measure?: { a: Vec3; b: Vec3 } | null;
  plane?: { origin: Vec3; normal: Vec3; span?: number } | null;
  /** The open solid's box in its own frame. */
  bodyBox?: { min: readonly [number, number, number]; max: readonly [number, number, number] } | null;
  /** Where an axis line is drawn, in model space. */
  anchor?: Vec3;
  extent?: number;
  /** A feature's face. `at` is the position dot. */
  frame?: Workplane;
  at?: Vec3;
  /** The other fields' current numbers, so a width can draw the whole rectangle. */
  siblings?: Readonly<Record<string, number>>;
  values?: readonly number[];
  /** 1 keeps the dimension on its usual side. -1 moves it to the far side when the label would cover the knob. */
  gapSign?: 1 | -1;
}

/** Set for the duration of `aspectFor`, so every dimension uses the same side. */
let dimensionSign = 1;

/** The sentence on the handle and on its dimension: "Width X 20 mm". */
export function aspectTip(handle: Pick<DragHandle, "label" | "unit" | "shown">, values: readonly number[]): string {
  return dragLabel(handle, values);
}

interface LocalAspect {
  lines: number[];
  dimension: AspectDimension | null;
}

/** The lines and the dimension for `handle`, from whatever of the shape `ctx` knows. */
export function aspectFor(handle: DragHandle, ctx: AspectContext = {}): HandleAspect {
  dimensionSign = ctx.gapSign === -1 ? -1 : 1;
  const values = ctx.values ?? handle.values;
  const tip = aspectTip(handle, values);
  const blank = (): HandleAspect => ({
    fields: handle.fields,
    tip,
    color: handle.color,
    lines: [],
    dimension: null,
    space: "world",
    dim: false,
    mapped: false,
  });
  const done = (local: LocalAspect, space: HandleAspect["space"]): HandleAspect => ({
    ...blank(),
    lines: local.lines,
    dimension: local.dimension,
    space,
    dim: local.lines.length >= 6,
    mapped: local.lines.length >= 6,
  });

  const field = handle.fields[0] ?? "";
  const spec = ctx.spec;
  if (spec) {
    const local = primitiveLocal(spec, field, tip);
    if (local) return placeOnSpec(spec, done(local, "world"));
  }
  if (ctx.hole && isHoleField(field)) {
    const local = holeLocal(ctx.hole, field, handle, tip);
    if (local) return done(local, "world");
  }
  if (field === "modelBlend" || handle.id === "blend") {
    const local = blendLocal(ctx.edgePoints ?? null, handle, values, tip);
    if (local) return done(local, "world");
  }
  if (handle.id === "extrude" || handle.id === "pull" || field === "modelPull") {
    const local = travelLocal(handle, values, tip, ctx);
    if (local) return done(local, "world");
  }
  if (handle.id === "revolve") {
    const local = arcLocal(seatOf(handle) ?? ctx.anchor ?? [0, 0, 0], handle.dir, values[0] ?? 0, ctx.extent ?? 24, tip);
    if (local) return done(local, "world");
  }
  if (ctx.measure && (handle.id === "measure-a" || handle.id === "measure-b")) {
    return done(measureLocal(ctx.measure, handle, tip), "world");
  }
  if (ctx.plane && (handle.id === "plane" || field === "modelPlane")) {
    return done(planeLocal(ctx.plane, handle, tip), "world");
  }
  if ((handle.id.startsWith("tilt-") || field === "modelTiltA" || field === "modelTiltB") && ctx.plane) {
    return done(arcLocal(ctx.plane.origin, handle.dir, values[0] ?? 0, ctx.plane.span ?? ctx.extent ?? 24, tip), "world");
  }
  if (field === "modelShell" || handle.id === "shell") {
    const local = shellLocal(handle, values, tip, ctx.extent ?? 20);
    if (local) return done(local, "world");
  }
  if ((field === "modelFactor" || handle.id === "factor") && ctx.bodyBox) {
    return done(boxLocal(ctx.bodyBox, tip), "body");
  }
  if (ctx.pieces && ctx.pieces.length > 0) {
    const gathered = piecesLocal(ctx.pieces, field, tip);
    if (gathered) return done(gathered, "world");
  }
  if (ctx.frame && ctx.at && isFaceField(field)) {
    const local = faceLocal(ctx.frame, ctx.at, field, handle, values, ctx.siblings ?? {}, tip, ctx.extent ?? 20);
    if (local) return done(local, "world");
  }
  if (handle.unit === "°" || handle.kind === "ring") {
    const at = seatOf(handle) ?? ctx.anchor;
    if (at) return done(arcLocal(at, handle.dir, values[0] ?? 0, ctx.extent ?? 24, tip), "world");
  }
  if (handle.look === "arrow" && handle.kind === "axis") {
    const at = ctx.anchor ?? seatOf(handle);
    if (at) return done(axisGuide(at, handle.dir, ctx.extent ?? 20, tip), "world");
  }
  if (handle.kind === "surface") {
    const at = seatOf(handle);
    if (at) return done(crossAt(at, ctx.extent ?? 20, tip), "world");
  }
  return blank();
}

/** A primitive point, in model space, turned about its centre the way the ghost is. */
export function meshPoint(spec: PrimitiveSpec, point: Vec3): Vec3 {
  const centre = turnCentre(spec);
  const shifted: Vec3 = [point[0] - centre[0], point[1] - centre[1], point[2] - centre[2]];
  const spun = rotateZyx(spec.turn, shifted);
  return [spun[0] + spec.origin[0] + centre[0], spun[1] + spec.origin[1] + centre[1], spun[2] + spec.origin[2] + centre[2]];
}

/**
 * Boundary of the triangles that face `dir` and sit on the plane `dir · point = along`.
 * An extrude's moved cap, from the prism soup.
 */
export function capOutline(positions: ArrayLike<number>, dir: Vec3, along: number, tol: number): number[] {
  const normal = normalize(dir);
  const edges = new Map<string, { a: Vec3; b: Vec3; count: number }>();
  const key = (p: Vec3) => `${p[0].toFixed(3)},${p[1].toFixed(3)},${p[2].toFixed(3)}`;
  for (let i = 0; i + 8 < positions.length; i += 9) {
    const a: Vec3 = [positions[i]!, positions[i + 1]!, positions[i + 2]!];
    const b: Vec3 = [positions[i + 3]!, positions[i + 4]!, positions[i + 5]!];
    const c: Vec3 = [positions[i + 6]!, positions[i + 7]!, positions[i + 8]!];
    const face = cross(sub(b, a), sub(c, a));
    const length = Math.hypot(face[0], face[1], face[2]);
    if (!(length > 1e-8)) continue;
    if (dot(scale(face, 1 / length), normal) < 0.85) continue;
    const mid = scale(add(add(a, b), c), 1 / 3);
    if (Math.abs(dot(mid, normal) - along) > tol) continue;
    for (const [p, q] of [[a, b], [b, c], [c, a]] as const) {
      const id = [key(p), key(q)].sort().join("|");
      const prev = edges.get(id);
      if (prev) prev.count += 1;
      else edges.set(id, { a: p, b: q, count: 1 });
    }
  }
  const lines: number[] = [];
  for (const edge of edges.values()) if (edge.count === 1) lines.push(...edge.a, ...edge.b);
  return lines;
}

const HOLE_FIELDS = new Set(["modelHoleR", "modelHoleD", "modelBoreR", "modelBoreD", "modelX", "modelY", "modelZ"]);
function isHoleField(field: string): boolean {
  return HOLE_FIELDS.has(field);
}

const FACE_FIELDS = new Set([
  "modelFeatW", "modelFeatH", "modelFeatDia", "modelFeatDepth", "modelFeatU", "modelFeatV",
  "modelTexPitchU", "modelTexPitchV", "modelTexGroove", "modelArrPitchU", "modelArrPitchV",
  "modelRibPitch", "modelRibWidth", "modelTextHeight", "modelTextStroke", "modelTextSpace",
]);
function isFaceField(field: string): boolean {
  return FACE_FIELDS.has(field);
}

function placeOnSpec(spec: PrimitiveSpec, aspect: HandleAspect): HandleAspect {
  return {
    ...aspect,
    lines: transformLineBuffer(spec, aspect.lines),
    dimension: aspect.dimension
      ? { from: meshPoint(spec, aspect.dimension.from), to: meshPoint(spec, aspect.dimension.to), text: aspect.dimension.text }
      : null,
    space: "world",
  };
}

function transformLineBuffer(spec: PrimitiveSpec, lines: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i + 5 < lines.length; i += 6) {
    const a = meshPoint(spec, [lines[i]!, lines[i + 1]!, lines[i + 2]!]);
    const b = meshPoint(spec, [lines[i + 3]!, lines[i + 4]!, lines[i + 5]!]);
    out.push(...a, ...b);
  }
  return out;
}

function primitiveLocal(spec: PrimitiveSpec, field: string, tip: string): LocalAspect | null {
  switch (spec.primitive) {
    case "box":
    case "wedge":
      return blockLocal(spec, field, tip);
    case "ellipsoid":
      return ellipsoidLocal(spec, field, tip);
    case "cylinder":
      return roundLocal(spec.radius, spec.radius, spec.height, 0, field, tip, "cylinder");
    case "cone":
      return roundLocal(spec.radius, spec.topRadius ?? 0, spec.height, 0, field, tip, "cone");
    case "tube":
      return roundLocal(spec.radius, spec.radius, spec.height, spec.innerRadius ?? 0, field, tip, "tube");
    case "sphere":
      return sphereLocal(spec.radius, field, tip);
    case "torus":
      return torusLocal(spec.radius, spec.tubeRadius ?? 0, field, tip);
    case "polygon":
      return polygonLocal(spec, field, tip);
    default:
      return null;
  }
}

function blockLocal(spec: PrimitiveSpec, field: string, tip: string): LocalAspect | null {
  const [dx, dy, dz] = spec.size;
  if (!(dx > 0) || !(dy > 0) || !(dz > 0)) return null;
  const top = spec.primitive === "wedge" ? spec.topX ?? 0 : dx;
  const gap = Math.max(Math.max(dx, dy, dz) * 0.08, 0.6);
  const p = (x: number, y: number, z: number): Vec3 => [x, y, z];
  const xEdges: [Vec3, Vec3][] = [[p(0, 0, 0), p(dx, 0, 0)], [p(0, dy, 0), p(dx, dy, 0)], [p(0, 0, dz), p(top, 0, dz)], [p(0, dy, dz), p(top, dy, dz)]];
  const yEdges: [Vec3, Vec3][] = [[p(0, 0, 0), p(0, dy, 0)], [p(dx, 0, 0), p(dx, dy, 0)], [p(0, 0, dz), p(0, dy, dz)], [p(top, 0, dz), p(top, dy, dz)]];
  const zEdges: [Vec3, Vec3][] = [[p(0, 0, 0), p(0, 0, dz)], [p(0, dy, 0), p(0, dy, dz)], [p(dx, 0, 0), p(top, 0, dz)], [p(dx, dy, 0), p(top, dy, dz)]];
  if (field === "modelDx") return emphasize(xEdges, p(0, 0, 0), p(dx, 0, 0), [0, -1, 0], gap, tip);
  if (field === "modelDy") return emphasize(yEdges, p(0, 0, 0), p(0, dy, 0), [-1, 0, 0], gap, tip);
  if (field === "modelDz") return emphasize(zEdges, p(0, 0, 0), p(0, 0, dz), [-1, 0, 0], gap, tip);
  if (field === "modelTopX" && spec.primitive === "wedge") return emphasize([xEdges[2]!, xEdges[3]!], p(0, 0, dz), p(top, 0, dz), [0, -1, 0], gap, tip);
  return null;
}

function ellipsoidLocal(spec: PrimitiveSpec, field: string, tip: string): LocalAspect | null {
  const a = spec.size[0] / 2;
  const b = spec.size[1] / 2;
  const c = spec.size[2] / 2;
  if (!(a > 0) || !(b > 0) || !(c > 0)) return null;
  if (field === "modelDx") return ellipseDiameter([a, 0, 0], [0, 0, c], [-a, 0, 0], [a, 0, 0], tip);
  if (field === "modelDy") return ellipseDiameter([0, b, 0], [0, 0, c], [0, -b, 0], [0, b, 0], tip);
  if (field === "modelDz") return ellipseDiameter([a, 0, 0], [0, b, 0], [0, 0, -c], [0, 0, c], tip);
  return null;
}

/** An ellipse on two radii, and the diameter that this size is. */
function ellipseDiameter(u: Vec3, v: Vec3, from: Vec3, to: Vec3, tip: string): LocalAspect {
  const lines = ellipse(u, v, 48);
  return withDimension(lines, from, to, perpendicular(sub(to, from)), Math.max(len(u), len(v)) * 0.15, tip);
}

function roundLocal(bottom: number, top: number, height: number, inner: number, field: string, tip: string, kind: "cylinder" | "cone" | "tube"): LocalAspect | null {
  if (!(height > 0)) return null;
  const gap = Math.max(Math.max(bottom, top, inner) * 0.18, 0.6);
  if (field === "modelRadius") {
    const lines = circle([0, 0, 0], [0, 0, 1], bottom);
    if (kind !== "cone") lines.push(...circle([0, 0, height], [0, 0, 1], bottom));
    return withDimension(lines, [0, 0, height / 2], [bottom, 0, height / 2], [0, -1, 0], gap, tip);
  }
  if (field === "modelTopR") {
    const lines = circle([0, 0, height], [0, 0, 1], top);
    return withDimension(lines, [0, 0, height], [top, 0, height], [0, -1, 0], gap, tip);
  }
  if (field === "modelInnerR") {
    const lines = [...circle([0, 0, 0], [0, 0, 1], inner), ...circle([0, 0, height], [0, 0, 1], inner)];
    return withDimension(lines, [0, 0, height / 2], [inner, 0, height / 2], [0, -1, 0], gap, tip);
  }
  if (field === "modelHeight") {
    const reach = Math.max(bottom, top);
    const lines: number[] = [];
    for (const angle of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
      const x0 = bottom * Math.cos(angle);
      const y0 = bottom * Math.sin(angle);
      const x1 = (kind === "cone" ? top : bottom) * Math.cos(angle);
      const y1 = (kind === "cone" ? top : bottom) * Math.sin(angle);
      lines.push(x0, y0, 0, x1, y1, height);
    }
    return withDimension(lines, [reach, 0, 0], [kind === "cone" ? top : reach, 0, height], [1, 0, 0], gap, tip);
  }
  return null;
}

function sphereLocal(radius: number, field: string, tip: string): LocalAspect | null {
  if (field !== "modelRadius" || !(radius > 0)) return null;
  const lines = circle([0, 0, 0], [0, 0, 1], radius);
  return withDimension(lines, [0, 0, 0], [radius, 0, 0], [0, -1, 0], Math.max(radius * 0.12, 0.6), tip);
}

function torusLocal(ring: number, tube: number, field: string, tip: string): LocalAspect | null {
  if (!(ring > 0) || !(tube > 0)) return null;
  if (field === "modelRadius") {
    const lines = circle([0, 0, 0], [0, 0, 1], ring);
    return withDimension(lines, [0, 0, 0], [ring, 0, 0], [0, -1, 0], tube + 0.6, tip);
  }
  if (field === "modelTube") {
    const lines = circle([ring, 0, 0], [0, 1, 0], tube);
    return withDimension(lines, [ring, 0, 0], [ring + tube, 0, 0], [0, -1, 0], Math.max(tube * 0.2, 0.4), tip);
  }
  return null;
}

function polygonLocal(spec: PrimitiveSpec, field: string, tip: string): LocalAspect | null {
  const sides = spec.sides ?? 0;
  const across = spec.across ?? 0;
  const height = spec.height;
  const corners = polygonCorners(sides, across, spec.flats ?? false);
  if (corners.length < 3 || !(height > 0)) return null;
  const gap = Math.max(across * 0.08, 0.6);
  const loop = (z: number): [Vec3, Vec3][] => corners.map((corner, i) => {
    const next = corners[(i + 1) % corners.length]!;
    return [[corner[0], corner[1], z], [next[0], next[1], z]];
  });
  const verticals: [Vec3, Vec3][] = corners.map((corner) => [[corner[0], corner[1], 0], [corner[0], corner[1], height]]);
  if (field === "modelSides") {
    const lines = segments([...loop(0), ...loop(height), ...verticals]);
    const first = corners[0]!;
    return withDimension(lines, [0, 0, 0], [first[0], first[1], 0], [0, 0, 1], gap, tip);
  }
  if (field === "modelHeight") return emphasize(verticals, [corners[0]![0], corners[0]![1], 0], [corners[0]![0], corners[0]![1], height], [1, 0, 0], gap, tip);
  if (field === "modelAcross") {
    let low = corners[0]!;
    let high = corners[0]!;
    for (const corner of corners) {
      if (corner[1] < low[1]) low = corner;
      if (corner[1] > high[1]) high = corner;
    }
    const lines = segments(spec.flats ? [...loop(0), ...loop(height)] : []);
    lines.push(low[0], low[1], 0, high[0], high[1], 0);
    return withDimension(lines, [low[0], low[1], 0], [high[0], high[1], 0], [0, 0, 1], gap, tip);
  }
  return null;
}

/** Same corners as the ghost: one flat facing −Y when `flats` is set. */
function polygonCorners(sides: number, across: number, flats: boolean): [number, number][] {
  if (!Number.isInteger(sides) || sides < 3 || sides > 64 || !(across > 0)) return [];
  const corner = flats ? across / 2 / Math.cos(Math.PI / sides) : across / 2;
  return Array.from({ length: sides }, (_, i) => {
    const angle = -Math.PI / 2 - Math.PI / sides + (2 * Math.PI * i) / sides;
    return [corner * Math.cos(angle), corner * Math.sin(angle)];
  });
}

function holeLocal(hole: HoleMark, field: string, handle: DragHandle, tip: string): LocalAspect | null {
  const axis = normalize(hole.dir ?? [0, 0, -1]);
  const origin: Vec3 = [hole.x, hole.y, hole.z];
  const side = perpendicular(axis);
  if (field === "modelHoleR" || handle.id === "hole-radius") {
    const radius = hole.radius;
    const lines = circle(origin, axis, radius);
    return withDimension(lines, add(origin, scale(side, -radius)), add(origin, scale(side, radius)), perpendicular(side), Math.max(radius * 0.15, 0.4), tip);
  }
  if (field === "modelHoleD" || handle.id === "hole-depth") {
    const end = add(origin, scale(axis, hole.depth));
    return withDimension([], origin, end, side, Math.max(hole.radius * 0.3, 0.6), tip);
  }
  if ((field === "modelBoreR" || handle.id === "bore-radius") && hole.bore) {
    const radius = hole.bore.radius;
    const lines = circle(origin, axis, radius);
    return withDimension(lines, add(origin, scale(side, -radius)), add(origin, scale(side, radius)), perpendicular(side), Math.max(radius * 0.15, 0.4), tip);
  }
  if ((field === "modelBoreD" || handle.id === "bore-depth") && hole.bore) {
    const end = add(origin, scale(axis, hole.bore.depth));
    return withDimension([], origin, end, side, Math.max(hole.radius * 0.3, 0.6), tip);
  }
  if (handle.id.startsWith("hole-move")) return axisGuide(origin, handle.dir, Math.max(hole.radius * 4, 8), tip);
  if (field === "modelX" || field === "modelY" || field === "modelZ" || handle.id === "hole-origin") {
    return crossAt(origin, Math.max(hole.radius * 4, 6), tip);
  }
  return null;
}

function blendLocal(points: ArrayLike<number> | null, handle: DragHandle, values: readonly number[], tip: string): LocalAspect | null {
  const radius = values[0] ?? 0;
  if (points && points.length >= 6) {
    const lines: number[] = [];
    for (let i = 0; i + 5 < points.length; i += 3) lines.push(points[i]!, points[i + 1]!, points[i + 2]!, points[i + 3]!, points[i + 4]!, points[i + 5]!);
    const mid: Vec3 = [points[0]!, points[1]!, points[2]!];
    const out = normalize(handle.dir);
    return withDimension(lines, mid, add(mid, scale(out, Math.max(radius, 0.2))), perpendicular(out), Math.max(radius * 0.2, 0.4), tip);
  }
  const seat = seatOf(handle);
  if (!seat) return null;
  const out = normalize(handle.dir);
  const edge = add(seat, scale(out, -Math.max(radius, 0)));
  return withDimension([], edge, seat, perpendicular(out), Math.max(radius * 0.25, 0.4), tip);
}

function travelLocal(handle: DragHandle, values: readonly number[], tip: string, ctx: AspectContext): LocalAspect | null {
  const origin = seatOf(handle) ?? ctx.at ?? ctx.anchor;
  if (!origin) return null;
  const dir = normalize(handle.dir);
  const distance = values[0] ?? 0;
  const end = add(origin, scale(dir, distance));
  const lines: number[] = [];
  if (ctx.soup && ctx.soup.length >= 9 && Math.abs(distance) > 1e-4) {
    const along = dot(end, dir);
    const tol = Math.max(1, Math.abs(distance) * 0.2);
    lines.push(...capOutline(ctx.soup, dir, along, tol));
  }
  if (lines.length < 6) {
    const radius = Math.max((ctx.extent ?? 20) * 0.18, 4);
    lines.push(...circle(Math.abs(distance) > 1e-4 ? end : origin, dir, radius));
  }
  const side = perpendicular(dir);
  return withDimension(lines, origin, Math.abs(distance) > 1e-4 ? end : add(origin, scale(dir, Math.max((ctx.extent ?? 20) * 0.2, 4))), side, Math.max((ctx.extent ?? 20) * 0.04, 0.6), tip);
}

function measureLocal(measure: { a: Vec3; b: Vec3 }, handle: DragHandle, tip: string): LocalAspect {
  const lines = [...measure.a, ...measure.b];
  const at = handle.id === "measure-b" ? measure.b : measure.a;
  lines.push(...crossLines(at, Math.max(len(sub(measure.b, measure.a)) * 0.08, 1)));
  return { lines, dimension: { from: measure.a, to: measure.b, text: tip } };
}

function planeLocal(plane: { origin: Vec3; normal: Vec3; span?: number }, handle: DragHandle, tip: string): LocalAspect {
  const span = plane.span ?? 30;
  const lines = square(plane.origin, plane.normal, span);
  const dir = normalize(handle.dir);
  const end = add(plane.origin, scale(dir, Math.max(span * 0.2, 4)));
  return withDimension(lines, plane.origin, end, perpendicular(dir), Math.max(span * 0.04, 0.6), tip);
}

function shellLocal(handle: DragHandle, values: readonly number[], tip: string, extent: number): LocalAspect | null {
  const seat = seatOf(handle);
  if (!seat) return null;
  const dir = normalize(handle.dir);
  const thickness = Math.max(values[0] ?? 0, 0);
  const face = add(seat, scale(dir, -thickness));
  const lines = square(face, dir, Math.max(extent * 0.35, 8));
  return withDimension(lines, face, thickness > 0 ? seat : add(face, scale(dir, Math.max(extent * 0.08, 1))), perpendicular(dir), Math.max(extent * 0.04, 0.5), tip);
}

function boxLocal(box: { min: readonly [number, number, number]; max: readonly [number, number, number] }, tip: string): LocalAspect {
  const [x0, y0, z0] = box.min;
  const [x1, y1, z1] = box.max;
  const p = (x: number, y: number, z: number): Vec3 => [x, y, z];
  const edges: [Vec3, Vec3][] = [
    [p(x0, y0, z0), p(x1, y0, z0)], [p(x1, y0, z0), p(x1, y1, z0)], [p(x1, y1, z0), p(x0, y1, z0)], [p(x0, y1, z0), p(x0, y0, z0)],
    [p(x0, y0, z1), p(x1, y0, z1)], [p(x1, y0, z1), p(x1, y1, z1)], [p(x1, y1, z1), p(x0, y1, z1)], [p(x0, y1, z1), p(x0, y0, z1)],
    [p(x0, y0, z0), p(x0, y0, z1)], [p(x1, y0, z0), p(x1, y0, z1)], [p(x0, y1, z0), p(x0, y1, z1)], [p(x1, y1, z0), p(x1, y1, z1)],
  ];
  return emphasize(edges, p(x0, y0, z0), p(x1, y0, z0), [0, -1, 0], Math.max((x1 - x0) * 0.08, 0.6), tip);
}

const PIECE_FIELD: Record<string, string> = {
  modelFeatW: "modelDx",
  modelArrW: "modelDx",
  modelRibWidth: "modelDx",
  modelFeatBarW: "modelDx",
  modelFeatH: "modelDy",
  modelArrH: "modelDy",
  modelFeatDepth: "modelDz",
  modelTexGroove: "modelDz",
  modelFeatDia: "modelRadius",
  modelArrDia: "modelRadius",
  modelArrSides: "modelSides",
  modelArrAcross: "modelAcross",
};

function piecesLocal(pieces: readonly PrimitiveSpec[], field: string, tip: string): LocalAspect | null {
  const as = PIECE_FIELD[field];
  if (!as) return null;
  const lines: number[] = [];
  let dimension: AspectDimension | null = null;
  for (const spec of pieces) {
    const local = primitiveLocal(spec, as, tip);
    if (!local) continue;
    lines.push(...transformLineBuffer(spec, local.lines));
    if (!dimension && local.dimension) {
      dimension = {
        from: meshPoint(spec, local.dimension.from),
        to: meshPoint(spec, local.dimension.to),
        text: tip,
      };
    }
  }
  if (lines.length < 6) return null;
  return { lines, dimension };
}

function faceLocal(frame: Workplane, at: Vec3, field: string, handle: DragHandle, values: readonly number[], siblings: Readonly<Record<string, number>>, tip: string, extent: number): LocalAspect | null {
  const [u, v, w] = axesOf(frame);
  const width = siblings.modelFeatW ?? siblings.modelArrW ?? siblings.modelRibWidth ?? Math.max(extent * 0.3, 4);
  const height = siblings.modelFeatH ?? siblings.modelArrH ?? width;
  const number = values[0] ?? 0;
  if (field === "modelFeatW" || field === "modelArrW" || field === "modelRibWidth") {
    return faceEdges(at, u, v, siblings[field] ?? width, height, "u", tip);
  }
  if (field === "modelFeatH" || field === "modelArrH") return faceEdges(at, u, v, width, siblings[field] ?? height, "v", tip);
  if (field === "modelFeatDia" || field === "modelArrDia") {
    const radius = (siblings[field] ?? number) / 2;
    const lines = circle(at, w, radius);
    return withDimension(lines, add(at, scale(u, -radius)), add(at, scale(u, radius)), v, Math.max(radius * 0.15, 0.4), tip);
  }
  if (field === "modelFeatDepth" || field === "modelTexGroove") {
    const dir = normalize(handle.dir);
    const depth = Math.max(number, 0);
    const end = add(at, scale(dir, depth > 0 ? depth : Math.max(extent * 0.08, 1)));
    const lines = square(at, dir, Math.max(Math.min(width, height), 4));
    return withDimension(lines, at, end, perpendicular(dir), Math.max(extent * 0.04, 0.4), tip);
  }
  if (field === "modelTexPitchU" || field === "modelArrPitchU" || field === "modelRibPitch") {
    return pitchLocal(at, field === "modelRibPitch" ? v : u, Math.max(number, 0.1), tip);
  }
  if (field === "modelTexPitchV" || field === "modelArrPitchV") return pitchLocal(at, v, Math.max(number, 0.1), tip);
  if (field === "modelTextHeight") return pitchLocal(at, v, Math.max(number, 0.1), tip);
  if (field === "modelTextStroke") return pitchLocal(at, u, Math.max(number, 0.1), tip);
  if (field === "modelTextSpace") return pitchLocal(at, u, Math.max(number, 0.1), tip);
  return null;
}

function faceEdges(at: Vec3, u: Vec3, v: Vec3, width: number, height: number, along: "u" | "v", tip: string): LocalAspect {
  const c = (su: number, sv: number): Vec3 => add(at, add(scale(u, su * width / 2), scale(v, sv * height / 2)));
  const corners = [c(-1, -1), c(1, -1), c(1, 1), c(-1, 1)];
  const edges: [Vec3, Vec3][] = along === "u"
    ? [[corners[0]!, corners[1]!], [corners[3]!, corners[2]!]]
    : [[corners[1]!, corners[2]!], [corners[0]!, corners[3]!]];
  const [from, to] = edges[0]!;
  return emphasize(edges, from, to, along === "u" ? v : u, Math.max(Math.min(width, height) * 0.12, 0.4), tip);
}

function pitchLocal(at: Vec3, dir: Vec3, pitch: number, tip: string): LocalAspect {
  const end = add(at, scale(normalize(dir), pitch));
  return withDimension([], at, end, perpendicular(dir), Math.max(pitch * 0.15, 0.4), tip);
}

function arcLocal(at: Vec3, dir: Vec3, degrees: number, extent: number, tip: string): LocalAspect {
  const radius = Math.max(extent * 0.28, 6);
  const sweep = Math.abs(degrees) < 1 ? 40 : degrees;
  const lines = arc(at, normalize(dir), radius, 0, sweep, 32);
  const end = arcPoint(at, normalize(dir), radius, sweep);
  const start = arcPoint(at, normalize(dir), radius, 0);
  lines.push(...at, ...start, ...at, ...end);
  return { lines, dimension: { from: at, to: end, text: tip } };
}

function axisGuide(at: Vec3, dir: Vec3, extent: number, tip: string): LocalAspect {
  const axis = normalize(dir);
  const half = Math.max(extent * 0.35, 6);
  return withDimension([], add(at, scale(axis, -half)), add(at, scale(axis, half)), perpendicular(axis), Math.max(extent * 0.05, 0.6), tip);
}

function crossAt(at: Vec3, extent: number, tip: string): LocalAspect {
  const arm = Math.max(extent * 0.08, 2);
  return { lines: crossLines(at, arm), dimension: { from: add(at, [-arm, 0, 0]), to: add(at, [arm, 0, 0]), text: tip } };
}

function crossLines(at: Vec3, arm: number): number[] {
  return [
    at[0] - arm, at[1], at[2], at[0] + arm, at[1], at[2],
    at[0], at[1] - arm, at[2], at[0], at[1] + arm, at[2],
    at[0], at[1], at[2] - arm, at[0], at[1], at[2] + arm,
  ];
}

function seatOf(handle: DragHandle): Vec3 | null {
  return handle.seat.at === "feature" ? handle.seat.origin : null;
}

function emphasize(edges: readonly [Vec3, Vec3][], from: Vec3, to: Vec3, gapDir: Vec3, gap: number, tip: string): LocalAspect {
  return withDimension(segments(edges), from, to, gapDir, gap, tip);
}

function segments(edges: readonly [Vec3, Vec3][]): number[] {
  const lines: number[] = [];
  for (const [a, b] of edges) lines.push(...a, ...b);
  return lines;
}

/** The measured run, set off from the edge, with witness lines and arrowheads. */
function withDimension(lines: number[], from: Vec3, to: Vec3, gapDir: Vec3, gap: number, tip: string): LocalAspect {
  const offset = scale(normalize(gapDir), gap * dimensionSign);
  const a = add(from, offset);
  const b = add(to, offset);
  const span = sub(b, a);
  const head = Math.min(Math.max(len(span) * 0.22, 1.4), Math.max(len(span) * 0.4, 0.4));
  lines.push(...from, ...a, ...to, ...b, ...a, ...b, ...arrowHead(a, span, head), ...arrowHead(b, scale(span, -1), head));
  return { lines, dimension: { from: a, to: b, text: tip } };
}

/** Two barbs at `tip`, opening back along `toward`. */
function arrowHead(tip: Vec3, toward: Vec3, size: number): number[] {
  if (!(size > 0) || !(len(toward) > 1e-9)) return [];
  const dir = normalize(toward);
  const side = perpendicular(dir);
  const back = add(tip, scale(dir, size));
  const wing = size * 0.45;
  return [...tip, ...add(back, scale(side, wing)), ...tip, ...add(back, scale(side, -wing))];
}

function circle(center: Vec3, normal: Vec3, radius: number, segments = 40): number[] {
  if (!(radius > 0)) return [];
  return arc(center, normal, radius, 0, 360, segments);
}

function ellipse(u: Vec3, v: Vec3, segments: number): number[] {
  const lines: number[] = [];
  let prev = add(u, scale(v, 0));
  for (let i = 1; i <= segments; i += 1) {
    const t = (2 * Math.PI * i) / segments;
    const next = add(scale(u, Math.cos(t)), scale(v, Math.sin(t)));
    lines.push(...prev, ...next);
    prev = next;
  }
  return lines;
}

function arc(center: Vec3, normal: Vec3, radius: number, startDeg: number, sweepDeg: number, segments: number): number[] {
  const lines: number[] = [];
  const steps = Math.max(2, Math.round(segments * Math.min(Math.abs(sweepDeg) / 360, 1)));
  let prev = arcPoint(center, normal, radius, startDeg);
  for (let i = 1; i <= steps; i += 1) {
    const next = arcPoint(center, normal, radius, startDeg + (sweepDeg * i) / steps);
    lines.push(...prev, ...next);
    prev = next;
  }
  return lines;
}

function arcPoint(center: Vec3, normal: Vec3, radius: number, degrees: number): Vec3 {
  const n = normalize(normal);
  const side = perpendicular(n);
  const bit = normalize(cross(n, side));
  const t = degrees * Math.PI / 180;
  return add(center, add(scale(side, Math.cos(t) * radius), scale(bit, Math.sin(t) * radius)));
}

function square(origin: Vec3, normal: Vec3, span: number): number[] {
  const n = normalize(normal);
  const side = perpendicular(n);
  const bit = normalize(cross(n, side));
  const h = span / 2;
  const c = (su: number, sv: number): Vec3 => add(origin, add(scale(side, su * h), scale(bit, sv * h)));
  const corners = [c(-1, -1), c(1, -1), c(1, 1), c(-1, 1)];
  return segments([[corners[0]!, corners[1]!], [corners[1]!, corners[2]!], [corners[2]!, corners[3]!], [corners[3]!, corners[0]!]]);
}

function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}
function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function scale(a: Vec3, k: number): Vec3 {
  return [a[0] * k, a[1] * k, a[2] * k];
}
function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function len(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2]);
}
function normalize(a: Vec3): Vec3 {
  const length = len(a);
  return length > 1e-9 ? scale(a, 1 / length) : [0, 0, 1];
}
function perpendicular(dir: Vec3): Vec3 {
  const n = normalize(dir);
  const hint: Vec3 = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  return normalize(cross(n, hint));
}

/** The same turn as the view: Rz·Ry·Rx, three.js order ZYX. */
function rotateZyx(turn: Vec3, point: Vec3): Vec3 {
  const [x, y, z] = turn.map((deg) => deg * Math.PI / 180);
  const c1 = Math.cos(x / 2);
  const c2 = Math.cos(y / 2);
  const c3 = Math.cos(z / 2);
  const s1 = Math.sin(x / 2);
  const s2 = Math.sin(y / 2);
  const s3 = Math.sin(z / 2);
  const qx = s1 * c2 * c3 - c1 * s2 * s3;
  const qy = c1 * s2 * c3 + s1 * c2 * s3;
  const qz = c1 * c2 * s3 - s1 * s2 * c3;
  const qw = c1 * c2 * c3 + s1 * s2 * s3;
  const tx = 2 * (qy * point[2] - qz * point[1]);
  const ty = 2 * (qz * point[0] - qx * point[2]);
  const tz = 2 * (qx * point[1] - qy * point[0]);
  return [
    point[0] + qw * tx + (qy * tz - qz * ty),
    point[1] + qw * ty + (qz * tx - qx * tz),
    point[2] + qw * tz + (qx * ty - qy * tx),
  ];
}
