/**
 * Composite Model edits for the MCP server: a pattern, a mirror, a pocket or boss on a face, a grooved texture. Each
 * one expands into plain Boolean steps with a primitive, in the part's frame, which the session then probes and
 * applies one by one like any other edit. Nothing here calls the modeler.
 */
import { eulerOrient, matMul, orientEuler, type Mat3 } from "../src/mesh-place.ts";
import { isPrimitiveKind, primitiveSpec, turnCentre, type PrimitiveFields, type PrimitiveKind, type PrimitiveSpec } from "../src/model-primitive.ts";
import { framePose, planePrimitive, planePoint, type Workplane } from "../src/workplane.ts";
import { pathSamples } from "./sweep.ts";
import { textStrokes } from "./text.ts";

type Vec3 = [number, number, number];
export type BooleanKind = "cut" | "fuse" | "common";

/** One Boolean step a composite edit becomes, in the part's frame. */
export interface Piece {
  op: BooleanKind;
  spec: PrimitiveSpec;
}

/** The kinds that expand. A plain `boolean` is a piece of one. */
export const COMPOSITE_KINDS = ["pattern", "mirror", "pocket", "boss", "texture", "array", "ribs", "text"] as const;
export type CompositeKind = (typeof COMPOSITE_KINDS)[number];

export function isComposite(kind: unknown): kind is CompositeKind {
  return typeof kind === "string" && (COMPOSITE_KINDS as readonly string[]).includes(kind);
}

/** The most steps one composite edit or one batch may become. */
export const MAX_PIECES = 400;

/** Gap left past a face so a cut leaves it cleanly, and depth a boss sinks in so it fuses, mm. */
const CUT_PAST = 1;
const BOSS_SINK = 0.2;

export function numOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function readVec3(value: unknown, fallback: Vec3): Vec3 {
  if (!Array.isArray(value) || value.length < 3) return fallback;
  const xyz = value.slice(0, 3);
  if (!xyz.every((item) => typeof item === "number" && Number.isFinite(item))) return fallback;
  return [xyz[0] as number, xyz[1] as number, xyz[2] as number];
}

/**
 * A primitive from tool fields: dx, dy, dz, radius, height and the newer kinds' fields, placed by `origin` (its
 * corner for a box or wedge, its base centre for a round kind) or by `centre` (the point it turns about: a box's
 * middle, halfway up a round kind's axis, a sphere's centre). `rootSpec` and `planePrimitive` place it.
 */
export function primitiveFrom(input: Record<string, unknown>, fallback: PrimitiveKind = "box"): PrimitiveSpec | { reason: string } {
  const kind = isPrimitiveKind(input.primitive) ? input.primitive : fallback;
  const dx = numOr(input.dx, 20);
  const dy = numOr(input.dy, dx);
  const dz = numOr(input.dz, kind === "sphere" ? dx : 20);
  const fields: PrimitiveFields = {
    size: [dx, dy, dz],
    radius: numOr(input.radius, dx / 2),
    height: numOr(input.height, dz),
    topRadius: numOr(input.topRadius, 0),
    tubeRadius: numOr(input.tubeRadius, Math.max(0.2, dx / 4)),
    innerRadius: numOr(input.innerRadius, 0),
    topX: numOr(input.topX, dx / 2),
    sides: Math.round(numOr(input.sides, 6)),
    across: numOr(input.across, dx),
    flats: input.flats === true,
  };
  if (kind === "polygon" && (fields.sides < 3 || fields.sides > 64)) return { reason: "A polygon has from 3 to 64 sides." };
  if (kind === "tube" && fields.innerRadius >= fields.radius) return { reason: "The tube's hole must be smaller than its outside." };
  if (kind === "cone" && fields.topRadius > fields.radius) return { reason: "The cone's top must be no wider than its base." };
  if (input.origin !== undefined && input.centre !== undefined) return { reason: "Give origin or centre, not both." };
  const spec = primitiveSpec(kind, fields, readVec3(input.origin, [0, 0, 0]), readVec3(input.turn, [0, 0, 0]));
  if (input.centre === undefined) return spec;
  const centre = readVec3(input.centre, [0, 0, 0]);
  const mid = turnCentre(spec);
  return { ...spec, origin: [centre[0] - mid[0], centre[1] - mid[1], centre[2] - mid[2]] };
}

/** Which fields each kind reads, so an echo shows those and not the panel's leftovers. */
const READS: Record<PrimitiveKind, readonly string[]> = {
  box: ["size"],
  wedge: ["size", "topX"],
  cylinder: ["radius", "height"],
  cone: ["radius", "height", "topRadius"],
  tube: ["radius", "height", "innerRadius"],
  sphere: ["radius"],
  torus: ["radius", "tubeRadius"],
  polygon: ["height", "sides", "across", "flats"],
};

/** An op as a caller reads it back: a primitive keeps only the fields its kind reads. */
export function cleanOp<T extends Record<string, unknown>>(op: T): Record<string, unknown> {
  if ((op.kind !== "boolean" && op.kind !== "root") || !isPrimitiveKind(op.primitive)) return op;
  const keep = new Set(["kind", "op", "primitive", "origin", "turn", ...READS[op.primitive]]);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(op)) if (keep.has(key)) out[key] = value;
  return out;
}

function mulVec(m: Mat3, v: readonly number[]): Vec3 {
  return [m[0] * v[0]! + m[1] * v[1]! + m[2] * v[2]!, m[3] * v[0]! + m[4] * v[1]! + m[5] * v[2]!, m[6] * v[0]! + m[7] * v[1]! + m[8] * v[2]!];
}

function unit(v: Vec3): Vec3 | null {
  const length = Math.hypot(v[0], v[1], v[2]);
  return length > 1e-9 ? [v[0] / length, v[1] / length, v[2] / length] : null;
}

