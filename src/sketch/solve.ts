/**
 * --- S4 in-house constraint solver ---
 *
 * Levenberg-Marquardt over the sketch's point coordinates, circle radii, and arc bulges.
 * No PlaneGCS, FreeCAD, or other LGPL/WASM solver: the app stays MIT plus the dynamically
 * linked OCCT. Tens of entities are a dense system of a few hundred numbers.
 *
 * A sketch with nothing the solver understands is not touched. `dragSketch` then moves
 * points the way the editor always has.
 */
import { arcFrom3, type Pt } from "./geom.ts";
import { sketchEntity, sketchPoint, type Dimension, type SketchData, type SketchEntity } from "./model.ts";

const LREF = 10;
const SOLVE_TOL = 1e-6;
const RANK_TOL = 1e-8;
const MAX_ITER = 40;

export type SketchConstraint =
  | { id: number; kind: "horizontal" | "vertical"; line: number }
  | { id: number; kind: "horizontal" | "vertical"; a: number; b: number }
  | { id: number; kind: "parallel" | "perpendicular" | "equal" | "concentric"; a: number; b: number }
  | { id: number; kind: "tangent"; a: number; b: number; side?: 1 | -1; inner?: boolean }
  | { id: number; kind: "fixed"; point: number }
  | { id: number; kind: "midpoint"; point: number; line: number }
  | { id: number; kind: "distance"; a: number; b: number; value: number }
  | { id: number; kind: "distance"; point: number; line: number; value: number; side: 1 | -1 }
  | { id: number; kind: "length"; line: number; value: number }
  | { id: number; kind: "radius" | "diameter"; entity: number; value: number }
  | { id: number; kind: "angle"; a: number; b: number; value: number };

export interface ConstraintStatus {
  dof: number;
  fullyDefined: boolean;
  redundant: number[];
  conflicting: number[];
  residual: number;
}

export interface SolveResult extends ConstraintStatus {
  ran: boolean;
  sketch: SketchData;
  /** The geometry satisfies every constraint that is not conflicting or redundant. */
  ok: boolean;
}

interface Slot {
  kind: "px" | "py" | "radius" | "sagitta";
  id: number;
}

interface RowGroup {
  id: number;
  rows: number[];
}

/** Constraints the solver understands. A stored dim it does not understand is left in place and ignored. */
export function parseConstraints(sketch: SketchData): SketchConstraint[] {
  const out: SketchConstraint[] = [];
  for (const raw of sketch.dims ?? []) {
    const parsed = parseConstraint(raw);
    if (parsed) out.push(parsed);
  }
  return out;
}

export function hasSolvableConstraints(sketch: SketchData): boolean {
  return parseConstraints(sketch).length > 0;
}

export function constraintStatus(sketch: SketchData): ConstraintStatus | null {
  const parsed = parseConstraints(sketch);
  if (parsed.length === 0) return null;
  return analyse(sketch, parsed).status;
}

/** Moves `ids` by `delta`. With no solvable constraint this is a plain translation, fixed points included as immovable. */
export function dragSketch(sketch: SketchData, ids: readonly number[], delta: Pt): SketchData {
  if (!hasSolvableConstraints(sketch)) return translatePoints(sketch, ids, delta);
  const parsed = parseConstraints(sketch);
  const referenced = referencedPoints(sketch, parsed);
  const plain: number[] = [];
  const bound: number[] = [];
  for (const id of ids) {
    const point = sketchPoint(sketch, id);
    if (!point || point.fixed) continue;
    if (referenced.has(id)) bound.push(id);
    else plain.push(id);
  }
  let next = translatePoints(sketch, plain, delta);
  if (bound.length === 0 || (delta[0] === 0 && delta[1] === 0)) return next;
  return walkDrag(next, bound, delta, parsed);
}

export function solveSketch(sketch: SketchData): SolveResult {
  const parsed = parseConstraints(sketch);
  if (parsed.length === 0) {
    return { ran: false, sketch, ok: true, dof: 0, fullyDefined: false, redundant: [], conflicting: [], residual: 0 };
  }
  const locked = lockFixed(sketch, parsed);
  const solved = levenberg(locked, parsed);
  const written = writeState(locked, solved.x, solved.slots, parsed);
  const analysis = analyse(written, parsed);
  return { ran: true, sketch: written, ok: analysis.status.conflicting.length === 0 && analysis.residual <= 1e-4, ...analysis.status };
}

