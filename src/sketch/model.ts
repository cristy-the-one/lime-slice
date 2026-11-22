/**
 * A sketch: the 2D drawing a feature is edited as (`docs/plan-gui-cad-modeling.md`, Plan B §4.1).
 *
 * Points are shared. A line, arc, or spline names them by id, so two lines that meet at a corner
 * share that point and a later drag of the corner moves both. An arc's bulge (`through`) is a
 * coordinate, not a point: it records the circle and is not a corner of its own.
 *
 * The whole value is plain JSON with `"v": 1`, the shape a feature will keep on its op. Driving
 * dimensions and constraints live in the optional `dims` field. An older sketch has no `dims`,
 * and a sketch that still has none is not solved (`src/sketch/solve.ts`).
 */
import { insertNurbsKnot2D, makeCreaseAtParam2D, resolveCurveKnots } from "../modeling/nurbs-eval.ts";

export type Pt = [number, number];
export type Vec3 = [number, number, number];

/** The face a sketch is drawn on, the same reference the engine stores for a face. */
export interface FaceRef {
  index: number;
  mid: Vec3;
  areaMm2: number;
}

/** A workplane in the part's own frame: `origin`, and `turn` about X, then Y, then Z. */
export interface SketchPlane {
  origin: Vec3;
  turn: Vec3;
}

/** What the user clicked to start the sketch. Absent when the plane was set on its own. */
export type SketchOn =
  | { kind: "face"; face: FaceRef }
  | { kind: "plane"; name: "XY" | "XZ" | "YZ" }
  | { kind: "workplane" };

export interface SketchPoint {
  id: number;
  at: Pt;
  /** A fixed point stays where it is once constraints exist. Stored only when set. */
  fixed?: true;
}

export type SplineMode = "cv" | "through";

export type SketchEntity =
  | { id: number; kind: "line"; a: number; b: number; construction?: true }
  | { id: number; kind: "arc"; a: number; b: number; through: Pt; construction?: true }
  | { id: number; kind: "circle"; centre: number; radius: number; construction?: true }
  | {
      id: number;
      kind: "spline";
      through: number[];
      /** "cv" = exact control-point NURBS; absent or "through" = interpolating spline. */
      mode?: SplineMode;
      weights?: number[];
      degree?: number;
      knots?: number[];
      mults?: number[];
      construction?: true;
    };

/**
 * A driving dimension or constraint stored on the sketch. Known kinds are read by the in-house
 * solver. Anything else with an id is kept so an older or newer file still opens.
 */
export interface Dimension {
  id: number;
  [key: string]: unknown;
}

export interface SketchData {
  v: 1;
  plane: SketchPlane;
  on?: SketchOn;
  points: SketchPoint[];
  entities: SketchEntity[];
  dims?: Dimension[];
  /** The card's name, kept so History can say "Sketch 1". The kernel never reads it. */
  name?: string;
}

/** The only sketch JSON this phase writes. */
export const SKETCH_VERSION = 1;

const GROUND: SketchPlane = { origin: [0, 0, 0], turn: [0, 0, 0] };

/** An empty sketch on `plane` (the ground plane when omitted). */
export function emptySketch(plane: SketchPlane = GROUND, on?: SketchOn): SketchData {
  const sketch: SketchData = { v: SKETCH_VERSION, plane: clonePlane(plane), points: [], entities: [] };
  if (on) sketch.on = cloneOn(on);
  return sketch;
}

export function sketchPoint(sketch: SketchData, id: number): SketchPoint | undefined {
  return sketch.points.find((point) => point.id === id);
}

export function sketchEntity(sketch: SketchData, id: number): SketchEntity | undefined {
  return sketch.entities.find((entity) => entity.id === id);
}

/** A point already within `eps` of `at`, if the sketch has one. */
export function pointNear(sketch: SketchData, at: Pt, eps = 1e-6): SketchPoint | undefined {
  return sketch.points.find((point) => Math.hypot(point.at[0] - at[0], point.at[1] - at[1]) <= eps);
}

export function nextPointId(sketch: SketchData): number {
  return sketch.points.reduce((max, point) => Math.max(max, point.id), 0) + 1;
}

export function nextEntityId(sketch: SketchData): number {
  return sketch.entities.reduce((max, entity) => Math.max(max, entity.id), 0) + 1;
}