/** A turn of `deg` degrees about `axis` (Rodrigues). */
function axisTurn(axis: Vec3, deg: number): Mat3 {
  const [x, y, z] = axis;
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const k = 1 - c;
  return [
    c + x * x * k, x * y * k - z * s, x * z * k + y * s,
    y * x * k + z * s, c + y * y * k, y * z * k - x * s,
    z * x * k - y * s, z * y * k + x * s, c + z * z * k,
  ];
}

/** A rigid move or a reflection, p → m·p + t. */
interface Motion {
  m: Mat3;
  t: Vec3;
  reflect: boolean;
}

/**
 * The local flip that keeps each kind's shape, so a reflected primitive is the same primitive turned. A wedge is not
 * symmetric in a way this can rely on, so it is refused.
 */
const LOCAL_FLIP: Partial<Record<PrimitiveKind, Mat3>> = {
  box: [-1, 0, 0, 0, 1, 0, 0, 0, 1],
  cylinder: [-1, 0, 0, 0, 1, 0, 0, 0, 1],
  cone: [-1, 0, 0, 0, 1, 0, 0, 0, 1],
  tube: [-1, 0, 0, 0, 1, 0, 0, 0, 1],
  sphere: [-1, 0, 0, 0, 1, 0, 0, 0, 1],
  torus: [-1, 0, 0, 0, 1, 0, 0, 0, 1],
  polygon: [-1, 0, 0, 0, 1, 0, 0, 0, 1],
};

/** `spec` moved by `motion`: its centre goes through the motion and its turn takes the motion's turn. */
export function movedSpec(spec: PrimitiveSpec, motion: Motion): PrimitiveSpec | { reason: string } {
  const mid = turnCentre(spec);
  const centre: Vec3 = [spec.origin[0] + mid[0], spec.origin[1] + mid[1], spec.origin[2] + mid[2]];
  const moved = mulVec(motion.m, centre);
  const at: Vec3 = [moved[0] + motion.t[0], moved[1] + motion.t[1], moved[2] + motion.t[2]];
  let turn: Vec3 = [0, 0, 0];
  if (spec.primitive !== "sphere") {
    let r = matMul(motion.m, eulerOrient(spec.turn[0], spec.turn[1], spec.turn[2]));
    if (motion.reflect) {
      const flip = LOCAL_FLIP[spec.primitive];
      if (!flip) return { reason: `A ${spec.primitive} cannot be mirrored. Mirror works on box, cylinder, cone, tube, sphere, torus, and polygon.` };
      r = matMul(r, flip);
    }
    const euler = orientEuler(r);
    turn = [round6(euler.rx), round6(euler.ry), round6(euler.rz)];
  }
  return { ...spec, origin: [round6(at[0] - mid[0]), round6(at[1] - mid[1]), round6(at[2] - mid[2])], turn };
}

function round6(value: number): number {
  const out = Math.round(value * 1e6) / 1e6;
  return Object.is(out, -0) ? 0 : out;
}

/** A direction typed in the workplane, in the part's frame. */
function planeVector(plane: Workplane, v: Vec3): Vec3 {
  return mulVec(framePose(plane).m, v);
}

/** The motions a pattern makes, the first one the original in place. */
function patternMotions(spec: Record<string, unknown>, plane: Workplane): Motion[] | { reason: string } {
  const still: Motion = { m: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0], reflect: false };
  const linear = spec.linear as Record<string, unknown> | undefined;
  const polar = spec.polar as Record<string, unknown> | undefined;
  const path = spec.path as Record<string, unknown> | undefined;
  if ([linear, polar, path].filter(Boolean).length !== 1) return { reason: "A pattern needs one of linear, polar, or path." };
  if (path) return pathMotions(path, plane);
  if (linear) {
    const count = Math.round(numOr(linear.count, 0));
    const count2 = Math.round(numOr(linear.count2, 1));
    if (count < 1 || count2 < 1) return { reason: "A pattern count is at least 1." };
    const step = planeVector(plane, readVec3(linear.step, [0, 0, 0]));
    const step2 = planeVector(plane, readVec3(linear.step2, [0, 0, 0]));
    const out: Motion[] = [];
    for (let j = 0; j < count2; j += 1) {
      for (let i = 0; i < count; i += 1) {
        out.push({ ...still, t: [step[0] * i + step2[0] * j, step[1] * i + step2[1] * j, step[2] * i + step2[2] * j] });
      }
    }
    return out;
  }
  if (!polar) return { reason: "A pattern needs linear, polar, or path." };
  const count = Math.round(numOr(polar.count, 0));
  if (count < 1) return { reason: "A pattern count is at least 1." };
  const axis = unit(planeVector(plane, readVec3(polar.axis, [0, 0, 1])));
  if (!axis) return { reason: "The polar axis needs a direction." };
  const centre = planePoint(plane, readVec3(polar!.centre, [0, 0, 0]));
  const total = numOr(polar!.angleDeg, 360);
  const step = Math.abs(total) >= 360 ? total / count : count > 1 ? total / (count - 1) : 0;
  const out: Motion[] = [];
  for (let i = 0; i < count; i += 1) {
    const m = axisTurn(axis, step * i);
    const turned = mulVec(m, centre);
    out.push({ m, t: [centre[0] - turned[0], centre[1] - turned[1], centre[2] - turned[2]], reflect: false });
  }
  return out;
}

/**
 * Copies along a smooth curve through `points`, evenly spaced, `count` of them. The op is typed at the first point;
 * with `align` (default true) each copy also turns as the curve does, so a scale or a fin follows a body.
 */
function pathMotions(path: Record<string, unknown>, plane: Workplane): Motion[] | { reason: string } {
  const points = (Array.isArray(path.points) ? path.points : []).map((p) => planePoint(plane, readVec3(p, [NaN, NaN, NaN])));
  const count = Math.round(numOr(path.count, 0));
  const samples = pathSamples(points as Vec3[], count, path.closed === true);
  if ("reason" in samples) return samples;
  const first = samples[0]!;
  const align = path.align !== false;
  return samples.map(({ point, tangent }) => {
    const m = align ? turnBetween(first.tangent, tangent) : ([1, 0, 0, 0, 1, 0, 0, 0, 1] as Mat3);
    const turned = mulVec(m, first.point);
    return { m, t: [point[0] - turned[0], point[1] - turned[1], point[2] - turned[2]] as Vec3, reflect: false };
  });
}