function parseConstraint(raw: Dimension): SketchConstraint | null {
  const kind = raw.kind;
  const id = raw.id;
  if (typeof kind !== "string" || !Number.isInteger(id)) return null;
  const num = (key: string) => (typeof raw[key] === "number" && Number.isFinite(raw[key] as number) ? (raw[key] as number) : null);
  if (kind === "horizontal" || kind === "vertical") {
    const line = num("line");
    if (line != null && Number.isInteger(line)) return { id, kind, line };
    const a = num("a");
    const b = num("b");
    if (a != null && b != null && Number.isInteger(a) && Number.isInteger(b)) return { id, kind, a, b };
    return null;
  }
  if (kind === "parallel" || kind === "perpendicular" || kind === "equal" || kind === "concentric") {
    const a = num("a");
    const b = num("b");
    if (a == null || b == null || !Number.isInteger(a) || !Number.isInteger(b)) return null;
    return { id, kind, a, b };
  }
  if (kind === "tangent") {
    const a = num("a");
    const b = num("b");
    if (a == null || b == null || !Number.isInteger(a) || !Number.isInteger(b)) return null;
    const constraint: SketchConstraint = { id, kind, a, b };
    if (raw.side === 1 || raw.side === -1) constraint.side = raw.side;
    if (typeof raw.inner === "boolean") constraint.inner = raw.inner;
    return constraint;
  }
  if (kind === "fixed") {
    const point = num("point");
    if (point == null || !Number.isInteger(point)) return null;
    return { id, kind, point };
  }
  if (kind === "midpoint") {
    const point = num("point");
    const line = num("line");
    if (point == null || line == null || !Number.isInteger(point) || !Number.isInteger(line)) return null;
    return { id, kind, point, line };
  }
  if (kind === "distance") {
    const value = num("value");
    if (value == null) return null;
    const point = num("point");
    const line = num("line");
    if (point != null && line != null && Number.isInteger(point) && Number.isInteger(line) && (raw.side === 1 || raw.side === -1)) {
      return { id, kind, point, line, value, side: raw.side };
    }
    const a = num("a");
    const b = num("b");
    if (a != null && b != null && Number.isInteger(a) && Number.isInteger(b)) return { id, kind, a, b, value };
    return null;
  }
  if (kind === "length") {
    const line = num("line");
    const value = num("value");
    if (line == null || value == null || !Number.isInteger(line)) return null;
    return { id, kind, line, value };
  }
  if (kind === "radius" || kind === "diameter") {
    const entity = num("entity");
    const value = num("value");
    if (entity == null || value == null || !Number.isInteger(entity)) return null;
    return { id, kind, entity, value };
  }
  if (kind === "angle") {
    const a = num("a");
    const b = num("b");
    const value = num("value");
    if (a == null || b == null || value == null || !Number.isInteger(a) || !Number.isInteger(b)) return null;
    return { id, kind, a, b, value };
  }
  return null;
}

function translatePoints(sketch: SketchData, ids: readonly number[], delta: Pt): SketchData {
  const moving = new Set(ids);
  if (moving.size === 0 || (delta[0] === 0 && delta[1] === 0)) return sketch;
  return {
    ...sketch,
    points: sketch.points.map((point) => {
      if (!moving.has(point.id) || point.fixed) return point;
      return { ...point, at: [point.at[0] + delta[0], point.at[1] + delta[1]] as Pt };
    }),
  };
}

function lockFixed(sketch: SketchData, constraints: readonly SketchConstraint[]): SketchData {
  const ids = new Set(constraints.filter((item) => item.kind === "fixed").map((item) => (item.kind === "fixed" ? item.point : -1)));
  if (ids.size === 0) return sketch;
  let changed = false;
  const points = sketch.points.map((point) => {
    if (!ids.has(point.id) || point.fixed) return point;
    changed = true;
    return { ...point, fixed: true as const };
  });
  return changed ? { ...sketch, points } : sketch;
}

class Geom {
  points = new Map<number, Pt>();
  radii = new Map<number, number>();
  sagittas = new Map<number, number>();

  constructor(sketch: SketchData) {
    for (const point of sketch.points) this.points.set(point.id, [point.at[0], point.at[1]]);
    for (const entity of sketch.entities) {
      if (entity.kind === "circle") this.radii.set(entity.id, entity.radius);
      if (entity.kind === "arc") {
        const a = this.points.get(entity.a);
        const b = this.points.get(entity.b);
        this.sagittas.set(entity.id, a && b ? bulgeOf(a, b, entity.through) : 0);
      }
    }
  }

  point(id: number): Pt | null {
    return this.points.get(id) ?? null;
  }

  apply(x: readonly number[], slots: readonly Slot[]) {
    for (let i = 0; i < slots.length; i += 1) {
      const slot = slots[i]!;
      const value = x[i] ?? 0;
      if (slot.kind === "px" || slot.kind === "py") {
        const at = this.points.get(slot.id) ?? [0, 0];
        this.points.set(slot.id, slot.kind === "px" ? [value, at[1]] : [at[0], value]);
      } else if (slot.kind === "radius") this.radii.set(slot.id, Math.max(value, 1e-4));
      else this.sagittas.set(slot.id, value);
    }
  }

  pack(slots: readonly Slot[]): number[] {
    return slots.map((slot) => {
      if (slot.kind === "px") return this.points.get(slot.id)?.[0] ?? 0;
      if (slot.kind === "py") return this.points.get(slot.id)?.[1] ?? 0;
      if (slot.kind === "radius") return this.radii.get(slot.id) ?? 0;
      return this.sagittas.get(slot.id) ?? 0;
    });
  }
}

function bulgeOf(a: Pt, b: Pt, through: Pt): number {
  const arc = arcFrom3(a, through, b);
  if (!arc) return sagittaOf(a, b, through);
  const theta = arc.a0 + arc.sweep / 2;
  const mid: Pt = [arc.centre[0] + arc.radius * Math.cos(theta), arc.centre[1] + arc.radius * Math.sin(theta)];
  return sagittaOf(a, b, mid);
}

