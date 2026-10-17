/**
 * Composite Model edits for the MCP server: a pattern, a mirror, a pocket or boss on a face, a grooved texture. Each
 * one expands into plain Boolean steps with a primitive, in the part's frame, which the session then probes and
 * applies one by one like any other edit. Nothing here calls the modeler.
 */
import { eulerOrient, matMul, orientEuler, type Mat3 } from "../src/mesh-place.ts";
import { isPrimitiveKind, primitiveSpec, turnCentre, type PrimitiveFields, type PrimitiveKind, type PrimitiveSpec } from "../src/model-primitive.ts";
import { framePose, planePrimitive, planePoint, type Workplane } from "../src/workplane.ts";

type Vec3 = [number, number, number];
export type BooleanKind = "cut" | "fuse" | "common";

/** One Boolean step a composite edit becomes, in the part's frame. */
export interface Piece {
  op: BooleanKind;
  spec: PrimitiveSpec;
}

/** The kinds that expand. A plain `boolean` is a piece of one. */
export const COMPOSITE_KINDS = ["pattern", "mirror", "pocket", "boss", "texture"] as const;
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
  if (!!linear === !!polar) return { reason: "A pattern needs linear or polar, one of them." };
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
  const count = Math.round(numOr(polar!.count, 0));
  if (count < 1) return { reason: "A pattern count is at least 1." };
  const axis = unit(planeVector(plane, readVec3(polar!.axis, [0, 0, 1])));
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
}

/** What expanding needs from the session: the plane an op is typed in, and a face's frame and extent by index. */
export interface ExpandContext {
  plane: Workplane;
  face(index: number): { plane: Workplane; extent: FaceExtent } | { reason: string };
  /** The flat face a selector names: {normal, withinDeg, nearPoint}. Read when the op expands, so faces earlier steps made count. */
  faceBy(selector: Record<string, unknown>): number | { reason: string };
}

function boxIn(plane: Workplane, origin: Vec3, size: Vec3): PrimitiveSpec {
  return planePrimitive({ primitive: "box", origin, size, radius: 0, height: 0, turn: [0, 0, 0] }, plane);
}

function cylinderIn(plane: Workplane, base: Vec3, radius: number, height: number): PrimitiveSpec {
  return planePrimitive({ primitive: "cylinder", origin: base, size: [0, 0, 0], radius, height, turn: [0, 0, 0] }, plane);
}

function faceFrame(spec: Record<string, unknown>, ctx: ExpandContext): { plane: Workplane; extent: FaceExtent | null } | { reason: string } {
  if (spec.face !== undefined && spec.faceIndex !== undefined) return { reason: "Give face or faceIndex, not both." };
  if (spec.face !== undefined) {
    const index = ctx.faceBy((spec.face ?? {}) as Record<string, unknown>);
    return typeof index === "number" ? ctx.face(index) : index;
  }
  if (spec.faceIndex === undefined) return { plane: ctx.plane, extent: null };
  return ctx.face(Math.round(numOr(spec.faceIndex, -1)));
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
  const u = numOr(at.u, 0);
  const v = numOr(at.v, 0);
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
  const frame = faceFrame(spec, ctx);
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

function isStill(motion: Motion): boolean {
  return !motion.reflect && motion.t.every((value) => value === 0) && motion.m.every((value, i) => value === (i % 4 === 0 ? 1 : 0));
}