/** The smallest turn taking unit vector a onto unit vector b. */
function turnBetween(a: Vec3, b: Vec3): Mat3 {
  const c = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const axis = unit([a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]);
  if (!axis) {
    if (c > 0) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
    const side = unit(Math.abs(a[0]) < 0.9 ? [0, -a[2], a[1]] : [-a[2], 0, a[0]])!;
    return axisTurn(side, 180);
  }
  return axisTurn(axis, (Math.acos(Math.max(-1, Math.min(1, c))) * 180) / Math.PI);
}

/**
 * Lettering on a face: `text` at cap `height`, strokes `strokeWidth` wide (default 0.15 of the height), centred at
 * `at` {u, v} from where `from` puts U, V = 0, reading along U. Raised `depth` (op fuse, the default) or cut.
 */
function textPieces(spec: Record<string, unknown>, ctx: ExpandContext): Piece[] | { reason: string } {
  const frame = faceFrame(spec, ctx);
  if ("reason" in frame) return frame;
  const text = typeof spec.text === "string" ? spec.text : "";
  if (!text.trim()) return { reason: "Text needs text." };
  if ([...text].length > 80) return { reason: "Text takes at most 80 characters a step; use several." };
  const height = numOr(spec.height, 0);
  const depth = numOr(spec.depth, 0);
  if (!(height > 0) || !(depth > 0)) return { reason: "Text needs a height (the capitals') and a depth, in millimetres." };
  const width = numOr(spec.strokeWidth, height * 0.15);
  if (!(width > 0) || width > height / 2) return { reason: "strokeWidth is above 0 and at most half the height." };
  const strokes = textStrokes(text, height, width, typeof spec.spacing === "number" ? spec.spacing : undefined, spec.align === "left" ? "left" : "centre");
  if ("reason" in strokes) return strokes;
  const shift = anchorOf(spec.from, frame.extent);
  if ("reason" in shift) return shift;
  const at = (spec.at ?? {}) as { u?: unknown; v?: unknown };
  const u0 = numOr(at.u, 0) + shift[0];
  const v0 = numOr(at.v, 0) + shift[1];
  const turn = numOr(spec.angleDeg, 0);
  const op: BooleanKind = spec.op === "cut" ? "cut" : "fuse";
  const { low, tall } = cellSpan(op, depth);
  const pieces: Piece[] = strokes.map((stroke) => {
    const c = turnUV(stroke.centre, turn);
    return {
      op,
      spec: planePrimitive({ primitive: "box", origin: [u0 + c[0] - stroke.length / 2, v0 + c[1] - width / 2, low], size: [stroke.length, width, tall], radius: 0, height: 0, turn: [0, 0, stroke.angleDeg + turn] }, frame.plane),
    };
  });
  return pieces.length > MAX_PIECES ? { reason: `This text makes more than ${MAX_PIECES} strokes. Split it.` } : pieces;
}

/** The reflection a mirror makes: a plane through `origin` with `normal`, or "x", "y", "z" for the frame's planes. */
function mirrorMotion(spec: Record<string, unknown>, plane: Workplane): Motion | { reason: string } {
  const named = spec.plane;
  let normal: Vec3;
  if (named === "x" || named === "y" || named === "z") normal = named === "x" ? [1, 0, 0] : named === "y" ? [0, 1, 0] : [0, 0, 1];
  else normal = readVec3(spec.normal, [0, 0, 0]);
  const n = unit(planeVector(plane, normal));
  if (!n) return { reason: "A mirror needs plane x, y, or z, or a normal." };
  const o = planePoint(plane, readVec3(spec.origin, [0, 0, 0]));
  const m: Mat3 = [
    1 - 2 * n[0] * n[0], -2 * n[0] * n[1], -2 * n[0] * n[2],
    -2 * n[1] * n[0], 1 - 2 * n[1] * n[1], -2 * n[1] * n[2],
    -2 * n[2] * n[0], -2 * n[2] * n[1], 1 - 2 * n[2] * n[2],
  ];
  const d = 2 * (o[0] * n[0] + o[1] * n[1] + o[2] * n[2]);
  return { m, t: [d * n[0], d * n[1], d * n[2]], reflect: true };
}

/** The U and V box of one face, in a workplane on that face. */
export interface FaceExtent {
  u: [number, number];
  v: [number, number];
  /** The face's own triangles in U, V, six numbers each, so an array or ribs keep to its outline. */
  outline?: number[];
}

/** What expanding needs from the session: the plane an op is typed in, and a face's frame and extent by index. */
export interface ExpandContext {
  plane: Workplane;
  /** A face's frame and extent; with `coplanar`, the extent and outline cover every flat face in its plane. */
  face(index: number, coplanar?: boolean): { plane: Workplane; extent: FaceExtent } | { reason: string };
  /** The flat face a selector names: {normal, withinDeg, nearPoint}. Read when the op expands, so faces earlier steps made count. */
  faceBy(selector: Record<string, unknown>): number | { reason: string };
}

function boxIn(plane: Workplane, origin: Vec3, size: Vec3): PrimitiveSpec {
  return planePrimitive({ primitive: "box", origin, size, radius: 0, height: 0, turn: [0, 0, 0] }, plane);
}

function cylinderIn(plane: Workplane, base: Vec3, radius: number, height: number): PrimitiveSpec {
  return planePrimitive({ primitive: "cylinder", origin: base, size: [0, 0, 0], radius, height, turn: [0, 0, 0] }, plane);
}