function sagittaOf(a: Pt, b: Pt, through: Pt): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const chord = Math.hypot(dx, dy);
  if (chord < 1e-12) return 0;
  const mid: Pt = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  return ((through[0] - mid[0]) * -dy + (through[1] - mid[1]) * dx) / chord;
}

function chordFrame(a: Pt, b: Pt): { mid: Pt; normal: Pt; half: number } | null {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const chord = Math.hypot(dx, dy);
  if (chord < 1e-9) return null;
  return { mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], normal: [-dy / chord, dx / chord], half: chord / 2 };
}

function arcCircle(a: Pt, b: Pt, sigma: number): { centre: Pt; radius: number } | null {
  const frame = chordFrame(a, b);
  if (!frame || Math.abs(sigma) < 1e-8) return null;
  const radius = (sigma * sigma + frame.half * frame.half) / (2 * Math.abs(sigma));
  const t = (sigma * sigma - frame.half * frame.half) / (2 * sigma);
  if (!Number.isFinite(radius) || radius > 1e8) return null;
  return { centre: [frame.mid[0] + frame.normal[0] * t, frame.mid[1] + frame.normal[1] * t], radius };
}

function throughOf(a: Pt, b: Pt, sigma: number): Pt | null {
  const frame = chordFrame(a, b);
  if (!frame) return null;
  return [frame.mid[0] + frame.normal[0] * sigma, frame.mid[1] + frame.normal[1] * sigma];
}

function slotsFor(sketch: SketchData, constraints: readonly SketchConstraint[]): Slot[] {
  const points = referencedPoints(sketch, constraints);
  const radii = new Set<number>();
  const arcs = new Set<number>();
  for (const constraint of constraints) {
    for (const id of radiusUsers(sketch, constraint)) radii.add(id);
    for (const id of arcUsers(sketch, constraint)) arcs.add(id);
  }
  const slots: Slot[] = [];
  for (const point of sketch.points) {
    if (point.fixed || !points.has(point.id)) continue;
    slots.push({ kind: "px", id: point.id }, { kind: "py", id: point.id });
  }
  for (const entity of sketch.entities) {
    if (entity.kind === "circle" && radii.has(entity.id)) slots.push({ kind: "radius", id: entity.id });
    if (entity.kind === "arc" && arcs.has(entity.id)) slots.push({ kind: "sagitta", id: entity.id });
  }
  return slots;
}

function referencedPoints(sketch: SketchData, constraints: readonly SketchConstraint[]): Set<number> {
  const ids = new Set<number>();
  const take = (id: number | undefined) => {
    if (id != null) ids.add(id);
  };
  const takeEntity = (id: number) => {
    const entity = sketchEntity(sketch, id);
    if (!entity) return;
    if (entity.kind === "line" || entity.kind === "arc") {
      take(entity.a);
      take(entity.b);
    } else if (entity.kind === "circle") take(entity.centre);
    else for (const point of entity.through) take(point);
  };
  for (const constraint of constraints) {
    if (constraint.kind === "horizontal" || constraint.kind === "vertical") {
      if ("line" in constraint) takeEntity(constraint.line);
      else {
        take(constraint.a);
        take(constraint.b);
      }
    } else if (constraint.kind === "fixed") take(constraint.point);
    else if (constraint.kind === "midpoint") {
      take(constraint.point);
      takeEntity(constraint.line);
    } else if (constraint.kind === "distance" && "point" in constraint) {
      take(constraint.point);
      takeEntity(constraint.line);
    } else if (constraint.kind === "distance") {
      take(constraint.a);
      take(constraint.b);
    } else if (constraint.kind === "length") takeEntity(constraint.line);
    else if (constraint.kind === "radius" || constraint.kind === "diameter") takeEntity(constraint.entity);
    else if ("a" in constraint && "b" in constraint) {
      takeEntity(constraint.a);
      takeEntity(constraint.b);
    }
  }
  return ids;
}

function radiusUsers(sketch: SketchData, constraint: SketchConstraint): number[] {
  const out: number[] = [];
  const consider = (id: number) => {
    const entity = sketchEntity(sketch, id);
    if (entity?.kind === "circle") out.push(id);
  };
  if (constraint.kind === "equal" || constraint.kind === "tangent") {
    consider(constraint.a);
    consider(constraint.b);
  } else if ((constraint.kind === "radius" || constraint.kind === "diameter") && sketchEntity(sketch, constraint.entity)?.kind === "circle") {
    out.push(constraint.entity);
  }
  return out;
}

function arcUsers(sketch: SketchData, constraint: SketchConstraint): number[] {
  const out: number[] = [];
  const consider = (id: number) => {
    if (sketchEntity(sketch, id)?.kind === "arc") out.push(id);
  };
  if (constraint.kind === "equal" || constraint.kind === "tangent" || constraint.kind === "concentric") {
    consider(constraint.a);
    consider(constraint.b);
  } else if (constraint.kind === "radius" || constraint.kind === "diameter") consider(constraint.entity);
  return out;
}