export interface Added {
  sketch: SketchData;
  id: number;
}

/** Adds a point. `fixed` is stored only when true, so a free point has no `fixed` field. */
export function addPoint(sketch: SketchData, at: Pt, fixed?: boolean): Added {
  const id = nextPointId(sketch);
  const point: SketchPoint = { id, at: [at[0], at[1]] };
  if (fixed) point.fixed = true;
  return { sketch: { ...sketch, points: [...sketch.points, point] }, id };
}

/**
 * Resolves a corner: an existing point id, or a fresh point at a coordinate. An unknown id is
 * not created; the caller keeps the id and a later read fails it.
 */
function corner(sketch: SketchData, at: Pt | number): Added {
  if (typeof at === "number") return { sketch, id: at };
  return addPoint(sketch, at);
}

export function addLine(sketch: SketchData, a: Pt | number, b: Pt | number, construction?: boolean): Added {
  const first = corner(sketch, a);
  const second = corner(first.sketch, b);
  const id = nextEntityId(second.sketch);
  const entity: SketchEntity = { id, kind: "line", a: first.id, b: second.id };
  if (construction) entity.construction = true;
  return { sketch: { ...second.sketch, entities: [...second.sketch.entities, entity] }, id };
}

/** `a` → `b` through `through`, the three-point arc. */
export function addArc(sketch: SketchData, a: Pt | number, b: Pt | number, through: Pt, construction?: boolean): Added {
  const first = corner(sketch, a);
  const second = corner(first.sketch, b);
  const id = nextEntityId(second.sketch);
  const entity: SketchEntity = { id, kind: "arc", a: first.id, b: second.id, through: [through[0], through[1]] };
  if (construction) entity.construction = true;
  return { sketch: { ...second.sketch, entities: [...second.sketch.entities, entity] }, id };
}

export function addCircle(sketch: SketchData, centre: Pt | number, radius: number, construction?: boolean): Added {
  const point = corner(sketch, centre);
  const id = nextEntityId(point.sketch);
  const entity: SketchEntity = { id, kind: "circle", centre: point.id, radius };
  if (construction) entity.construction = true;
  return { sketch: { ...point.sketch, entities: [...point.sketch.entities, entity] }, id };
}

/** An open spline through the points, or a closed one when the first and last are the same point. */
export function addSpline(sketch: SketchData, through: readonly (Pt | number)[], construction?: boolean): Added {
  let next = sketch;
  const ids: number[] = [];
  for (const at of through) {
    const point = corner(next, at);
    next = point.sketch;
    ids.push(point.id);
  }
  const id = nextEntityId(next);
  const entity: SketchEntity = { id, kind: "spline", through: ids };
  if (construction) entity.construction = true;
  return { sketch: { ...next, entities: [...next.entities, entity] }, id };
}

export interface NurbsOptions {
  weights?: readonly number[];
  degree?: number;
  knots?: readonly number[];
  mults?: readonly number[];
  construction?: boolean;
}

/** An exact control-point NURBS curve in the sketch (poles, rational weights, degree, knots/mults). */
export function addNurbs(sketch: SketchData, poles: readonly (Pt | number)[], options: NurbsOptions = {}): Added {
  let next = sketch;
  const ids: number[] = [];
  for (const at of poles) {
    const point = corner(next, at);
    next = point.sketch;
    ids.push(point.id);
  }
  const id = nextEntityId(next);
  const entity: Extract<SketchEntity, { kind: "spline" }> = {
    id,
    kind: "spline",
    through: ids,
    mode: "cv",
    ...(options.weights && options.weights.length === ids.length ? { weights: [...options.weights] } : {}),
    ...(options.degree !== undefined ? { degree: options.degree } : {}),
    ...(options.knots && options.knots.length > 0 ? { knots: [...options.knots] } : {}),
    ...(options.mults && options.mults.length > 0 ? { mults: [...options.mults] } : {}),
    ...(options.construction ? { construction: true as const } : {}),
  };
  return { sketch: { ...next, entities: [...next.entities, entity] }, id };
}