export function faceFrame(spec: Record<string, unknown>, ctx: ExpandContext, coplanar = false): { plane: Workplane; extent: FaceExtent | null } | { reason: string } {
  if (spec.face !== undefined && spec.faceIndex !== undefined) return { reason: "Give face or faceIndex, not both." };
  if (spec.face !== undefined) {
    const index = ctx.faceBy((spec.face ?? {}) as Record<string, unknown>);
    return typeof index === "number" ? ctx.face(index, coplanar) : index;
  }
  if (spec.faceIndex === undefined) return { plane: ctx.plane, extent: null };
  return ctx.face(Math.round(numOr(spec.faceIndex, -1)), coplanar);
}

/**
 * A pocket cut into a face or a boss raised from it, centred at `at` {u, v} on the face (V runs up a side face):
 * rect `width` × `height`, circle `diameter`, or arch (a rect with a half-round top). A pocket may keep `bars`
 * across it, flush with the face: {vertical, horizontal, width}.
 */
function pocketPieces(spec: Record<string, unknown>, ctx: ExpandContext, raised: boolean): Piece[] | { reason: string } {
  const frame = faceFrame(spec, ctx);
  if ("reason" in frame) return frame;
  const plane = frame.plane;
  const at = (spec.at ?? {}) as { u?: unknown; v?: unknown };
  const shift = anchorOf(spec.from, frame.extent);
  if ("reason" in shift) return shift;
  const u = numOr(at.u, 0) + shift[0];
  const v = numOr(at.v, 0) + shift[1];
  const depth = numOr(spec.depth, 0);
  if (!(depth > 0)) return { reason: `A ${raised ? "boss" : "pocket"} needs a depth in millimetres.` };
  const shape = spec.shape === "circle" || spec.shape === "arch" ? spec.shape : "rect";
  const low = raised ? -BOSS_SINK : -depth;
  const tall = raised ? depth + BOSS_SINK : depth + CUT_PAST;
  const op: BooleanKind = raised ? "fuse" : "cut";
  const pieces: Piece[] = [];
  if (shape === "circle") {
    const diameter = numOr(spec.diameter, 0);
    if (!(diameter > 0)) return { reason: "A circle needs a diameter." };
    pieces.push({ op, spec: cylinderIn(plane, [u, v, low], diameter / 2, tall) });
  } else {
    const width = numOr(spec.width, 0);
    const height = numOr(spec.height, 0);
    if (!(width > 0) || !(height > 0)) return { reason: "A rect or arch needs a width and a height." };
    if (shape === "arch") {
      const r = width / 2;
      if (height < r) return { reason: "An arch must be at least half its width tall." };
      const straight = height - r;
      if (straight > 0) pieces.push({ op, spec: boxIn(plane, [u - r, v - height / 2, low], [width, straight, tall]) });
      pieces.push({ op, spec: cylinderIn(plane, [u, v - height / 2 + straight, low], r, tall) });
    } else {
      pieces.push({ op, spec: boxIn(plane, [u - width / 2, v - height / 2, low], [width, height, tall]) });
    }
  }
  const bars = spec.bars as Record<string, unknown> | undefined;
  if (bars && !raised) {
    const barWidth = numOr(bars.width, 1);
    const across = Math.round(numOr(bars.vertical, 0));
    const along = Math.round(numOr(bars.horizontal, 0));
    const width = shape === "circle" ? numOr(spec.diameter, 0) : numOr(spec.width, 0);
    const height = shape === "circle" ? numOr(spec.diameter, 0) : numOr(spec.height, 0);
    for (let i = 1; i <= across; i += 1) {
      const bu = u - width / 2 + (width * i) / (across + 1);
      pieces.push({ op: "fuse", spec: boxIn(plane, [bu - barWidth / 2, v - height / 2, -depth], [barWidth, height, depth]) });
    }
    for (let i = 1; i <= along; i += 1) {
      const bv = v - height / 2 + (height * i) / (along + 1);
      pieces.push({ op: "fuse", spec: boxIn(plane, [u - width / 2, bv - barWidth / 2, -depth], [width, barWidth, depth]) });
    }
  }
  return pieces;
}

/**
 * Grooves cut into a face: lines (along U), grid, or brick and shingle (rows along U, joints staggered by half a pitch
 * on every other row). `pitch` is [along U, along V]; `region` defaults to the face's own extent.
 */
function texturePieces(spec: Record<string, unknown>, ctx: ExpandContext): Piece[] | { reason: string } {
  const frame = faceFrame(spec, ctx, true);
  if ("reason" in frame) return frame;
  const plane = frame.plane;
  const region = spec.region as { u?: unknown; v?: unknown } | undefined;
  const ru = Array.isArray(region?.u) ? region.u as number[] : frame.extent?.u;
  const rv = Array.isArray(region?.v) ? region.v as number[] : frame.extent?.v;
  if (!ru || !rv) return { reason: "A texture needs faceIndex or a region {u, v} on the workplane." };
  const [u0, u1] = [Math.min(ru[0]!, ru[1]!), Math.max(ru[0]!, ru[1]!)];
  const [v0, v1] = [Math.min(rv[0]!, rv[1]!), Math.max(rv[0]!, rv[1]!)];
  const pitch = readPitch(spec.pitch);
  if (!pitch) return { reason: "A texture needs a pitch [u, v] in millimetres, each above 0." };
  const groove = numOr(spec.grooveWidth, 0.8);
  const depth = numOr(spec.depth, 0.6);
  if (!(groove > 0) || !(depth > 0)) return { reason: "A groove needs a width and a depth above 0." };
  const pattern = spec.pattern === "grid" || spec.pattern === "brick" || spec.pattern === "shingle" ? spec.pattern : "lines";
  const pieces: Piece[] = [];
  const cut = (origin: Vec3, size: Vec3) => pieces.push({ op: "cut", spec: boxIn(plane, origin, size) });
  const rows: number[] = [v0];
  for (let v = v0 + pitch[1]; v < v1 - groove; v += pitch[1]) rows.push(v);
  rows.push(v1);
  for (const v of rows.slice(1, -1)) cut([u0, v - groove / 2, -depth], [u1 - u0, groove, depth + CUT_PAST]);
  if (pattern === "grid") {
    for (let u = u0 + pitch[0]; u < u1 - groove; u += pitch[0]) cut([u - groove / 2, v0, -depth], [groove, v1 - v0, depth + CUT_PAST]);
  } else if (pattern === "brick" || pattern === "shingle") {
    for (let r = 0; r + 1 < rows.length; r += 1) {
      const start = u0 + (r % 2 === 0 ? pitch[0] : pitch[0] / 2);
      for (let u = start; u < u1 - groove; u += pitch[0]) cut([u - groove / 2, rows[r]!, -depth], [groove, rows[r + 1]! - rows[r]!, depth + CUT_PAST]);
    }
  }
  if (pieces.length === 0) return { reason: "This pitch leaves no grooves on that region." };
  return pieces;
}