interface Built {
  rows: number[];
  groups: RowGroup[];
}

function residuals(sketch: SketchData, geom: Geom, constraints: readonly SketchConstraint[]): Built {
  const rows: number[] = [];
  const groups: RowGroup[] = [];
  for (const constraint of constraints) {
    const start = rows.length;
    pushResidual(sketch, geom, constraint, rows);
    if (rows.length > start) groups.push({ id: constraint.id, rows: range(start, rows.length) });
  }
  return { rows, groups };
}

function pushResidual(sketch: SketchData, geom: Geom, constraint: SketchConstraint, rows: number[]) {
  const lineEnds = (id: number): [Pt, Pt] | null => {
    const entity = sketchEntity(sketch, id);
    if (entity?.kind !== "line") return null;
    const a = geom.point(entity.a);
    const b = geom.point(entity.b);
    return a && b ? [a, b] : null;
  };
  const circleAt = (id: number): { centre: Pt; radius: number } | null => {
    const entity = sketchEntity(sketch, id);
    if (entity?.kind === "circle") {
      const centre = geom.point(entity.centre);
      const radius = geom.radii.get(entity.id);
      if (!centre || radius == null) return null;
      return { centre, radius };
    }
    if (entity?.kind === "arc") {
      const a = geom.point(entity.a);
      const b = geom.point(entity.b);
      const sigma = geom.sagittas.get(entity.id) ?? 0;
      if (!a || !b) return null;
      return arcCircle(a, b, sigma);
    }
    return null;
  };
  if (constraint.kind === "horizontal" || constraint.kind === "vertical") {
    const pair = "line" in constraint ? lineEnds(constraint.line) : pairOf(geom, constraint.a, constraint.b);
    if (!pair) return;
    rows.push(constraint.kind === "horizontal" ? pair[1][1] - pair[0][1] : pair[1][0] - pair[0][0]);
    return;
  }
  if (constraint.kind === "parallel" || constraint.kind === "perpendicular") {
    const a = lineEnds(constraint.a);
    const b = lineEnds(constraint.b);
    if (!a || !b) return;
    const ua = unit(sub(a[1], a[0]));
    const ub = unit(sub(b[1], b[0]));
    if (!ua || !ub) return;
    rows.push((constraint.kind === "parallel" ? cross(ua, ub) : dot(ua, ub)) * LREF);
    return;
  }
  if (constraint.kind === "equal") {
    const la = lineEnds(constraint.a);
    const lb = lineEnds(constraint.b);
    if (la && lb) {
      rows.push(dist(la[0], la[1]) - dist(lb[0], lb[1]));
      return;
    }
    const ca = circleAt(constraint.a);
    const cb = circleAt(constraint.b);
    if (ca && cb) rows.push(ca.radius - cb.radius);
    return;
  }
  if (constraint.kind === "concentric") {
    const ca = circleAt(constraint.a);
    const cb = circleAt(constraint.b);
    if (!ca || !cb) return;
    rows.push(ca.centre[0] - cb.centre[0], ca.centre[1] - cb.centre[1]);
    return;
  }
  if (constraint.kind === "tangent") {
    pushTangent(sketch, geom, constraint, rows, lineEnds, circleAt);
    return;
  }
  if (constraint.kind === "midpoint") {
    const point = geom.point(constraint.point);
    const line = lineEnds(constraint.line);
    if (!point || !line) return;
    rows.push(2 * point[0] - line[0][0] - line[1][0], 2 * point[1] - line[0][1] - line[1][1]);
    return;
  }
  if (constraint.kind === "distance" && "point" in constraint) {
    const point = geom.point(constraint.point);
    const line = lineEnds(constraint.line);
    if (!point || !line) return;
    const signed = signedDistance(line[0], line[1], point);
    if (signed == null) return;
    rows.push(signed - constraint.side * constraint.value);
    return;
  }
  if (constraint.kind === "distance") {
    const pair = pairOf(geom, constraint.a, constraint.b);
    if (!pair) return;
    rows.push(dist(pair[0], pair[1]) - constraint.value);
    return;
  }
  if (constraint.kind === "length") {
    const line = lineEnds(constraint.line);
    if (!line) return;
    rows.push(dist(line[0], line[1]) - constraint.value);
    return;
  }
  if (constraint.kind === "radius" || constraint.kind === "diameter") {
    const circle = circleAt(constraint.entity);
    if (!circle) {
      rows.push(1e3);
      return;
    }
    const target = constraint.kind === "diameter" ? constraint.value / 2 : constraint.value;
    rows.push(circle.radius - target);
    return;
  }
  if (constraint.kind === "angle") {
    const a = lineEnds(constraint.a);
    const b = lineEnds(constraint.b);
    if (!a || !b) return;
    const ua = unit(sub(a[1], a[0]));
    const ub = unit(sub(b[1], b[0]));
    if (!ua || !ub) return;
    const measured = Math.atan2(cross(ua, ub), dot(ua, ub));
    rows.push(wrapPi(measured - (constraint.value * Math.PI) / 180) * LREF);
  }
}