/** Sets the rational weight of control point `controlIndex` on a spline (promotes to exact CV NURBS if needed). */
export function setSplineWeight(sketch: SketchData, entityId: number, controlIndex: number, weight: number): SketchData {
  if (!(weight > 0) || !Number.isFinite(weight)) return sketch;
  const entities = sketch.entities.map((entity) => {
    if (entity.id !== entityId || entity.kind !== "spline") return entity;
    if (controlIndex < 0 || controlIndex >= entity.through.length) return entity;
    const weights = entity.weights && entity.weights.length === entity.through.length ? [...entity.weights] : entity.through.map(() => 1);
    weights[controlIndex] = weight;
    return { ...entity, mode: "cv" as const, weights };
  });
  return { ...sketch, entities };
}

/** Toggles a spline entity between exact control-point NURBS ("cv") and interpolating ("through"). */
export function setSplineMode(sketch: SketchData, entityId: number, mode: SplineMode): SketchData {
  const entities = sketch.entities.map((entity) => {
    if (entity.id !== entityId || entity.kind !== "spline") return entity;
    if (mode === "cv") return { ...entity, mode: "cv" as const };
    const { mode: _m, weights: _w, degree: _d, knots: _k, mults: _mu, ...rest } = entity;
    return rest;
  });
  return { ...sketch, entities };
}

/** Inserts an exact knot at parameter `u` into a CV NURBS entity using Boehm's algorithm (curve shape unchanged). */
export function insertSplineKnot(sketch: SketchData, entityId: number, u: number): SketchData {
  const entity = sketchEntity(sketch, entityId);
  if (!entity || entity.kind !== "spline") return sketch;
  const poles: Pt[] = [];
  for (const id of entity.through) {
    const pt = sketchPoint(sketch, id);
    if (!pt) return sketch;
    poles.push(pt.at);
  }
  if (poles.length < 2) return sketch;
  const inserted = insertNurbsKnot2D(
    { poles, weights: entity.weights, degree: entity.degree, knots: entity.knots, mults: entity.mults },
    u,
    1,
  );
  let next = sketch;
  const newIds: number[] = [];
  const firstId = entity.through[0]!;
  const lastId = entity.through[entity.through.length - 1]!;
  for (let i = 0; i < inserted.poles.length; i += 1) {
    if (i === 0) newIds.push(firstId);
    else if (i === inserted.poles.length - 1) newIds.push(lastId);
    else {
      const added = addPoint(next, inserted.poles[i]!);
      next = added.sketch;
      newIds.push(added.id);
    }
  }
  const entities = next.entities.map((item) =>
    item.id === entityId && item.kind === "spline"
      ? {
          ...item,
          through: newIds,
          mode: "cv" as const,
          degree: inserted.degree,
          ...(inserted.knots ? { knots: [...inserted.knots] } : {}),
          ...(inserted.mults ? { mults: [...inserted.mults] } : {}),
          ...(inserted.weights ? { weights: [...inserted.weights] } : {}),
        }
      : item,
  );
  return prunePoints({ ...next, entities });
}

/** Turns an interior knot / Greville parameter into a sharp C0 crease (multiplicity = degree) on a CV NURBS entity. */
export function creaseSplineAt(sketch: SketchData, entityId: number, controlIndex: number): SketchData {
  const entity = sketchEntity(sketch, entityId);
  if (!entity || entity.kind !== "spline") return sketch;
  const poles: Pt[] = [];
  for (const id of entity.through) {
    const pt = sketchPoint(sketch, id);
    if (!pt) return sketch;
    poles.push(pt.at);
  }
  if (poles.length < 3 || controlIndex <= 0 || controlIndex >= poles.length - 1) return sketch;
  const norm = resolveCurveKnots(poles.length, entity.degree ?? 3, entity.knots, entity.mults, false);
  // Greville abscissa for controlIndex: average of p knots flat[i+1..i+p].
  let u = 0;
  for (let j = 1; j <= norm.degree; j += 1) u += norm.flat[controlIndex + j]!;
  u /= norm.degree;
  const creased = makeCreaseAtParam2D(
    { poles, weights: entity.weights, degree: norm.degree, knots: norm.knots, mults: norm.mults },
    u,
  );
  let next = sketch;
  const newIds: number[] = [];
  const firstId = entity.through[0]!;
  const lastId = entity.through[entity.through.length - 1]!;
  for (let i = 0; i < creased.poles.length; i += 1) {
    if (i === 0) newIds.push(firstId);
    else if (i === creased.poles.length - 1) newIds.push(lastId);
    else {
      const added = addPoint(next, creased.poles[i]!);
      next = added.sketch;
      newIds.push(added.id);
    }
  }
  const entities = next.entities.map((item) =>
    item.id === entityId && item.kind === "spline"
      ? {
          ...item,
          through: newIds,
          mode: "cv" as const,
          degree: creased.degree,
          ...(creased.knots ? { knots: [...creased.knots] } : {}),
          ...(creased.mults ? { mults: [...creased.mults] } : {}),
          ...(creased.weights ? { weights: [...creased.weights] } : {}),
        }
      : item,
  );
  return prunePoints({ ...next, entities });
}