function readPitch(value: unknown): [number, number] | null {
  const pair = typeof value === "number" ? [value, value] : Array.isArray(value) ? value : null;
  if (!pair || pair.length < 2) return null;
  const [u, v] = [Number(pair[0]), Number(pair[1])];
  return u > 0 && v > 0 ? [u, v] : null;
}

type UV = [number, number];

function turnUV(p: UV, deg: number): UV {
  if (deg === 0) return p;
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [p[0] * c - p[1] * s, p[0] * s + p[1] * c];
}

/**
 * Where U, V = 0 is for `from`: the face's centre of area (default), its min corner, or the middle of its bottom or
 * top edge. A wall that rises out of a roof below has its centre moved up; its top edge has not moved.
 */
export function anchorOf(from: unknown, extent: FaceExtent | null): [number, number] | { reason: string } {
  if (from === undefined || from === "centre") return [0, 0];
  if (!extent) return { reason: `from: ${String(from)} needs face or faceIndex.` };
  const mid = (extent.u[0] + extent.u[1]) / 2;
  if (from === "corner") return [extent.u[0], extent.v[0]];
  if (from === "bottom") return [mid, extent.v[0]];
  if (from === "top") return [mid, extent.v[1]];
  return { reason: "from is centre, corner, bottom, or top." };
}

/** A U, V box on the face: the region typed (from where `from` puts U, V = 0), else the face's extent. */
function regionOf(spec: Record<string, unknown>, extent: FaceExtent | null): { u: [number, number]; v: [number, number] } | { reason: string } | null {
  const region = spec.region as { u?: unknown; v?: unknown } | undefined;
  const shift = anchorOf(spec.from, extent);
  if ("reason" in shift) return shift;
  const ru = Array.isArray(region?.u) ? (region.u as number[]).map((u) => u + shift[0]) : extent?.u;
  const rv = Array.isArray(region?.v) ? (region.v as number[]).map((v) => v + shift[1]) : extent?.v;
  if (!ru || !rv) return null;
  return { u: [Math.min(ru[0]!, ru[1]!), Math.max(ru[0]!, ru[1]!)], v: [Math.min(rv[0]!, rv[1]!), Math.max(rv[0]!, rv[1]!)] };
}

/** Triangles, six numbers each, of the region box. */
function boxTriangles(r: { u: [number, number]; v: [number, number] }): number[] {
  const [u0, u1] = r.u;
  const [v0, v1] = r.v;
  return [u0, v0, u1, v0, u1, v1, u0, v0, u1, v1, u0, v1];
}

function inTriangles(p: UV, tris: readonly number[]): boolean {
  const eps = 1e-6;
  for (let i = 0; i + 5 < tris.length; i += 6) {
    const [ax, ay, bx, by, cx, cy] = [tris[i]!, tris[i + 1]!, tris[i + 2]!, tris[i + 3]!, tris[i + 4]!, tris[i + 5]!];
    const d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (Math.abs(d) < 1e-12) continue;
    const l1 = ((by - cy) * (p[0] - cx) + (cx - bx) * (p[1] - cy)) / d;
    const l2 = ((cy - ay) * (p[0] - cx) + (ax - cx) * (p[1] - cy)) / d;
    if (l1 >= -eps && l2 >= -eps && 1 - l1 - l2 >= -eps) return true;
  }
  return false;
}

/** Triangles turned by `deg` about the frame's origin, for a layout drawn at an angle. */
function turnTriangles(tris: readonly number[], deg: number): number[] {
  if (deg === 0) return [...tris];
  const out: number[] = [];
  for (let i = 0; i + 1 < tris.length; i += 2) out.push(...turnUV([tris[i]!, tris[i + 1]!], deg));
  return out;
}

/** Where the line b = `at` runs inside the triangles, as merged [from, to] spans of a. */
function spansOnLine(tris: readonly number[], at: number): [number, number][] {
  const b = at + 1e-7;
  const spans: [number, number][] = [];
  for (let i = 0; i + 5 < tris.length; i += 6) {
    const hits: number[] = [];
    for (let k = 0; k < 3; k += 1) {
      const [pa, pb] = [tris[i + 2 * k]!, tris[i + 2 * k + 1]!];
      const n = (k + 1) % 3;
      const [qa, qb] = [tris[i + 2 * n]!, tris[i + 2 * n + 1]!];
      if ((pb - b) * (qb - b) < 0) hits.push(pa + ((b - pb) / (qb - pb)) * (qa - pa));
    }
    if (hits.length === 2) spans.push([Math.min(hits[0]!, hits[1]!), Math.max(hits[0]!, hits[1]!)]);
  }
  spans.sort((x, y) => x[0] - y[0]);
  const merged: [number, number][] = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last && span[0] <= last[1] + 1e-4) last[1] = Math.max(last[1], span[1]);
    else merged.push([span[0], span[1]]);
  }
  return merged;
}

function intersectSpans(a: [number, number][], b: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  for (const x of a) for (const y of b) {
    const from = Math.max(x[0], y[0]);
    const to = Math.min(x[1], y[1]);
    if (to > from) out.push([from, to]);
  }
  return out.sort((x, y) => x[0] - y[0]);
}