function pushTangent(
  sketch: SketchData,
  geom: Geom,
  constraint: Extract<SketchConstraint, { kind: "tangent" }>,
  rows: number[],
  lineEnds: (id: number) => [Pt, Pt] | null,
  circleAt: (id: number) => { centre: Pt; radius: number } | null,
) {
  const ea = sketchEntity(sketch, constraint.a);
  const eb = sketchEntity(sketch, constraint.b);
  if (!ea || !eb) return;
  const line = ea.kind === "line" ? constraint.a : eb.kind === "line" ? constraint.b : null;
  const other = line === constraint.a ? constraint.b : line === constraint.b ? constraint.a : null;
  if (line != null && other != null) {
    const ends = lineEnds(line);
    const circle = circleAt(other);
    if (!ends || !circle) return;
    const shared = sharedPoint(sketchEntity(sketch, line), sketchEntity(sketch, other));
    if (shared != null && sketchEntity(sketch, other)?.kind === "arc") {
      const at = geom.point(shared);
      const dir = unit(sub(ends[1], ends[0]));
      if (!at || !dir) return;
      const radial = unit(sub(at, circle.centre));
      if (!radial) return;
      rows.push(dot(radial, dir) * LREF);
      return;
    }
    const signed = signedDistance(ends[0], ends[1], circle.centre);
    if (signed == null) return;
    const side = constraint.side ?? (Math.sign(signed) || 1);
    rows.push(signed - side * circle.radius);
    return;
  }
  const ca = circleAt(constraint.a);
  const cb = circleAt(constraint.b);
  if (!ca || !cb) return;
  const gap = dist(ca.centre, cb.centre);
  const external = ca.radius + cb.radius;
  const internal = Math.abs(ca.radius - cb.radius);
  const inner = constraint.inner ?? Math.abs(gap - internal) < Math.abs(gap - external);
  rows.push(gap - (inner ? internal : external));
}

function sharedPoint(a: SketchEntity | undefined, b: SketchEntity | undefined): number | null {
  if (!a || !b || a.kind === "circle" || b.kind === "circle" || a.kind === "spline" || b.kind === "spline") return null;
  if (a.kind !== "line" && a.kind !== "arc") return null;
  if (b.kind !== "line" && b.kind !== "arc") return null;
  if (a.a === b.a || a.a === b.b) return a.a;
  if (a.b === b.a || a.b === b.b) return a.b;
  return null;
}

function pairOf(geom: Geom, a: number, b: number): [Pt, Pt] | null {
  const pa = geom.point(a);
  const pb = geom.point(b);
  return pa && pb ? [pa, pb] : null;
}

function signedDistance(a: Pt, b: Pt, point: Pt): number | null {
  const dir = unit(sub(b, a));
  if (!dir) return null;
  return cross(dir, sub(point, a));
}

function levenberg(sketch: SketchData, constraints: readonly SketchConstraint[]): { x: number[]; slots: Slot[] } {
  const slots = slotsFor(sketch, constraints);
  const geom = new Geom(sketch);
  let x = geom.pack(slots);
  if (slots.length === 0) return { x, slots };
  let lambda = 1e-2;
  let current = norm(residuals(sketch, geom, constraints).rows);
  for (let iter = 0; iter < MAX_ITER; iter += 1) {
    if (current < SOLVE_TOL) break;
    const j = jacobian(sketch, constraints, geom, x, slots);
    const r = residuals(sketch, geom, constraints).rows;
    const step = dampStep(j, r, lambda);
    if (!step) {
      lambda = Math.min(lambda * 8, 1e12);
      if (lambda >= 1e12) break;
      continue;
    }
    const trial = x.map((value, index) => value + guardStep(slots[index]!, value, step[index] ?? 0));
    geom.apply(trial, slots);
    const next = norm(residuals(sketch, geom, constraints).rows);
    if (next < current) {
      x = trial;
      current = next;
      lambda = Math.max(lambda / 3, 1e-8);
    } else {
      geom.apply(x, slots);
      lambda = Math.min(lambda * 8, 1e12);
      if (lambda >= 1e12) break;
    }
  }
  geom.apply(x, slots);
  return { x, slots };
}

function guardStep(slot: Slot, value: number, delta: number): number {
  if (!Number.isFinite(delta)) return 0;
  if (Math.abs(delta) > 100) delta = Math.sign(delta) * 100;
  if (slot.kind === "sagitta" && value * (value + delta) < 0) return -value * 0.5;
  if (slot.kind === "radius" && value + delta < 1e-4) return Math.max(1e-4 - value, -value * 0.5);
  return delta;
}

function jacobian(sketch: SketchData, constraints: readonly SketchConstraint[], geom: Geom, x: number[], slots: readonly Slot[]): number[][] {
  const base = residuals(sketch, geom, constraints).rows;
  const cols: number[][] = [];
  const h = 1e-6;
  for (let index = 0; index < slots.length; index += 1) {
    const step = Math.max(h, Math.abs(x[index] ?? 0) * h);
    const up = x.slice();
    const down = x.slice();
    up[index] = (x[index] ?? 0) + step;
    down[index] = (x[index] ?? 0) - step;
    geom.apply(up, slots);
    const rp = residuals(sketch, geom, constraints).rows;
    geom.apply(down, slots);
    const rm = residuals(sketch, geom, constraints).rows;
    geom.apply(x, slots);
    cols.push(rp.map((value, row) => (value - (rm[row] ?? value)) / (2 * step) || 0));
  }
  return base.map((_, row) => cols.map((col) => col[row] ?? 0));
}