/** Drops points no entity names. Fixed points stay, so a datum the user pinned is not lost. */
export function prunePoints(sketch: SketchData): SketchData {
  const used = new Set<number>();
  for (const entity of sketch.entities) {
    if (entity.kind === "line" || entity.kind === "arc") {
      used.add(entity.a);
      used.add(entity.b);
    } else if (entity.kind === "circle") used.add(entity.centre);
    else for (const id of entity.through) used.add(id);
  }
  const points = sketch.points.filter((point) => used.has(point.id) || point.fixed === true);
  if (points.length === sketch.points.length) return sketch;
  return { ...sketch, points };
}

/** The sketch as JSON, the same fields it already holds. */
export function sketchJson(sketch: SketchData): SketchData {
  return JSON.parse(JSON.stringify(sketch)) as SketchData;
}

/**
 * Reads a sketch from JSON. Returns null when the value is not a version-1 sketch: a bad plane,
 * a point that is not a pair of numbers, or an entity that names a point the sketch does not have.
 * Dimensions are kept as stored.
 */
export function readSketch(value: unknown): SketchData | null {
  if (!isRecord(value) || value.v !== 1) return null;
  const plane = readPlane(value.plane);
  if (!plane) return null;
  const on = value.on === undefined ? undefined : readOn(value.on);
  if (value.on !== undefined && !on) return null;
  if (!Array.isArray(value.points) || !Array.isArray(value.entities)) return null;

  const points: SketchPoint[] = [];
  const pointIds = new Set<number>();
  for (const raw of value.points) {
    const point = readPoint(raw);
    if (!point || pointIds.has(point.id)) return null;
    pointIds.add(point.id);
    points.push(point);
  }

  const entities: SketchEntity[] = [];
  const entityIds = new Set<number>();
  for (const raw of value.entities) {
    const entity = readEntity(raw, pointIds);
    if (!entity || entityIds.has(entity.id)) return null;
    entityIds.add(entity.id);
    entities.push(entity);
  }

  let dims: Dimension[] | undefined;
  if (value.dims !== undefined) {
    if (!Array.isArray(value.dims)) return null;
    dims = [];
    for (const raw of value.dims) {
      if (!isRecord(raw) || !isId(raw.id)) return null;
      dims.push({ ...raw, id: raw.id });
    }
  }

  const sketch: SketchData = { v: 1, plane, points, entities };
  if (on) sketch.on = on;
  if (dims) sketch.dims = dims;
  if (typeof value.name === "string" && value.name.trim()) sketch.name = value.name.trim();
  return sketch;
}

function clonePlane(plane: SketchPlane): SketchPlane {
  return { origin: [plane.origin[0], plane.origin[1], plane.origin[2]], turn: [plane.turn[0], plane.turn[1], plane.turn[2]] };
}

function cloneOn(on: SketchOn): SketchOn {
  if (on.kind === "face") {
    return { kind: "face", face: { index: on.face.index, mid: [...on.face.mid], areaMm2: on.face.areaMm2 } };
  }
  if (on.kind === "plane") return { kind: "plane", name: on.name };
  return { kind: "workplane" };
}

function readPlane(value: unknown): SketchPlane | null {
  if (!isRecord(value)) return null;
  const origin = readVec3(value.origin);
  const turn = readVec3(value.turn);
  if (!origin || !turn) return null;
  return { origin, turn };
}

function readOn(value: unknown): SketchOn | null {
  if (!isRecord(value)) return null;
  if (value.kind === "workplane") return { kind: "workplane" };
  if (value.kind === "plane" && (value.name === "XY" || value.name === "XZ" || value.name === "YZ")) {
    return { kind: "plane", name: value.name };
  }
  if (value.kind === "face" && isRecord(value.face)) {
    const mid = readVec3(value.face.mid);
    if (!mid || !isId(value.face.index) || typeof value.face.areaMm2 !== "number" || !Number.isFinite(value.face.areaMm2)) return null;
    return { kind: "face", face: { index: value.face.index, mid, areaMm2: value.face.areaMm2 } };
  }
  return null;
}