/** The heights a raised or cut cell spans along W: a fuse sinks in a little so it joins; a cut leaves the face cleanly. */
function cellSpan(op: BooleanKind, depth: number): { low: number; tall: number } {
  return op === "fuse" ? { low: -BOSS_SINK, tall: depth + BOSS_SINK } : { low: -depth, tall: depth + CUT_PAST };
}

/** What `array` and `ribs` share: the face frame, the outline kept to, the layout's turn, and the op and depth. */
function surfaceSetup(spec: Record<string, unknown>, ctx: ExpandContext, kind: "array" | "ribs") {
  // The whole plane the face lies in: a floor that ribs split into strips is still one floor.
  const frame = faceFrame(spec, ctx, true);
  if ("reason" in frame) return frame;
  const region = regionOf(spec, frame.extent);
  if (region && "reason" in region) return region;
  if (!region) return { reason: `${kind === "array" ? "An array" : "Ribs"} need face, faceIndex, or a region {u, v} on the workplane.` };
  const depth = numOr(spec.depth, 0);
  if (!(depth > 0)) return { reason: `${kind === "array" ? "An array" : "Ribs"} need a depth: how far out of the face, or into it for a cut.` };
  const op: BooleanKind = spec.op === "cut" ? "cut" : "fuse";
  const margin = Math.max(0, numOr(spec.margin, 0));
  // Kept to: the face's own triangles when there is a face, and the region's box always.
  const keep = (p: UV) => inTriangles(p, boxTriangles(region)) && (!frame.extent?.outline || inTriangles(p, frame.extent.outline));
  return { plane: frame.plane, region, outline: frame.extent?.outline ?? null, depth, op, margin, keep };
}

/**
 * A primitive repeated over a face: `cell` (rect `width` × `height`, circle `diameter`, or polygon `sides` and
 * `across`, turned `turnDeg` in the face) laid on a grid of `pitch` [u, v], every other row moved half a pitch with
 * `stagger`, the whole grid turned `angleDeg`. A cell is placed only where it lies on the face and in the region,
 * `margin` in from their edges (`fit: "centre"` checks its centre only). Raised by `depth`, or cut `depth` deep.
 */
function arrayPieces(spec: Record<string, unknown>, ctx: ExpandContext): Piece[] | { reason: string } {
  const set = surfaceSetup(spec, ctx, "array");
  if ("reason" in set) return set;
  const cell = (spec.cell ?? {}) as Record<string, unknown>;
  const shape = cell.shape === "circle" || cell.shape === "polygon" ? cell.shape : "rect";
  const pitch = readPitch(spec.pitch);
  if (!pitch) return { reason: "An array needs a pitch [u, v] in millimetres, each above 0." };
  const angle = numOr(spec.angleDeg, 0);
  const spin = numOr(cell.turnDeg, 0);
  const m = set.margin;
  let outline: UV[] = [];
  let primitive: (u: number, v: number) => PrimitiveSpec;
  const { low, tall } = cellSpan(set.op, set.depth);
  if (shape === "circle") {
    const r = numOr(cell.diameter, 0) / 2;
    if (!(r > 0)) return { reason: "A circle cell needs a diameter." };
    outline = Array.from({ length: 12 }, (_, i) => [(r + m) * Math.cos((i * Math.PI) / 6), (r + m) * Math.sin((i * Math.PI) / 6)] as UV);
    primitive = (u, v) => cylinderIn(set.plane, [u, v, low], r, tall);
  } else if (shape === "polygon") {
    const sides = Math.round(numOr(cell.sides, 6));
    const across = numOr(cell.across, 0);
    if (sides < 3 || sides > 64 || !(across > 0)) return { reason: "A polygon cell needs 3 to 64 sides and an across in millimetres." };
    const reach = across / 2 + m;
    outline = Array.from({ length: sides }, (_, i) => {
      const a = -Math.PI / 2 - Math.PI / sides + (2 * Math.PI * i) / sides;
      return turnUV([reach * Math.cos(a), reach * Math.sin(a)], spin);
    });
    primitive = (u, v) => planePrimitive({ primitive: "polygon", origin: [u, v, low], size: [0, 0, 0], radius: 0, height: tall, turn: [0, 0, angle + spin], sides, across, flats: false }, set.plane);
  } else {
    const w = numOr(cell.width, 0);
    const h = numOr(cell.height, 0);
    if (!(w > 0) || !(h > 0)) return { reason: "A rect cell needs a width and a height." };
    outline = ([[-1, -1], [1, -1], [1, 1], [-1, 1]] as UV[]).map(([su, sv]) => turnUV([su * (w / 2 + m), sv * (h / 2 + m)], spin));
    primitive = (u, v) => planePrimitive({ primitive: "box", origin: [u - w / 2, v - h / 2, low], size: [w, h, tall], radius: 0, height: 0, turn: [0, 0, angle + spin] }, set.plane);
  }
  // The grid is drawn in a frame turned by angleDeg about the region's middle, centred there, and reaches one pitch past the region's corners.
  const mid: UV = [(set.region.u[0] + set.region.u[1]) / 2, (set.region.v[0] + set.region.v[1]) / 2];
  const reach = Math.hypot(set.region.u[1] - set.region.u[0], set.region.v[1] - set.region.v[0]) / 2 + Math.max(pitch[0], pitch[1]);
  const rows = Math.ceil(reach / pitch[1]);
  const cols = Math.ceil(reach / pitch[0]) + 1;
  const fitCentre = spec.fit === "centre";
  const pieces: Piece[] = [];
  for (let j = -rows; j <= rows; j += 1) {
    const shift = spec.stagger === true && Math.abs(j) % 2 === 1 ? pitch[0] / 2 : 0;
    for (let i = -cols; i <= cols; i += 1) {
      const local = turnUV([i * pitch[0] + shift, j * pitch[1]], angle);
      const at: UV = [mid[0] + local[0], mid[1] + local[1]];
      const fits = fitCentre ? set.keep(at) : outline.every((corner) => {
        const p = turnUV(corner, angle);
        return set.keep([at[0] + p[0], at[1] + p[1]]);
      });
      if (!fits) continue;
      pieces.push({ op: set.op, spec: primitive(at[0], at[1]) });
      if (pieces.length > MAX_PIECES) return { reason: `This array makes more than ${MAX_PIECES} cells. Use a larger pitch or a smaller region.` };
    }
  }
  if (pieces.length === 0) return { reason: "No cell fits on that face. Use a smaller cell, a smaller margin, or a finer pitch." };
  return pieces;
}