function dampStep(j: number[][], r: number[], lambda: number): number[] | null {
  const n = j[0]?.length ?? 0;
  if (n === 0) return [];
  const a = Array.from({ length: n }, () => Array(n).fill(0));
  const g = Array(n).fill(0);
  for (let row = 0; row < j.length; row += 1) {
    const jr = j[row] ?? [];
    for (let col = 0; col < n; col += 1) {
      g[col] += (jr[col] ?? 0) * (r[row] ?? 0);
      for (let other = 0; other < n; other += 1) a[col]![other] += (jr[col] ?? 0) * (jr[other] ?? 0);
    }
  }
  for (let col = 0; col < n; col += 1) a[col]![col] += lambda * Math.max(a[col]![col] ?? 0, 1e-8);
  const solved = solveLinear(a, g.map((value) => -value));
  return solved;
}

function solveLinear(aIn: number[][], bIn: number[]): number[] | null {
  const n = bIn.length;
  const m = aIn.map((row, index) => [...row, bIn[index] ?? 0]);
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < n; row += 1) if (Math.abs(m[row]![col] ?? 0) > Math.abs(m[pivot]![col] ?? 0)) pivot = row;
    if (Math.abs(m[pivot]![col] ?? 0) < 1e-14) return null;
    const swap = m[col]!;
    m[col] = m[pivot]!;
    m[pivot] = swap;
    const div = m[col]![col] ?? 1;
    for (let k = col; k <= n; k += 1) m[col]![k] = (m[col]![k] ?? 0) / div;
    for (let row = 0; row < n; row += 1) {
      if (row === col) continue;
      const factor = m[row]![col] ?? 0;
      if (factor === 0) continue;
      for (let k = col; k <= n; k += 1) m[row]![k] = (m[row]![k] ?? 0) - factor * (m[col]![k] ?? 0);
    }
  }
  return m.map((row) => row[n] ?? 0);
}

function writeState(sketch: SketchData, x: number[], slots: readonly Slot[], constraints: readonly SketchConstraint[]): SketchData {
  if (slots.length === 0) return lockFixed(sketch, constraints);
  const geom = new Geom(sketch);
  geom.apply(x, slots);
  const activeArcs = new Set(slots.filter((slot) => slot.kind === "sagitta").map((slot) => slot.id));
  const points = sketch.points.map((point) => {
    const at = geom.point(point.id);
    if (!at || (at[0] === point.at[0] && at[1] === point.at[1])) return point;
    return { ...point, at: [at[0], at[1]] as Pt };
  });
  const entities = sketch.entities.map((entity) => {
    if (entity.kind === "circle") {
      const radius = geom.radii.get(entity.id);
      if (radius == null || radius === entity.radius) return entity;
      return { ...entity, radius };
    }
    if (entity.kind === "arc" && activeArcs.has(entity.id)) {
      const a = geom.point(entity.a);
      const b = geom.point(entity.b);
      const sigma = geom.sagittas.get(entity.id) ?? 0;
      if (!a || !b) return entity;
      const through = throughOf(a, b, sigma);
      if (!through) return entity;
      return { ...entity, through };
    }
    return entity;
  });
  return lockFixed({ ...sketch, points, entities }, constraints);
}

function analyse(sketch: SketchData, constraints: readonly SketchConstraint[]): { status: ConstraintStatus; residual: number } {
  const geom = new Geom(sketch);
  const built = residuals(sketch, geom, constraints);
  const slots = geomSlots(sketch);
  const j = jacobian(sketch, constraints, geom, geom.pack(slots), slots);
  const rankAll = rankOf(j);
  const geomN = geometricDof(sketch);
  const redundant: number[] = [];
  const conflicting: number[] = [];
  const seenFixed = new Set<number>();
  for (const constraint of constraints) {
    if (constraint.kind !== "fixed") continue;
    if (!sketchPoint(sketch, constraint.point)) {
      conflicting.push(constraint.id);
      continue;
    }
    if (seenFixed.has(constraint.point)) redundant.push(constraint.id);
    else seenFixed.add(constraint.point);
  }
  let accepted: number[] = [];
  for (const group of built.groups) {
    const trial = accepted.concat(group.rows);
    const nextRank = rankOf(rowsOf(j, trial));
    const error = groupError(built.rows, group.rows);
    if (nextRank > rankOf(rowsOf(j, accepted))) accepted = trial;
    else if (error <= 1e-4) redundant.push(group.id);
    else conflicting.push(group.id);
    if (error > 1e-4 && !conflicting.includes(group.id)) conflicting.push(group.id);
  }
  for (const constraint of constraints) {
    if (constraint.kind === "fixed") continue;
    const group = built.groups.find((item) => item.id === constraint.id);
    if (!group && !conflicting.includes(constraint.id)) conflicting.push(constraint.id);
  }
  const residual = norm(built.rows);
  const dof = Math.max(0, geomN - rankAll);
  const ok = conflicting.length === 0 && residual <= 1e-4;
  return {
    residual,
    status: { dof, fullyDefined: ok && dof === 0, redundant, conflicting, residual },
  };
}

