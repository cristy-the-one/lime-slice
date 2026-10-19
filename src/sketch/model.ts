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

export type SketchEntity =
  | { id: number; kind: "line"; a: number; b: number; construction?: true }
  | { id: number; kind: "arc"; a: number; b: number; through: Pt; construction?: true }
  | { id: number; kind: "circle"; centre: number; radius: number; construction?: true }
  | { id: number; kind: "spline"; through: number[]; construction?: true };

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
    return mark({ id: value.id, kind: "spline", through });
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