/**
 * Strips across a face: raised ribs, or grooves with op "cut". They run along U (level on a wall or a slope) or V,
 * turned `angleDeg` more, `pitch` apart or `count` of them spread evenly, `width` wide and `depth` high. Each rib is
 * cut to where it lies on the face and in the region, `margin` in from the ends, so a rib across a gable is shorter
 * toward the ridge.
 */
function ribPieces(spec: Record<string, unknown>, ctx: ExpandContext): Piece[] | { reason: string } {
  const set = surfaceSetup(spec, ctx, "ribs");
  if ("reason" in set) return set;
  const width = numOr(spec.width, 0);
  if (!(width > 0)) return { reason: "Ribs need a width in millimetres." };
  const angle = numOr(spec.angleDeg, 0) + (spec.along === "v" ? 90 : 0);
  const pitch = numOr(spec.pitch, 0);
  const count = Math.round(numOr(spec.count, 0));
  if (!(pitch > 0) && count < 1) return { reason: "Ribs need a pitch in millimetres or a count." };
  // In the turned frame ribs run along a; b steps across them. Shape and region both turn with it.
  const shapes = [turnTriangles(boxTriangles(set.region), -angle), ...(set.outline ? [turnTriangles(set.outline, -angle)] : [])];
  const all = shapes.flat();
  let b0 = Infinity;
  let b1 = -Infinity;
  for (let i = 1; i < all.length; i += 2) {
    b0 = Math.min(b0, all[i]!);
    b1 = Math.max(b1, all[i]!);
  }
  const lo = b0 + set.margin + width / 2;
  const hi = b1 - set.margin - width / 2;
  if (!(hi >= lo)) return { reason: "The face is narrower than one rib and its margin." };
  const lines: number[] = [];
  if (count >= 1) {
    for (let k = 0; k < count; k += 1) lines.push(count === 1 ? (lo + hi) / 2 : lo + ((hi - lo) * k) / (count - 1));
  } else {
    const n = Math.floor((hi - lo) / pitch) + 1;
    const start = (lo + hi) / 2 - ((n - 1) * pitch) / 2;
    for (let k = 0; k < n; k += 1) lines.push(start + k * pitch);
  }
  const { low, tall } = cellSpan(set.op, set.depth);
  const pieces: Piece[] = [];
  for (const b of lines) {
    let spans: [number, number][] | null = null;
    // A rib flush with the face's edge is on it: its sides are sampled a hair inside.
    for (const edge of [b - width / 2 + 1e-5, b, b + width / 2 - 1e-5]) {
      for (const tris of shapes) {
        const on = spansOnLine(tris, edge);
        spans = spans ? intersectSpans(spans, on) : on;
      }
    }
    for (const [from, to] of spans ?? []) {
      const a0 = from + set.margin;
      const a1 = to - set.margin;
      if (a1 - a0 < Math.max(width, 0.5)) continue;
      const centre = turnUV([(a0 + a1) / 2, b], angle);
      const length = a1 - a0;
      pieces.push({
        op: set.op,
        spec: planePrimitive({ primitive: "box", origin: [centre[0] - length / 2, centre[1] - width / 2, low], size: [length, width, tall], radius: 0, height: 0, turn: [0, 0, angle] }, set.plane),
      });
      if (pieces.length > MAX_PIECES) return { reason: `This makes more than ${MAX_PIECES} ribs. Use a larger pitch.` };
    }
  }
  if (pieces.length === 0) return { reason: "No rib fits on that face. Use a smaller margin or a narrower rib." };
  return pieces;
}

/**
 * The plain Boolean pieces an op becomes. `toPart` turns a plain boolean op (typed in the session's workplane) into
 * its part-frame primitive; composite kinds call back into this for the op they wrap.
 */
export function expand(raw: Record<string, unknown>, ctx: ExpandContext, toPart: (op: Record<string, unknown>) => Piece | { reason: string }, depth = 0): Piece[] | { reason: string } {
  if (depth > 4) return { reason: "Composite edits nest at most four deep." };
  const kind = raw.kind;
  if (kind === "boolean") {
    const piece = toPart(raw);
    return "reason" in piece ? piece : [piece];
  }
  if (kind === "pocket" || kind === "boss") return pocketPieces(raw, ctx, kind === "boss");
  if (kind === "texture") return texturePieces(raw, ctx);
  if (kind === "array") return arrayPieces(raw, ctx);
  if (kind === "ribs") return ribPieces(raw, ctx);
  if (kind === "text") return textPieces(raw, ctx);
  if (kind === "pattern" || kind === "mirror") {
    const inner = raw.op;
    if (!inner || typeof inner !== "object") return { reason: `A ${kind} needs the op it repeats.` };
    const pieces = expand(inner as Record<string, unknown>, ctx, toPart, depth + 1);
    if ("reason" in pieces) return pieces;
    let motions: Motion[];
    if (kind === "pattern") {
      const made = patternMotions(raw, ctx.plane);
      if ("reason" in made) return made;
      motions = made;
    } else {
      const made = mirrorMotion(raw, ctx.plane);
      if ("reason" in made) return made;
      motions = raw.keepOriginal === false ? [made] : [{ m: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0], reflect: false }, made];
    }
    const out: Piece[] = [];
    for (const motion of motions) {
      for (const piece of pieces) {
        const moved = isStill(motion) ? piece.spec : movedSpec(piece.spec, motion);
        if ("reason" in moved) return moved;
        out.push({ op: piece.op, spec: moved });
        if (out.length > MAX_PIECES) return { reason: `This makes more than ${MAX_PIECES} steps. Split it into smaller edits.` };
      }
    }
    return out;
  }
  return { reason: `${String(kind)} is not a composite edit.` };
}