function geomSlots(sketch: SketchData): Slot[] {
  const slots: Slot[] = [];
  for (const point of sketch.points) {
    if (point.fixed) continue;
    slots.push({ kind: "px", id: point.id }, { kind: "py", id: point.id });
  }
  for (const entity of sketch.entities) {
    if (entity.kind === "circle") slots.push({ kind: "radius", id: entity.id });
    if (entity.kind === "arc") slots.push({ kind: "sagitta", id: entity.id });
  }
  return slots;
}

function geometricDof(sketch: SketchData): number {
  const points = sketch.points.filter((point) => !point.fixed).length * 2;
  const circles = sketch.entities.filter((entity) => entity.kind === "circle").length;
  const arcs = sketch.entities.filter((entity) => entity.kind === "arc").length;
  return points + circles + arcs;
}

function rowsOf(j: number[][], rows: number[]): number[][] {
  return rows.map((row) => j[row] ?? []);
}

function groupError(rows: number[], indexes: number[]): number {
  let sum = 0;
  for (const index of indexes) sum += (rows[index] ?? 0) ** 2;
  return Math.sqrt(sum);
}

function rankOf(j: number[][]): number {
  const n = j[0]?.length ?? 0;
  const m = j.length;
  if (n === 0 || m === 0) return 0;
  const a = Array.from({ length: n }, () => Array(n).fill(0));
  for (let row = 0; row < m; row += 1) {
    for (let col = 0; col < n; col += 1) {
      for (let other = 0; other < n; other += 1) a[col]![other] += (j[row]?.[col] ?? 0) * (j[row]?.[other] ?? 0);
    }
  }
  const values = jacobiValues(a);
  const scale = Math.max(1, ...values.map((value) => Math.abs(value)));
  return values.filter((value) => value > RANK_TOL * scale).length;
}

function nullBasis(j: number[][]): number[][] {
  const n = j[0]?.length ?? 0;
  if (n === 0) return [];
  if (j.length === 0) return Array.from({ length: n }, (_, index) => Array.from({ length: n }, (__, row) => (row === index ? 1 : 0)));
  const a = Array.from({ length: n }, () => Array(n).fill(0));
  for (const row of j) {
    for (let col = 0; col < n; col += 1) {
      for (let other = 0; other < n; other += 1) a[col]![other] += (row[col] ?? 0) * (row[other] ?? 0);
    }
  }
  const { values, vectors } = jacobi(a);
  const scale = Math.max(1, ...values.map((value) => Math.abs(value)));
  const basis: number[][] = [];
  for (let col = 0; col < n; col += 1) {
    if (values[col]! <= RANK_TOL * scale) basis.push(vectors.map((row) => row[col] ?? 0));
  }
  return basis;
}

function jacobiValues(a: number[][]): number[] {
  return jacobi(a).values;
}

function jacobi(input: number[][]): { values: number[]; vectors: number[][] } {
  const n = input.length;
  const s = input.map((row) => row.slice());
  const v: number[][] = Array.from({ length: n }, (_, row) => Array.from({ length: n }, (__, col) => (row === col ? 1 : 0)));
  for (let sweep = 0; sweep < 32; sweep += 1) {
    let off = 0;
    for (let p = 0; p < n; p += 1) for (let q = p + 1; q < n; q += 1) off += (s[p]![q] ?? 0) ** 2;
    if (off < 1e-24) break;
    for (let p = 0; p < n; p += 1) {
      for (let q = p + 1; q < n; q += 1) {
        const apq = s[p]![q] ?? 0;
        if (Math.abs(apq) < 1e-15) continue;
        const app = s[p]![p] ?? 0;
        const aqq = s[q]![q] ?? 0;
        const tau = (aqq - app) / (2 * apq);
        const t = Math.sign(tau || 1) / (Math.abs(tau) + Math.sqrt(1 + tau * tau));
        const c = 1 / Math.sqrt(1 + t * t);
        const ss = t * c;
        s[p]![p] = app - t * apq;
        s[q]![q] = aqq + t * apq;
        s[p]![q] = 0;
        s[q]![p] = 0;
        for (let r = 0; r < n; r += 1) {
          if (r === p || r === q) continue;
          const arp = s[r]![p] ?? 0;
          const arq = s[r]![q] ?? 0;
          const np = c * arp - ss * arq;
          const nq = ss * arp + c * arq;
          s[r]![p] = np;
          s[p]![r] = np;
          s[r]![q] = nq;
          s[q]![r] = nq;
        }
        for (let r = 0; r < n; r += 1) {
          const vrp = v[r]![p] ?? 0;
          const vrq = v[r]![q] ?? 0;
          v[r]![p] = c * vrp - ss * vrq;
          v[r]![q] = ss * vrp + c * vrq;
        }
      }
    }
  }
  return { values: s.map((row, index) => row[index] ?? 0), vectors: v };
}