function readPoint(value: unknown): SketchPoint | null {
  if (!isRecord(value) || !isId(value.id)) return null;
  const at = readPt(value.at);
  if (!at) return null;
  const point: SketchPoint = { id: value.id, at };
  if (value.fixed === true) point.fixed = true;
  else if (value.fixed !== undefined) return null;
  return point;
}

function readEntity(value: unknown, points: Set<number>): SketchEntity | null {
  if (!isRecord(value) || !isId(value.id)) return null;
  const construction = value.construction === true ? true : value.construction === undefined ? false : null;
  if (construction === null) return null;
  const mark = (entity: SketchEntity): SketchEntity | null => {
    if (construction) entity.construction = true;
    return entity;
  };
  if (value.kind === "line") {
    if (!points.has(value.a as number) || !points.has(value.b as number)) return null;
    if (!isId(value.a) || !isId(value.b)) return null;
    return mark({ id: value.id, kind: "line", a: value.a, b: value.b });
  }
  if (value.kind === "arc") {
    if (!isId(value.a) || !isId(value.b) || !points.has(value.a) || !points.has(value.b)) return null;
    const through = readPt(value.through);
    if (!through) return null;
    return mark({ id: value.id, kind: "arc", a: value.a, b: value.b, through });
  }
  if (value.kind === "circle") {
    if (!isId(value.centre) || !points.has(value.centre)) return null;
    if (typeof value.radius !== "number" || !Number.isFinite(value.radius) || !(value.radius > 0)) return null;
    return mark({ id: value.id, kind: "circle", centre: value.centre, radius: value.radius });
  }
  if (value.kind === "spline") {
    if (!Array.isArray(value.through) || value.through.length < 2) return null;
    const through: number[] = [];
    for (const id of value.through) {
      if (!isId(id) || !points.has(id)) return null;
      through.push(id);
    }
    const mode = value.mode === undefined ? undefined : value.mode === "cv" || value.mode === "through" ? value.mode : null;
    if (mode === null) return null;
    let weights: number[] | undefined;
    if (value.weights !== undefined) {
      if (!Array.isArray(value.weights) || value.weights.length !== through.length || value.weights.some((w) => typeof w !== "number" || !Number.isFinite(w) || !(w > 0))) return null;
      weights = [...value.weights];
    }
    let degree: number | undefined;
    if (value.degree !== undefined) {
      if (typeof value.degree !== "number" || !Number.isInteger(value.degree) || value.degree < 1 || value.degree > 10) return null;
      degree = value.degree;
    }
    let knots: number[] | undefined;
    if (value.knots !== undefined) {
      if (!Array.isArray(value.knots) || value.knots.some((k) => typeof k !== "number" || !Number.isFinite(k))) return null;
      knots = [...value.knots];
    }
    let mults: number[] | undefined;
    if (value.mults !== undefined) {
      if (!Array.isArray(value.mults) || value.mults.some((m) => typeof m !== "number" || !Number.isInteger(m) || m < 1)) return null;
      mults = [...value.mults];
    }
    return mark({
      id: value.id,
      kind: "spline",
      through,
      ...(mode ? { mode } : {}),
      ...(weights ? { weights } : {}),
      ...(degree !== undefined ? { degree } : {}),
      ...(knots ? { knots } : {}),
      ...(mults ? { mults } : {}),
    });
  }
  return null;
}

function readPt(value: unknown): Pt | null {
  if (!Array.isArray(value) || value.length !== 2) return null;
  if (typeof value[0] !== "number" || typeof value[1] !== "number") return null;
  if (!Number.isFinite(value[0]) || !Number.isFinite(value[1])) return null;
  return [value[0], value[1]];
}

function readVec3(value: unknown): Vec3 | null {
  if (!Array.isArray(value) || value.length !== 3) return null;
  if (!value.every((item) => typeof item === "number" && Number.isFinite(item))) return null;
  return [value[0] as number, value[1] as number, value[2] as number];
}

function isId(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