/**
 * Whether a probe's measures say a fuse left a separate piece or a sealed hollow: a closed shell the solid did not have.
 * The kernel refuses a fuse that adds a solid; a ring around a mast can instead come back as a second shell of the same
 * solid, and a belt laid just above a lip can close a ring of air under it.
 * A shell op hollows on purpose, so only adding kinds are asked.
 */
export const SEPARATE_PIECE = "This would add a separate piece, or seal off a hollow inside the part. Move or resize it so it overlaps the part without closing a gap.";
export function addsPiece(op: { kind: string; op?: string }, measure: { shells: number; before: { shells: number } } | undefined): boolean {
  const adds = (op.kind === "boolean" || op.kind === "join" || op.kind === "extrude" || op.kind === "revolve" || op.kind === "loft") && op.op === "fuse";
  return adds && !!measure && measure.shells > measure.before.shells;
}

/**
 * Whether a cut that is one step of a composite edit split a piece off: a groove or a pocket that severs a sliver, as a
 * quilting groove can where a thigh plate comes close to the surface. A plain cut may split a part on purpose; a
 * composite's steps never should.
 */
export const SPLIT_PIECE = "This step would cut a piece off the part. Move it, or make it shallower or narrower.";
export function cutsOffPiece(op: { kind: string; op?: string }, measure: { solids: number; shells: number; before: { solids: number; shells: number } } | undefined): boolean {
  return op.kind === "boolean" && op.op === "cut" && !!measure && (measure.solids > measure.before.solids || measure.shells > measure.before.shells);
}

/** Where a refused step's sealed hollows and loose pieces are, in the part's frame: each a centre and a size. */
export interface PieceReport {
  voids: { centre: Vec3; size: Vec3 }[];
  pieces: { centre: Vec3; size: Vec3; volumeMm3: number; gapMm: number }[];
}

type Box = { min: Vec3; max: Vec3 };

/**
 * The probe's `voids` and `pieces` (boxes in the solid's frame), moved into the part's frame by `toPart`. Null when the
 * engine sent neither.
 */
export function pieceReport(reply: Record<string, unknown>, toPart: (p: Vec3) => Vec3): PieceReport | null {
  const boxOf = (row: unknown): (Box & Record<string, unknown>) | null => {
    if (!row || typeof row !== "object") return null;
    const { min, max } = row as { min?: unknown; max?: unknown };
    const ok = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === "number" && Number.isFinite(n));
    return ok(min) && ok(max) ? { ...(row as Record<string, unknown>), min, max } : null;
  };
  const placed = (box: Box) => {
    const lo: Vec3 = [Infinity, Infinity, Infinity];
    const hi: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (let corner = 0; corner < 8; corner += 1) {
      const p = toPart([corner & 1 ? box.max[0] : box.min[0], corner & 2 ? box.max[1] : box.min[1], corner & 4 ? box.max[2] : box.min[2]]);
      for (let i = 0; i < 3; i += 1) {
        lo[i] = Math.min(lo[i]!, p[i]!);
        hi[i] = Math.max(hi[i]!, p[i]!);
      }
    }
    const r = (n: number) => Math.round(n * 100) / 100;
    return { centre: lo.map((v, i) => r((v + hi[i]!) / 2)) as Vec3, size: lo.map((v, i) => r(hi[i]! - v)) as Vec3 };
  };
  const voids = (Array.isArray(reply.voids) ? reply.voids : []).map(boxOf).filter((row) => row !== null).map((row) => placed(row));
  const pieces = (Array.isArray(reply.pieces) ? reply.pieces : []).map(boxOf).filter((row) => row !== null).map((row) => ({
    ...placed(row),
    volumeMm3: Math.round(Number(row.volumeMm3) * 1000) / 1000,
    gapMm: Math.round(Number(row.gapMm) * 1000) / 1000,
  }));
  return voids.length || pieces.length ? { voids, pieces } : null;
}

const at = (p: Vec3) => `(${p.join(", ")})`;
const across = (s: Vec3) => `${s.join(" × ")} mm`;

/** SEPARATE_PIECE, said with where the piece or the hollow is and how far to move. */
export function separateReason(report: PieceReport | null): string {
  const piece = report?.pieces[0];
  if (piece && piece.gapMm > 0.001) {
    return `This would add a separate piece ${piece.gapMm} mm from the part, centred at ${at(piece.centre)}, ${across(piece.size)}. Move it at least ${Math.round((piece.gapMm + 0.2) * 100) / 100} mm toward the part so the two overlap.`;
  }
  if (piece) return `This would add a piece that only touches the part at an edge or a point, centred at ${at(piece.centre)}, ${across(piece.size)}. Push it further in so it overlaps the part.`;
  const hollow = report?.voids[0];
  if (hollow) {
    const more = report!.voids.length > 1 ? ` (and ${report!.voids.length - 1} more)` : "";
    return `This would seal off a hollow inside the part at ${at(hollow.centre)}, about ${across(hollow.size)}${more}. Move or resize this step so it overlaps the part without closing that gap, or first fill the gap with a step that overlaps both sides.`;
  }
  return SEPARATE_PIECE;
}

/** SPLIT_PIECE, said with where the severed piece is. */
export function splitReason(report: PieceReport | null): string {
  const piece = report?.pieces[0];
  if (piece) return `This step would cut off a ${across(piece.size)} piece at ${at(piece.centre)}. Move the step, or make it shallower or narrower there.`;
  const hollow = report?.voids[0];
  if (hollow) return `This step would leave a sealed hollow at ${at(hollow.centre)}, about ${across(hollow.size)}. Move it, or make it shallower or narrower.`;
  return SPLIT_PIECE;
}

function isStill(motion: Motion): boolean {
  return !motion.reflect && motion.t.every((value) => value === 0) && motion.m.every((value, i) => value === (i % 4 === 0 ? 1 : 0));
}