function walkDrag(sketch: SketchData, ids: readonly number[], delta: Pt, constraints: readonly SketchConstraint[]): SketchData {
  let current = sketch;
  const targets = new Map<number, Pt>();
  for (const id of ids) {
    const at = sketchPoint(sketch, id)?.at;
    if (at) targets.set(id, [at[0] + delta[0], at[1] + delta[1]]);
  }
  for (let step = 0; step < 8; step += 1) {
    const slots = slotsFor(current, constraints);
    if (slots.length === 0) break;
    const geom = new Geom(current);
    const x = geom.pack(slots);
    const j = jacobian(current, constraints, geom, x, slots);
    const basis = nullBasis(j);
    if (basis.length === 0) break;
    const desired = slots.map((slot) => {
      const target = targets.get(slot.id);
      if (!target || (slot.kind !== "px" && slot.kind !== "py")) return 0;
      const at = geom.point(slot.id);
      if (!at) return 0;
      return slot.kind === "px" ? target[0] - at[0] : target[1] - at[1];
    });
    if (norm(desired) < 1e-6) break;
    const weighted = slots.map((slot) => (slot.kind === "px" || slot.kind === "py") && targets.has(slot.id));
    const motion = projectNull(basis, desired, weighted);
    if (norm(motion) < 1e-8) break;
    const scale = stepScale(desired, motion, weighted);
    const moved = x.map((value, index) => value + guardStep(slots[index]!, value, (motion[index] ?? 0) * scale));
    const trial = writeState(current, moved, slots, constraints);
    const cleaned = solveSketch(trial);
    if (!cleaned.ok) break;
    current = cleaned.sketch;
  }
  return current;
}

function projectNull(basis: number[][], desired: number[], weighted: boolean[]): number[] {
  const k = basis.length;
  const n = desired.length;
  const a = Array.from({ length: k }, () => Array(k).fill(0));
  const g = Array(k).fill(0);
  for (let row = 0; row < n; row += 1) {
    if (!weighted[row]) continue;
    for (let col = 0; col < k; col += 1) {
      g[col] += (basis[col]?.[row] ?? 0) * (desired[row] ?? 0);
      for (let other = 0; other < k; other += 1) a[col]![other] += (basis[col]?.[row] ?? 0) * (basis[other]?.[row] ?? 0);
    }
  }
  const alpha = solveRelaxed(a, g);
  const motion = Array(n).fill(0);
  for (let col = 0; col < k; col += 1) {
    for (let row = 0; row < n; row += 1) motion[row] += (basis[col]?.[row] ?? 0) * (alpha[col] ?? 0);
  }
  return motion;
}

function solveRelaxed(aIn: number[][], bIn: number[]): number[] {
  const n = bIn.length;
  const m = aIn.map((row, index) => [...row, bIn[index] ?? 0]);
  const used = Array(n).fill(true);
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < n; row += 1) if (Math.abs(m[row]![col] ?? 0) > Math.abs(m[pivot]![col] ?? 0)) pivot = row;
    if (Math.abs(m[pivot]![col] ?? 0) < 1e-10) {
      used[col] = false;
      continue;
    }
    const swap = m[col]!;
    m[col] = m[pivot]!;
    m[pivot] = swap;
    const div = m[col]![col] ?? 1;
    for (let k = col; k <= n; k += 1) m[col]![k] = (m[col]![k] ?? 0) / div;
    for (let row = 0; row < n; row += 1) {
      if (row === col) continue;
      const factor = m[row]![col] ?? 0;
      for (let k = col; k <= n; k += 1) m[row]![k] = (m[row]![k] ?? 0) - factor * (m[col]![k] ?? 0);
    }
  }
  return m.map((row, index) => (used[index] ? row[n] ?? 0 : 0));
}

function stepScale(desired: number[], motion: number[], weighted: boolean[]): number {
  let scale = 1;
  for (let index = 0; index < desired.length; index += 1) {
    if (!weighted[index]) continue;
    const want = desired[index] ?? 0;
    const got = motion[index] ?? 0;
    if (Math.abs(got) > Math.abs(want) && Math.abs(got) > 1e-9) scale = Math.min(scale, Math.abs(want / got));
  }
  const length = norm(motion);
  if (length > 8) scale = Math.min(scale, 8 / length);
  return scale;
}

function range(start: number, end: number): number[] {
  const out: number[] = [];
  for (let index = start; index < end; index += 1) out.push(index);
  return out;
}

function norm(values: readonly number[]): number {
  let sum = 0;
  for (const value of values) sum += value * value;
  return Math.sqrt(sum);
}

function sub(a: Pt, b: Pt): Pt {
  return [a[0] - b[0], a[1] - b[1]];
}

function dot(a: Pt, b: Pt): number {
  return a[0] * b[0] + a[1] * b[1];
}

function cross(a: Pt, b: Pt): number {
  return a[0] * b[1] - a[1] * b[0];
}

function dist(a: Pt, b: Pt): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function unit(v: Pt): Pt | null {
  const length = Math.hypot(v[0], v[1]);
  if (length < 1e-12) return null;
  return [v[0] / length, v[1] / length];
}

function wrapPi(value: number): number {
  let next = value;
  while (next <= -Math.PI) next += Math.PI * 2;
  while (next > Math.PI) next -= Math.PI * 2;
  return next;
}
