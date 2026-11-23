/**
 * An op as a Model call types it, made into the op the history stores (docs/plan-recipe-plugins.md D16): the MCP
 * session's `model_apply` and the app's answer to a recipe's call both go through `bakeOp`, so the same typed op is the
 * same stored op whichever of them ran the recipe. The op is read in the part's typed frame (its workplane, model space
 * on a moved part) and stored in the solid's own frame.
 *
 * What only the MCP session holds (another part for a join, the plate's printer for a split to print or a print
 * transition) comes through the context's hooks; without them those kinds are refused with a sentence.
 */
import { anchorOf, cleanOp, faceFrame, isComposite, primitiveFrom, readVec3, type ExpandContext } from "./compose.ts";
import { edgesMatching } from "./selectors.ts";
import { typedView } from "./typed-view.ts";
import type { EdgeRow, FaceRow } from "./solid-geometry.ts";
import { sweepSections, type SweepSpec } from "./sweep.ts";
import { throughLength, SCREWS } from "../model-hole.ts";
import { gearOf, rootSpec } from "../model-primitive.ts";
import { gearRefusal } from "../model-gear.ts";
import { blendSurfaceOp, draftOp, extrudeOp, faceExtrudeOp, loftOp, moveFacesOp, patchOp, replaceFaceOp, revolveOp, sewOp, sheetOp, shellOp, splitFaceOp, stepEdges, sweepOp, thickenOp, trimSplitOp, type ProfileShape } from "../model-request.ts";
import { toSolidOp, turnDir, type Affine } from "../model-space.ts";
import { formatMm } from "../model-plane.ts";
import { transitionAngleLimit, transitionBuild, transitionFloorMm, TRANSITION_MAX_DEG, TRANSITION_SIZE_MM } from "../model-transition.ts";
import type { BeltSettings } from "../belt.ts";
import type { Curve3D, Curve3DSegment, DraftNeutral, EdgePick, FilletContinuity, LoftBoundary, LoftSection, ModelOp, ProfileLoop, ProfileSegment, SheetSpec, SurfaceBoundary, SurfaceContinuity, SweepMode, SweepTransition, ThickenDirection, TrimKeep, Vec2, Vec3 } from "../model-tree.ts";
import { drillDown, isGlobalFrame, planePoint, planePrimitive, type Workplane } from "../workplane.ts";

/** A baked op: as stored, as typed with its defaults filled, and any notes. */
export interface Baked {
  op: ModelOp;
  typed: Record<string, unknown>;
  notes?: string[];
}

/** What baking an op reads of the part it is for. */
export interface BakeContext {
  /** The part's typed pose: ops are typed in model space and stored in the solid's frame. */
  pose: Affine;
  /** The shown solid, in its own frame: its faces and edges as rows, its mesh and box. */
  solid: {
    faces: readonly FaceRow[];
    edges: readonly EdgeRow[];
    positions: ArrayLike<number>;
    triangles: ArrayLike<number>;
    bounds: { min: [number, number, number]; max: [number, number, number] };
  } | null;
  /** The workplane in model space, where ops are typed. */
  plane: Workplane;
  /** Faces as composite ops and selectors read them. */
  expand(): ExpandContext;
  /** A step named by a handle (`node_4`) or a label; null when there is none. */
  nodeOf(value: unknown): number | null;
  hasNode(id: number): boolean;
  join?(spec: Record<string, unknown>): Baked | { reason: string };
  partition?(spec: Record<string, unknown>): Baked | { reason: string };
  transition?(spec: Record<string, unknown>): Baked | { reason: string };
}

/** The refusal for a kind only the MCP session bakes. */
function outsideSession(what: string): string {
  return `${what} is made over MCP; a plugin rebuilt in the app cannot make one yet.`;
}

/** An edge filter whose onFace is a face selector {normal, withinDeg, nearPoint}, with that face's index in its place. */
export function onFaceIndex(filter: Record<string, unknown>, ctx: BakeContext): Record<string, unknown> | string {
  const on = filter.onFace;
  if (!on || typeof on !== "object" || Array.isArray(on)) return filter;
  const index = ctx.expand().faceBy(on as Record<string, unknown>);
  if (typeof index !== "number") return `onFace: ${index.reason}`;
  return { ...filter, onFace: index };
}

/** Indexes from a list, or from the same filter `edges_find` uses. */
export function resolveEdges(spec: Record<string, unknown>, ctx: BakeContext): EdgePick[] | { reason: string } {
  const raw = spec.edges;
  const empty = spec.kind === "chamfer" ? "Pick an edge to chamfer." : spec.kind === "transition" ? "Pick an edge for the print transition." : "Pick an edge to fillet.";
  if (raw && typeof raw === "object" && "fromNode" in raw) {
    const { fromNode, filter } = raw as { fromNode?: unknown; filter?: unknown };
    const node = ctx.nodeOf(fromNode);
    if (node === null || !ctx.hasNode(node)) return { reason: "That step is not in the history." };
    if (node === 0) return { reason: "Pick a step after the first solid. Its edges are not a step's own." };
    return [stepEdges(node, filter === "convex" || filter === "concave" ? filter : "all")];
  }
  if (Array.isArray(raw)) {
    if (raw.length === 0) return { reason: empty };
    if (!raw.every((edge) => Number.isInteger(edge))) return { reason: EDGES_SHAPE };
    return raw as number[];
  }
  if (raw && typeof raw === "object" && "select" in raw) {
    const select = (raw as { select?: unknown }).select;
    if (!select || typeof select !== "object" || Array.isArray(select)) return { reason: "edges.select is a filter." };
    if (!ctx.solid) return { reason: "Describe the solid before picking edges." };
    const filter = onFaceIndex(select as Record<string, unknown>, ctx);
    if (typeof filter === "string") return { reason: filter };
    // The filter's direction and points are typed, as edges_find reads them: in the frame ops are typed in.
    const typed = typedView(ctx.solid, ctx.pose);
    const matched = edgesMatching(typed.edges, typed.faces, filter, typed);
    if ("reason" in matched) return matched;
    if (matched.length === 0) return { reason: "No edge matches that filter." };
    return matched.map((edge) => edge.index);
  }
  return { reason: empty };
}

/** K4. A face as a shell's open face: an index, a stored `{index}`, or a `{normal, nearPoint}` selector. */
export function bakedFace(pick: unknown, ctx: BakeContext): number | { reason: string } {
  if (Number.isInteger(pick)) {
    if (!ctx.solid?.faces[pick as number]) return { reason: "That face is not on this solid." };
    return pick as number;
  }
  if (pick && typeof pick === "object" && Number.isInteger((pick as { index?: unknown }).index)) {
    const index = (pick as { index: number }).index;
    if (!ctx.solid?.faces[index]) return { reason: "That face is not on this solid." };
    return index;
  }
  const found = ctx.expand().faceBy((pick ?? {}) as Record<string, unknown>);
  if (typeof found !== "number") return found;
  return found;
}

/**
 * The plane a profile is drawn on: origin and turn as given, else a face (face or faceIndex, with from: corner putting
 * U, V = 0 at the face's min corner), else the object's workplane.
 */
export function profilePlane(spec: Record<string, unknown>, ctx: BakeContext): { origin: [number, number, number]; turn: [number, number, number] } | { reason: string } {
  if (spec.origin !== undefined || spec.turn !== undefined) return { origin: readVec3(spec.origin, [0, 0, 0]), turn: readVec3(spec.turn, [0, 0, 0]) };
  if (spec.face === undefined && spec.faceIndex === undefined) {
    const plane = ctx.plane;
    return { origin: [...plane.origin], turn: [...plane.turn] };
  }
  const frame = faceFrame(spec, ctx.expand());
  if ("reason" in frame) return frame;
  const shift = anchorOf(spec.from, frame.extent);
  if ("reason" in shift) return shift;
  return { origin: planePoint(frame.plane, [shift[0], shift[1], 0]), turn: [...frame.plane.turn] };
}

export const EDGES_SHAPE = "edges is a list of edge indexes, [3, 7], or one pick object: {fromNode: \"node_4\", filter: \"convex\"} or {select: {direction, onFace, convex}}, not inside a list.";

export const LOOP_SHAPE = "smooth and corners are for a point profile. A loop uses arc and spline segments.";

/**
 * K1 loops, when the field is present. Absent means the op uses a point profile. A bad loop is a sentence.
 */
export function readLoopsField(value: unknown): { loops?: ProfileLoop[] } | { reason: string } {
  if (value === undefined) return {};
  if (!Array.isArray(value) || value.length < 1) return { reason: "A profile needs a loop." };
  if (value.length > 1000) return { reason: "A profile takes at most 1000 loops. Split it into several extrudes, or use model_apply_batch with combine." };
  const loops: ProfileLoop[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || !Array.isArray((raw as { segments?: unknown }).segments)) return { reason: "A loop needs a start and its segments." };
    const spec = raw as Record<string, unknown>;
    const start = pairOf(spec.start);
    if (!start) return { reason: "A loop starts at [u, v]." };
    const pieces = spec.segments as unknown[];
    if (pieces.length < 1) return { reason: "A loop needs a segment." };
    if (pieces.length > 1000) return { reason: "A loop takes at most 1000 segments." };
    const segments: ProfileSegment[] = [];
    for (const seg of pieces) {
      if (!seg || typeof seg !== "object") return { reason: "A loop segment is incomplete." };
      const piece = seg as Record<string, unknown>;
      const to = pairOf(piece.to);
      if (!to) return { reason: "A loop segment ends at [u, v]." };
      if (piece.kind === "line") {
        if (piece.through !== undefined) return { reason: "A line has no point between its ends." };
        segments.push({ kind: "line", to });
      } else if (piece.kind === "arc") {
        const through = pairOf(piece.through);
        if (!through) return { reason: "An arc needs one point between its ends." };
        segments.push({ kind: "arc", through, to });
      } else if (piece.kind === "spline") {
        if (!Array.isArray(piece.through) || piece.through.length < 1) return { reason: "A spline needs a point between its ends." };
        const through: Vec2[] = [];
        for (const point of piece.through) {
          const at = pairOf(point);
          if (!at) return { reason: "A spline's points are [u, v]." };
          through.push(at);
        }
        segments.push({ kind: "spline", through, to });
      } else if (piece.kind === "nurbs") {
        let poles: Vec2[] | undefined;
        if (piece.poles !== undefined) {
          if (!Array.isArray(piece.poles) || piece.poles.length > 200) return { reason: "NURBS poles must be an array of [u, v] points." };
          poles = [];
          for (const point of piece.poles) {
            const at = pairOf(point);
            if (!at) return { reason: "NURBS poles are [u, v]." };
            poles.push(at);
          }
        }
        const meta = readNurbsMetaField(piece);
        if ("reason" in meta) return meta;
        segments.push({ kind: "nurbs", ...(poles ? { poles } : {}), ...meta, to });
      } else {
        return { reason: "A segment kind is line, arc, spline, or nurbs." };
      }
    }
    loops.push({ start, segments });
  }
  return { loops };
}

function readNurbsMetaField(piece: Record<string, unknown>): { weights?: number[]; degree?: number; knots?: number[]; mults?: number[] } | { reason: string } {
  let weights: number[] | undefined;
  if (piece.weights !== undefined) {
    if (!Array.isArray(piece.weights) || piece.weights.some((w) => typeof w !== "number" || !Number.isFinite(w) || !(w > 0))) {
      return { reason: "NURBS weights must be positive numbers." };
    }
    weights = [...piece.weights];
  }
  let degree: number | undefined;
  if (piece.degree !== undefined) {
    if (typeof piece.degree !== "number" || !Number.isInteger(piece.degree) || piece.degree < 1 || piece.degree > 10) {
      return { reason: "NURBS degree must be an integer from 1 to 10." };
    }
    degree = piece.degree;
  }
  let knots: number[] | undefined;
  if (piece.knots !== undefined) {
    if (!Array.isArray(piece.knots) || piece.knots.some((k) => typeof k !== "number" || !Number.isFinite(k))) {
      return { reason: "NURBS knots must be numbers." };
    }
    knots = [...piece.knots];
  }
  let mults: number[] | undefined;
  if (piece.mults !== undefined) {
    if (!Array.isArray(piece.mults) || piece.mults.some((m) => typeof m !== "number" || !Number.isInteger(m) || m < 1)) {
      return { reason: "NURBS mults must be positive integers." };
    }
    mults = [...piece.mults];
  }
  return { ...(weights ? { weights } : {}), ...(degree !== undefined ? { degree } : {}), ...(knots ? { knots } : {}), ...(mults ? { mults } : {}) };
}

function vec3Of(value: unknown): Vec3 | null {
  if (!Array.isArray(value) || value.length !== 3 || !value.every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  return [value[0] as number, value[1] as number, value[2] as number];
}

function readContinuityField(value: unknown, what: string): SurfaceContinuity | undefined | { reason: string } {
  if (value === undefined) return undefined;
  if (value === "g0" || value === "g1" || value === "g2") return value;
  return { reason: `${what} continuity is g0, g1, or g2.` };
}

function readTension(value: unknown, side: string): number | undefined | { reason: string } {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0.15 || value > 4) {
    return { reason: `${side} tension is from 0.15 to 4.` };
  }
  return value;
}

function readBoundaryField(value: unknown, ctx: BakeContext, what: string): SurfaceBoundary | { reason: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { reason: `${what} needs a curve or an edge of the sheet.` };
  }
  const raw = value as Record<string, unknown>;
  const continuity = readContinuityField(raw.continuity, what);
  if (continuity !== undefined && typeof continuity !== "string") return continuity;
  let edges: EdgePick[] | undefined;
  if (raw.edges !== undefined) {
    const resolved = resolveEdges({ edges: raw.edges, kind: "patch" }, ctx);
    if ("reason" in resolved) {
      return { reason: resolved.reason.startsWith("Pick an edge") ? `${what} needs a curve or an edge of the sheet.` : resolved.reason };
    }
    edges = resolved;
  }
  let curve: Curve3D | undefined;
  if (raw.curve !== undefined) {
    const read = readCurve3DField(raw.curve, ctx);
    if ("reason" in read) return read;
    curve = read;
  }
  if (!edges && !curve) return { reason: `${what} needs a curve or an edge of the sheet.` };
  let face: number | undefined;
  if (raw.face !== undefined) {
    const picked = bakedFace(raw.face, ctx);
    if (typeof picked !== "number") return picked;
    face = picked;
  }
  return {
    ...(curve ? { curve } : {}),
    ...(edges ? { edges } : {}),
    ...(face !== undefined ? { face } : {}),
    ...(typeof continuity === "string" ? { continuity } : {}),
  };
}

function readBoundariesField(value: unknown, ctx: BakeContext): SurfaceBoundary[] | { reason: string } {
  if (!Array.isArray(value) || value.length < 2 || value.length > 20) {
    return { reason: "A patch needs between 2 and 20 boundary curves or edges." };
  }
  const boundaries: SurfaceBoundary[] = [];
  for (const raw of value) {
    const bound = readBoundaryField(raw, ctx, "A patch side");
    if ("reason" in bound) return bound;
    boundaries.push(bound);
  }
  return boundaries;
}

function readCurve3DField(value: unknown, ctx: BakeContext): Curve3D | { reason: string } {
  if (!value || typeof value !== "object") return { reason: "spine must be a Curve3D object." };
  const raw = value as Record<string, unknown>;
  if (raw.kind === "polyline") {
    if (!Array.isArray(raw.points) || raw.points.length < 2) return { reason: "A polyline spine needs at least 2 points." };
    const points = raw.points.map(vec3Of);
    if (points.some((p) => !p)) return { reason: "Polyline spine points are [x, y, z]." };
    return { kind: "polyline", points: points as Vec3[], ...(raw.closed === true ? { closed: true as const } : {}) };
  }
  if (raw.kind === "spline") {
    if (!Array.isArray(raw.through) || raw.through.length < 2) return { reason: "A spline spine needs at least 2 points." };
    const through = raw.through.map(vec3Of);
    if (through.some((p) => !p)) return { reason: "Spline spine points are [x, y, z]." };
    return { kind: "spline", through: through as Vec3[], ...(raw.closed === true ? { closed: true as const } : {}) };
  }
  if (raw.kind === "nurbs") {
    if (!Array.isArray(raw.poles) || raw.poles.length < 2) return { reason: "A NURBS spine needs at least 2 poles." };
    const poles = raw.poles.map(vec3Of);
    if (poles.some((p) => !p)) return { reason: "NURBS spine poles are [x, y, z]." };
    const meta = readNurbsMetaField(raw);
    if ("reason" in meta) return meta;
    return { kind: "nurbs", poles: poles as Vec3[], ...meta, ...(raw.closed === true ? { closed: true as const } : {}) };
  }
  if (raw.kind === "segments") {
    const start = vec3Of(raw.start);
    if (!start) return { reason: "A segments spine starts at [x, y, z]." };
    if (!Array.isArray(raw.segments) || raw.segments.length < 1) return { reason: "A segments spine needs at least 1 segment." };
    const segments: Curve3DSegment[] = [];
    for (const item of raw.segments) {
      if (!item || typeof item !== "object") return { reason: "A spine segment is incomplete." };
      const seg = item as Record<string, unknown>;
      const to = vec3Of(seg.to);
      if (!to) return { reason: "A spine segment ends at [x, y, z]." };
      if (seg.kind === "line") segments.push({ kind: "line", to });
      else if (seg.kind === "arc") {
        const through = vec3Of(seg.through);
        if (!through) return { reason: "An arc spine segment needs through: [x, y, z]." };
        segments.push({ kind: "arc", through, to });
      } else if (seg.kind === "spline") {
        if (!Array.isArray(seg.through) || seg.through.length < 1) return { reason: "A spline spine segment needs through points." };
        const through = seg.through.map(vec3Of);
        if (through.some((p) => !p)) return { reason: "Spline spine segment points are [x, y, z]." };
        segments.push({ kind: "spline", through: through as Vec3[], to });
      } else if (seg.kind === "nurbs") {
        let poles: Vec3[] | undefined;
        if (seg.poles !== undefined) {
          if (!Array.isArray(seg.poles)) return { reason: "NURBS spine segment poles must be [x, y, z][]." };
          const parsed = seg.poles.map(vec3Of);
          if (parsed.some((p) => !p)) return { reason: "NURBS spine segment poles are [x, y, z]." };
          poles = parsed as Vec3[];
        }
        const meta = readNurbsMetaField(seg);
        if ("reason" in meta) return meta;
        segments.push({ kind: "nurbs", ...(poles ? { poles } : {}), ...meta, to });
      } else return { reason: "Spine segment kind must be line, arc, spline, or nurbs." };
    }
    return { kind: "segments", start, segments };
  }
  if (raw.kind === "edges") {
    const picked = resolveEdges({ edges: raw.edges }, ctx);
    if ("reason" in picked) return picked;
    return { kind: "edges", edges: picked };
  }
  return { reason: "spine.kind must be polyline, spline, nurbs, segments, or edges." };
}

function readSheetSpecField(value: unknown, ctx: BakeContext): SheetSpec | { reason: string } {
  if (!value || typeof value !== "object") return { reason: "sheet specification must be an object." };
  const raw = value as Record<string, unknown>;
  const mode = raw.mode;
  if (mode !== "extrude" && mode !== "revolve" && mode !== "loft" && mode !== "planar") {
    return { reason: "sheet mode must be extrude, revolve, loft, or planar." };
  }
  if (!Array.isArray(raw.curves) || raw.curves.length < 1 || raw.curves.length > 100) {
    return { reason: "A sheet needs at least 1 3D curve." };
  }
  if (mode === "loft" && raw.curves.length < 2) {
    return { reason: "A loft sheet needs at least 2 3D curves." };
  }
  const curves: Curve3D[] = [];
  for (const [idx, item] of raw.curves.entries()) {
    const parsed = readCurve3DField(item, ctx);
    if ("reason" in parsed) return { reason: `curves[${idx}]: ${parsed.reason}` };
    curves.push(parsed);
  }
  let dir: Vec3 | undefined;
  if (raw.dir !== undefined) {
    const v = vec3Of(raw.dir);
    if (!v || Math.hypot(v[0], v[1], v[2]) < 1e-9) return { reason: "dir must be a non-zero [x, y, z] vector." };
    dir = v;
  }
  let distance: number | undefined;
  if (raw.distance !== undefined) {
    if (typeof raw.distance !== "number" || !Number.isFinite(raw.distance) || raw.distance === 0) {
      return { reason: "distance must be a non-zero finite number." };
    }
    distance = raw.distance;
  }
  let axisOrigin: Vec3 | undefined;
  if (raw.axisOrigin !== undefined) {
    const v = vec3Of(raw.axisOrigin);
    if (!v) return { reason: "axisOrigin must be [x, y, z]." };
    axisOrigin = v;
  }
  let angleDeg: number | undefined;
  if (raw.angleDeg !== undefined) {
    if (typeof raw.angleDeg !== "number" || !Number.isFinite(raw.angleDeg) || raw.angleDeg === 0) {
      return { reason: "angleDeg must be a non-zero finite number." };
    }
    angleDeg = raw.angleDeg;
  }
  if (mode === "extrude" && (!dir || distance === undefined)) {
    return { reason: "An extruded sheet needs dir and distance." };
  }
  if (mode === "revolve" && !dir) {
    return { reason: "A revolved sheet needs axis dir." };
  }
  return {
    mode,
    curves,
    ...(dir ? { dir } : {}),
    ...(distance !== undefined ? { distance } : {}),
    ...(axisOrigin ? { axisOrigin } : {}),
    ...(angleDeg !== undefined ? { angleDeg } : {}),
    ...(raw.ruled === true ? { ruled: true as const } : {}),
    ...(raw.symmetric === true ? { symmetric: true as const } : {}),
  };
}

function readSweepModeField(value: unknown, ctx: BakeContext): SweepMode | { reason: string } {
  if (!value || typeof value !== "object") return { reason: "sweep mode must be an object." };
  const raw = value as Record<string, unknown>;
  if (raw.kind === "correctedFrenet" || raw.kind === "frenet") return { kind: raw.kind };
  if (raw.kind === "fixedBinormal") {
    const dir = vec3Of(raw.dir);
    if (!dir) return { reason: "fixedBinormal needs dir: [x, y, z]." };
    return { kind: "fixedBinormal", dir };
  }
  if (raw.kind === "auxSpine") {
    const spine = readCurve3DField(raw.spine, ctx);
    if ("reason" in spine) return spine;
    return {
      kind: "auxSpine",
      spine,
      ...(typeof raw.curvilinear === "boolean" ? { curvilinear: raw.curvilinear } : {}),
      ...(typeof raw.keepContact === "boolean" ? { keepContact: raw.keepContact } : {}),
    };
  }
  return { reason: "sweep mode.kind must be correctedFrenet, frenet, fixedBinormal, or auxSpine." };
}

function pairOf(value: unknown): Vec2 | null {
  if (!Array.isArray(value) || value.length !== 2 || !value.every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  return [value[0] as number, value[1] as number];
}

/** A profile's smooth and corners fields: corners are indexes into its points, and need smooth. */
export function readShape(spec: Record<string, unknown>, points: number): ProfileShape | { reason: string } {
  if (spec.smooth !== undefined && typeof spec.smooth !== "boolean") return { reason: "smooth is true or false." };
  if (spec.corners === undefined) return { smooth: spec.smooth === true };
  if (spec.smooth !== true) return { reason: "corners mark the sharp points of a smooth profile. Add smooth: true." };
  if (!Array.isArray(spec.corners) || !spec.corners.every((c) => Number.isInteger(c) && c >= 0 && c < points)) {
    return { reason: `corners are indexes of profile points, 0 to ${points - 1}.` };
  }
  return { smooth: true, corners: [...new Set(spec.corners as number[])] };
}

function readLoftBoundaryField(value: unknown): LoftBoundary | { reason: string } {
  if (!value || typeof value !== "object") return { reason: "Loft boundary condition must be an object." };
  const raw = value as Record<string, unknown>;
  if (raw.kind === "free") return { kind: "free" };
  let tension: number | undefined;
  if (raw.tension !== undefined) {
    if (typeof raw.tension !== "number" || !Number.isFinite(raw.tension) || !(raw.tension > 0)) {
      return { reason: "Loft boundary tension must be a positive number." };
    }
    tension = raw.tension;
  }
  if (raw.kind === "normal") return { kind: "normal", ...(tension !== undefined ? { tension } : {}) };
  if (raw.kind === "tangent") {
    const dir = vec3Of(raw.dir);
    if (!dir || Math.hypot(...dir) < 1e-9) return { reason: "Loft tangent boundary needs a non-zero dir [x, y, z]." };
    return { kind: "tangent", dir, ...(tension !== undefined ? { tension } : {}) };
  }
  if (raw.kind === "curvature") {
    let dir: Vec3 | undefined;
    if (raw.dir !== undefined) {
      const parsed = vec3Of(raw.dir);
      if (!parsed || Math.hypot(...parsed) < 1e-9) return { reason: "Loft curvature dir must be a non-zero [x, y, z] vector." };
      dir = parsed;
    }
    return { kind: "curvature", ...(dir ? { dir } : {}), ...(tension !== undefined ? { tension } : {}) };
  }
  return { reason: "Loft boundary kind must be free, normal, tangent, or curvature." };
}

/** One loft section: origin and turn as a profile's plane, then a radius (radiusV for an ellipse) or a profile, or an apex point cap. */
export function readSection(value: unknown): LoftSection | { reason: string } {
  if (!value || typeof value !== "object") return { reason: "A section is an object with origin and a radius or a profile." };
  const spec = value as Record<string, unknown>;
  if (spec.apex !== undefined) {
    const apex = vec3Of(spec.apex);
    if (!apex) return { reason: "A point apex section needs apex: [x, y, z]." };
    return { origin: [...apex] as Vec3, turn: [0, 0, 0], apex };
  }
  const origin = readVec3(spec.origin, [NaN, NaN, NaN]);
  if (origin.some((n) => !Number.isFinite(n))) return { reason: "A section needs an origin [x, y, z]." };
  const turn = readVec3(spec.turn, [0, 0, 0]);
  const loops = readLoopsField(spec.loops);
  if ("reason" in loops) return loops;
  if (loops.loops) {
    if (spec.radius !== undefined || spec.profile !== undefined) return { reason: "A section takes a radius, a profile, or loops, not more than one." };
    if (spec.smooth !== undefined || spec.corners !== undefined) return { reason: LOOP_SHAPE };
    return { origin, turn, loops: loops.loops };
  }
  if (spec.radius !== undefined) {
    if (spec.profile !== undefined) return { reason: "A section takes a radius or a profile, not both." };
    if (typeof spec.radius !== "number" || !(spec.radius > 0)) return { reason: "A section's radius is above 0." };
    if (spec.radiusV !== undefined && (typeof spec.radiusV !== "number" || !(spec.radiusV > 0))) return { reason: "radiusV is above 0." };
    return { origin, turn, radius: spec.radius, ...(typeof spec.radiusV === "number" ? { radiusV: spec.radiusV } : {}) };
  }
  const profile = readProfile(spec.profile);
  if (!profile) return { reason: "A section needs a radius, or a profile of at least three [u, v] points." };
  const shape = readShape(spec, profile.length);
  if ("reason" in shape) return shape;
  return { origin, turn, profile, ...(shape.smooth ? { smooth: true as const } : {}), ...(shape.corners?.length ? { corners: [...shape.corners] } : {}) };
}

/** A closed outline of at least three [u, v] points, or null. */
export function readProfile(value: unknown): Vec2[] | null {
  if (!Array.isArray(value) || value.length < 3 || value.length > 1000) return null;
  const out: Vec2[] = [];
  for (const point of value) {
    if (!Array.isArray(point) || point.length !== 2 || !point.every((n) => typeof n === "number" && Number.isFinite(n))) return null;
    out.push([point[0] as number, point[1] as number]);
  }
  return out;
}

export function bakeOp(raw: unknown, ctx: BakeContext): Baked | { reason: string } {
  if (!raw || typeof raw !== "object") return { reason: "The edit needs an op." };
  const spec = raw as Record<string, unknown>;
  const kind = spec.kind;
  if (isComposite(kind)) return { reason: `A ${kind} is several steps. Apply it with model_apply or model_apply_batch.` };
  if (kind === "scale") {
    const factor = spec.factor;
    if (typeof factor !== "number" || !Number.isFinite(factor) || factor < 0.1 || factor > 20) return { reason: "Scale is a factor from 0.1 to 20." };
    return { op: toSolidOp({ kind: "scale", factor }, ctx.pose), typed: { kind: "scale", factor } };
  }
  if (kind === "unify") return { op: toSolidOp({ kind: "unify" }, ctx.pose), typed: { kind: "unify" } };
  // --- Split to print. Defaults are filled from the plate's printer and settings now, as at Apply (D11).
  if (kind === "partition") {
    return ctx.partition ? ctx.partition(spec) : { reason: outsideSession("A split to print") };
  }
  if (kind === "split") {
    const origin = (Array.isArray(spec.origin) ? spec.origin : [0, 0, 0]) as [number, number, number];
    const normal = (Array.isArray(spec.normal) ? spec.normal : [0, 0, 1]) as [number, number, number];
    const op: ModelOp = { kind: "split", origin, normal };
    return { op: toSolidOp(op, ctx.pose), typed: { kind: "split", origin, normal } };
  }
  if (kind === "fillet" || kind === "chamfer") {
    const picked = resolveEdges(spec, ctx);
    if ("reason" in picked) return picked;
    const size = spec.size;
    if (typeof size !== "number") return { reason: "This edit needs a size in millimetres." };
    if (kind === "fillet") {
      let continuity: FilletContinuity | undefined;
      if (spec.continuity !== undefined) {
        if (spec.continuity !== "g1" && spec.continuity !== "g2" && spec.continuity !== "conic") {
          return { reason: "Fillet continuity must be g1, g2, or conic." };
        }
        if (spec.continuity !== "g1") continuity = spec.continuity;
      }
      let rho: number | undefined;
      if (spec.rho !== undefined) {
        if (typeof spec.rho !== "number" || !Number.isFinite(spec.rho) || spec.rho < 0.05 || spec.rho > 0.95) {
          return { reason: "Conic fillet rho must be between 0.05 and 0.95." };
        }
        rho = spec.rho;
      }
      let variable: [number, number][] | undefined;
      if (spec.variable !== undefined) {
        if (!Array.isArray(spec.variable) || spec.variable.length < 2) {
          return { reason: "Variable fillet needs at least two [u, radius] stations." };
        }
        const parsed = spec.variable.map(pairOf);
        if (parsed.some((p) => !p || p[0] < 0 || p[0] > 1 || !(p[1] > 0))) {
          return { reason: "Variable fillet stations are [u, radius] with u in [0, 1] and radius > 0." };
        }
        variable = parsed as [number, number][];
      }
      const extra = {
        ...(continuity ? { continuity } : {}),
        ...(rho !== undefined ? { rho } : {}),
        ...(variable ? { variable } : {}),
      };
      return { op: toSolidOp({ kind, edges: picked, size, ...extra }, ctx.pose), typed: { kind, edges: picked, size, ...extra } };
    }
    // Gaps 13. A second distance or an angle, and which face takes `size`. Absent fields keep equal sides.
    const second = typeof spec.size2 === "number" ? { size2: spec.size2 } : {};
    const angle = typeof spec.angleDeg === "number" ? { angleDeg: spec.angleDeg } : {};
    if ("size2" in second && "angleDeg" in angle) return { reason: "Give a chamfer size2 or angleDeg, not both." };
    const flip = spec.flip === true && ("size2" in second || "angleDeg" in angle) ? { flip: true as const } : {};
    const op: ModelOp = { kind, edges: picked, size, ...second, ...angle, ...flip };
    return { op: toSolidOp(op, ctx.pose), typed: { kind, edges: picked, size, ...second, ...angle, ...flip } };
  }
  // --- Print transitions. The build direction is worked out now, from this pose on the plate's printer, and kept.
  if (kind === "transition") return ctx.transition ? ctx.transition(spec) : { reason: outsideSession("A print transition") };
  if (kind === "hole") {
    if (typeof spec.screw === "string") {
      const screw = SCREWS.find((entry) => entry.name === spec.screw);
      if (!screw) return { reason: "That screw size is not one this slicer cuts." };
      spec.diameterMm = screw.hole;
      spec.through = true;
      spec.counterboreDiameterMm = screw.bore;
      spec.counterboreDepth = screw.boreDepth;
    }
    const radius = typeof spec.diameterMm === "number" ? spec.diameterMm / 2 : spec.radius;
    if (typeof radius !== "number" || !(radius > 0)) return { reason: "The hole needs a diameter." };
    const at = spec.at as { u?: number; v?: number } | undefined;
    let origin: [number, number, number];
    let axis: [number, number, number];
    const typedIn = ctx.plane;
    if (at && typeof at.u === "number" && typeof at.v === "number" && !isGlobalFrame(typedIn)) {
      origin = planePoint(typedIn, [at.u, at.v, 0]);
      axis = drillDown(typedIn);
    } else if (at && typeof at.u === "number" && typeof at.v === "number") {
      origin = [at.u, at.v, ctx.solid ? typedView(ctx.solid, ctx.pose).bounds.max[2] : 0];
      axis = [0, 0, -1];
    } else {
      origin = (Array.isArray(spec.origin) ? spec.origin : [0, 0, 0]) as [number, number, number];
      axis = (Array.isArray(spec.axis) ? spec.axis : [0, 0, -1]) as [number, number, number];
    }
    const through = spec.through === true;
    // The part's box where the hole's origin and axis are typed, so a through hole runs through a moved part too.
    const box = ctx.solid ? typedView(ctx.solid, ctx.pose).bounds : { min: [0, 0, 0] as [number, number, number], max: [0, 0, 0] as [number, number, number] };
    const depth = through ? throughLength(box, origin, axis) : (typeof spec.depth === "number" ? spec.depth : 0);
    if (!through && !(depth > 0)) return { reason: "The hole needs a depth, or through." };
    const counterbore = typeof spec.counterboreDiameterMm === "number" && typeof spec.counterboreDepth === "number"
      ? { counterboreRadius: spec.counterboreDiameterMm / 2, counterboreDepth: spec.counterboreDepth }
      : {};
    const typedBore = typeof spec.counterboreDiameterMm === "number" && typeof spec.counterboreDepth === "number"
      ? { counterboreDiameterMm: spec.counterboreDiameterMm, counterboreDepth: spec.counterboreDepth }
      : {};
    const op: ModelOp = { kind: "hole", origin, axis, radius, depth, ...(through ? { through: true as const } : {}), ...counterbore };
    return { op: toSolidOp(op, ctx.pose), typed: { kind: "hole", diameterMm: radius * 2, ...(through ? { through: true } : { depth }), ...typedBore } };
  }
  if (kind === "join") {
    return ctx.join ? ctx.join(spec) : { reason: outsideSession("A join with another part") };
  }
  if (kind === "extrude" || kind === "revolve") {
    const plane = profilePlane(spec, ctx);
    if ("reason" in plane) return plane;
    const loops = readLoopsField(spec.loops);
    if ("reason" in loops) return loops;
    if (loops.loops && spec.profile !== undefined) return { reason: "Give a profile or loops, not both." };
    if (loops.loops && (spec.smooth !== undefined || spec.corners !== undefined)) return { reason: LOOP_SHAPE };
    const booleanOp = spec.op === "cut" || spec.op === "common" ? spec.op : "fuse";
    // K3. Each field is sent only when set. A plain extrude is the same call as before. Loops take them too.
    const readExtent = (depth: number): { depth2?: number; draftDeg?: number; upTo?: number } | { reason: string } => {
      const extent: { depth2?: number; draftDeg?: number; upTo?: number } = {};
      if (spec.depth2 !== undefined) {
        if (typeof spec.depth2 !== "number" || !(spec.depth2 > 0)) return { reason: "The second depth is a distance on the other side of the plane, above 0." };
        extent.depth2 = spec.depth2;
      }
      if (spec.draftDeg !== undefined && spec.draftDeg !== 0) {
        if (typeof spec.draftDeg !== "number" || !Number.isFinite(spec.draftDeg) || Math.abs(spec.draftDeg) >= 89) return { reason: "A draft angle must be between -89 and 89 degrees." };
        extent.draftDeg = spec.draftDeg;
      }
      if (spec.upTo !== undefined) {
        if (typeof spec.upTo === "number" && Number.isInteger(spec.upTo)) {
          if (!ctx.solid?.faces[spec.upTo]) return { reason: "That face is not on this solid." };
          extent.upTo = spec.upTo;
        } else if (spec.upTo && typeof spec.upTo === "object") {
          const found = ctx.expand().faceBy(spec.upTo as Record<string, unknown>);
          if (typeof found !== "number") return found;
          extent.upTo = found;
        } else return { reason: "That face is not on this solid." };
      }
      if (extent.upTo !== undefined && extent.depth2 !== undefined) return { reason: "An extrude up to a face starts at the profile. Drop the second depth." };
      if (extent.upTo !== undefined && spec.symmetric === true) return { reason: "An extrude up to a face starts at the profile. Leave centred off." };
      if (extent.upTo !== undefined && extent.draftDeg !== undefined) return { reason: "A draft up to a face is not available yet. Drop the draft, or drop the face and set a depth." };
      if (extent.depth2 !== undefined && spec.symmetric === true) return { reason: "An extrude is centred, or it has a second depth, not both." };
      if (depth === 0 && extent.upTo === undefined && extent.depth2 === undefined) return { reason: "An extrude needs a depth in millimetres." };
      return extent;
    };
    if (loops.loops) {
      if (kind === "extrude") {
        const depth = spec.depth;
        if (typeof depth !== "number" || !Number.isFinite(depth)) return { reason: "An extrude needs a depth in millimetres." };
        const extent = readExtent(depth);
        if ("reason" in extent) return extent;
        const plain = extrudeOp(booleanOp, plane, [], depth, spec.symmetric === true, {}, loops.loops);
        const fields = extrudeOp(booleanOp, plane, [], depth, spec.symmetric === true, {}, extent);
        const made = {
          ...plain,
          ...(fields.depth2 !== undefined ? { depth2: fields.depth2 } : {}),
          ...(fields.draftDeg !== undefined ? { draftDeg: fields.draftDeg } : {}),
          ...(fields.upTo !== undefined ? { upTo: fields.upTo } : {}),
        };
        return { op: toSolidOp(made, ctx.pose), typed: { ...made } };
      }
      const axisOrigin = readProfile([spec.axisOrigin, [0, 0], [0, 0]])?.[0];
      const axisDir = readProfile([spec.axisDir, [0, 0], [0, 0]])?.[0];
      const made = revolveOp(booleanOp, plane, [], {
        ...(spec.axisOrigin !== undefined && axisOrigin ? { origin: axisOrigin } : {}),
        ...(spec.axisDir !== undefined && axisDir ? { dir: axisDir } : {}),
        ...(typeof spec.angleDeg === "number" ? { angleDeg: spec.angleDeg } : {}),
      }, {}, loops.loops);
      return { op: toSolidOp(made, ctx.pose), typed: { ...made } };
    }
    const profile = readProfile(spec.profile);
    if (!profile) return { reason: "A profile needs at least three [u, v] points." };
    const shape = readShape(spec, profile.length);
    if ("reason" in shape) return shape;
    if (kind === "extrude") {
      const depth = spec.depth;
      if (typeof depth !== "number" || !Number.isFinite(depth)) return { reason: "An extrude needs a depth in millimetres." };
      const extent = readExtent(depth);
      if ("reason" in extent) return extent;
      const made = extrudeOp(booleanOp, plane, profile, depth, spec.symmetric === true, shape, extent);
      return { op: toSolidOp(made, ctx.pose), typed: { ...made } };
    }
    const axisOrigin = readProfile([spec.axisOrigin, [0, 0], [0, 0]])?.[0];
    const axisDir = readProfile([spec.axisDir, [0, 0], [0, 0]])?.[0];
    const made = revolveOp(booleanOp, plane, profile, {
      ...(spec.axisOrigin !== undefined && axisOrigin ? { origin: axisOrigin } : {}),
      ...(spec.axisDir !== undefined && axisDir ? { dir: axisDir } : {}),
      ...(typeof spec.angleDeg === "number" ? { angleDeg: spec.angleDeg } : {}),
    }, shape);
    return { op: toSolidOp(made, ctx.pose), typed: { ...made } };
  }
  if (kind === "loft" || kind === "sweep") {
    const booleanOp = spec.op === "cut" || spec.op === "common" ? spec.op : "fuse";
    // S2: Real kernel pipe-shell sweep when `spine` is supplied (`BRepOffsetAPI_MakePipeShell`).
    if (kind === "sweep" && spec.spine !== undefined) {
      if (!Array.isArray(spec.sections) || spec.sections.length < 1) return { reason: "A kernel sweep needs at least 1 section." };
      const sections: LoftSection[] = [];
      for (const [index, value] of (spec.sections as unknown[]).entries()) {
        const section = readSection(value);
        if ("reason" in section) return { reason: `sections[${index}]: ${section.reason}` };
        sections.push(section);
      }
      const spine = readCurve3DField(spec.spine, ctx);
      if ("reason" in spine) return spine;
      let mode: SweepMode | undefined;
      if (spec.mode !== undefined) {
        const parsed = readSweepModeField(spec.mode, ctx);
        if ("reason" in parsed) return parsed;
        mode = parsed;
      }
      let transition: SweepTransition | undefined;
      if (spec.transition !== undefined) {
        if (spec.transition !== "round" && spec.transition !== "right" && spec.transition !== "transformed") {
          return { reason: "sweep transition must be round, right, or transformed." };
        }
        transition = spec.transition;
      }
      let scale: [number, number][] | undefined;
      if (spec.scale !== undefined) {
        if (!Array.isArray(spec.scale) || spec.scale.length < 2) return { reason: "Kernel sweep scale needs at least two [u, factor] stations." };
        const parsed = spec.scale.map(pairOf);
        if (parsed.some((p) => !p || !(p[1] > 0))) return { reason: "Kernel sweep scale stations are [u, factor] with factor > 0." };
        scale = parsed as [number, number][];
      }
      let twistDeg: number | undefined;
      if (spec.twistDeg !== undefined) {
        if (typeof spec.twistDeg !== "number" || !Number.isFinite(spec.twistDeg)) return { reason: "twistDeg must be a finite number." };
        twistDeg = spec.twistDeg;
      }
      const made = sweepOp(booleanOp, sections, spine, { mode, transition, scale, twistDeg });
      return { op: toSolidOp(made, ctx.pose), typed: { ...made } };
    }
    let sections: LoftSection[];
    if (kind === "sweep") {
      const made = sweepSections(spec as unknown as SweepSpec);
      if ("reason" in made) return made;
      sections = made;
    } else {
      if (!Array.isArray(spec.sections) || spec.sections.length < 2) return { reason: "A loft needs at least 2 sections." };
      if (spec.sections.length > 200) return { reason: "A loft takes at most 200 sections." };
      sections = [];
      for (const [index, value] of (spec.sections as unknown[]).entries()) {
        const section = readSection(value);
        if ("reason" in section) return { reason: `sections[${index}]: ${section.reason}` };
        sections.push(section);
      }
      let guides: Curve3D[] | undefined;
      if (spec.guides !== undefined) {
        if (!Array.isArray(spec.guides)) return { reason: "Loft guides must be an array of Curve3D objects." };
        guides = [];
        for (const [idx, g] of (spec.guides as unknown[]).entries()) {
          const curve = readCurve3DField(g, ctx);
          if ("reason" in curve) return { reason: `guides[${idx}]: ${curve.reason}` };
          guides.push(curve);
        }
      }
      let startCondition: LoftBoundary | undefined;
      if (spec.startCondition !== undefined) {
        const parsed = readLoftBoundaryField(spec.startCondition);
        if ("reason" in parsed) return { reason: `startCondition: ${parsed.reason}` };
        startCondition = parsed;
      }
      let endCondition: LoftBoundary | undefined;
      if (spec.endCondition !== undefined) {
        const parsed = readLoftBoundaryField(spec.endCondition);
        if ("reason" in parsed) return { reason: `endCondition: ${parsed.reason}` };
        endCondition = parsed;
      }
      let maxDegree: number | undefined;
      if (spec.maxDegree !== undefined) {
        if (typeof spec.maxDegree !== "number" || !Number.isInteger(spec.maxDegree) || spec.maxDegree < 2 || spec.maxDegree > 12) {
          return { reason: "Loft maxDegree must be an integer from 2 to 12." };
        }
        maxDegree = spec.maxDegree;
      }
      const made = loftOp(booleanOp, sections, spec.ruled === true, {
        ...(guides?.length ? { guides } : {}),
        ...(startCondition ? { startCondition } : {}),
        ...(endCondition ? { endCondition } : {}),
        ...(spec.closed === true ? { closed: true } : {}),
        ...(spec.smoothing === true ? { smoothing: true } : {}),
        ...(maxDegree !== undefined ? { maxDegree } : {}),
      });
      return { op: toSolidOp(made, ctx.pose), typed: { ...made } };
    }
    const made = loftOp(booleanOp, sections, spec.ruled === true);
    const typed = { ...cleanOp(spec), op: booleanOp, sections: sections.length };
    return { op: toSolidOp(made, ctx.pose), typed };
  }
  if (kind === "shell") {
    const thickness = spec.thickness;
    if (typeof thickness !== "number" || !(thickness > 0)) return { reason: "A shell needs a wall thickness in millimetres." };
    const faces: number[] = [];
    const expanded = ctx.expand();
    for (const pick of Array.isArray(spec.openFaces) ? spec.openFaces : []) {
      if (Number.isInteger(pick)) {
        if (!ctx.solid?.faces[pick as number]) return { reason: "That face is not on this solid." };
        faces.push(pick as number);
        continue;
      }
      const found = expanded.faceBy((pick ?? {}) as Record<string, unknown>);
      if (typeof found !== "number") return found;
      faces.push(found);
    }
    const made = shellOp(thickness, [...new Set(faces)]);
    return { op: toSolidOp(made, ctx.pose), typed: { ...made } };
  }
  // --- K4: faceExtrude and moveFaces. A face is an index, a stored {index}, or a {normal, nearPoint} selector. ---
  if (kind === "faceExtrude") {
    const distance = spec.distance;
    if (typeof distance !== "number" || !Number.isFinite(distance) || distance === 0) return { reason: "A face extrude needs a distance other than 0." };
    if (spec.draftDeg !== undefined && (typeof spec.draftDeg !== "number" || !Number.isFinite(spec.draftDeg) || spec.draftDeg < -89 || spec.draftDeg > 89)) {
      return { reason: "The draft angle must be between -89 and 89 degrees." };
    }
    const face = bakedFace(spec.face, ctx);
    if (typeof face !== "number") return face;
    let upTo: number | undefined;
    if (spec.upTo !== undefined && spec.upTo !== null) {
      const until = bakedFace(spec.upTo, ctx);
      if (typeof until !== "number") return until;
      if (until === face) return { reason: "A face cannot stop at itself." };
      upTo = until;
    }
    const made = faceExtrudeOp(face, distance, {
      ...(typeof spec.draftDeg === "number" && spec.draftDeg !== 0 ? { draftDeg: spec.draftDeg } : {}),
      ...(upTo !== undefined ? { upTo } : {}),
    });
    return { op: toSolidOp(made, ctx.pose), typed: { ...made } };
  }
  if (kind === "moveFaces") {
    if (!Array.isArray(spec.faces) || spec.faces.length === 0) return { reason: "Pick a face to move." };
    const rows: { face: number; distance: number }[] = [];
    for (const raw of spec.faces) {
      if (!raw || typeof raw !== "object") return { reason: "Pick a face to move." };
      const row = raw as { face?: unknown; distance?: unknown };
      if (typeof row.distance !== "number" || !Number.isFinite(row.distance) || row.distance === 0) return { reason: "A face move needs a distance other than 0." };
      const face = bakedFace(row.face, ctx);
      if (typeof face !== "number") return face;
      rows.push({ face, distance: row.distance });
    }
    const made = moveFacesOp(rows);
    return { op: toSolidOp(made, ctx.pose), typed: { ...made } };
  }
  if (kind === "draft") {
    if (!Array.isArray(spec.faces) || spec.faces.length < 1 || spec.faces.length > 50) return { reason: "Pick a face to draft." };
    const angle = spec.angleDeg;
    if (typeof angle !== "number" || !Number.isFinite(angle) || angle === 0 || angle < -30 || angle > 30) {
      return { reason: "The draft angle must be between -30 and 30 degrees, and not 0." };
    }
    const faces: number[] = [];
    for (const raw of spec.faces) {
      const face = bakedFace(raw, ctx);
      if (typeof face !== "number") return face;
      // Named by the face's index, as picked, not by its place in the list.
      if (faces.includes(face)) return { reason: `Face ${face} is listed twice.` };
      faces.push(face);
    }
    const rawPull = spec.pull === undefined ? undefined : readVec3(spec.pull, [NaN, NaN, NaN]);
    if (rawPull && rawPull.some((value) => !Number.isFinite(value))) return { reason: "The pull direction must be a direction." };
    const pullLength = rawPull ? Math.hypot(rawPull[0], rawPull[1], rawPull[2]) : 0;
    if (rawPull && pullLength < 1e-9) return { reason: "The pull direction must be a direction." };
    const pull = rawPull ? [rawPull[0] / pullLength, rawPull[1] / pullLength, rawPull[2] / pullLength] as [number, number, number] : undefined;
    const defaultPull = pull === undefined || (Math.abs(pull[0]) < 1e-9 && Math.abs(pull[1]) < 1e-9 && pull[2] > 0.999);
    let neutral: DraftNeutral | undefined;
    if (spec.neutral !== undefined && spec.neutral !== null) {
      const raw = spec.neutral;
      if (raw && typeof raw === "object" && "origin" in raw && "normal" in raw) {
        const plane = raw as { origin?: unknown; normal?: unknown };
        const origin = readVec3(plane.origin, [NaN, NaN, NaN]);
        const normal = readVec3(plane.normal, [NaN, NaN, NaN]);
        if (origin.some((value) => !Number.isFinite(value)) || normal.some((value) => !Number.isFinite(value)) || Math.hypot(...normal) < 1e-9) {
          return { reason: "The neutral plane needs an origin and a normal." };
        }
        neutral = { origin, normal };
      } else {
        const face = bakedFace(raw, ctx);
        if (typeof face !== "number") return face;
        if (faces.includes(face)) return { reason: "The neutral face is one of the faces being drafted." };
        neutral = face;
      }
    }
    const made = draftOp(faces, angle, { ...(defaultPull || !pull ? {} : { pull }), ...(neutral !== undefined ? { neutral } : {}) });
    return { op: toSolidOp(made, ctx.pose), typed: { ...made } };
  }
  // --- Organic surfaces S4: Open surfaces ("Sheets") and surface-to-solid ops. ---
  if (kind === "sheet") {
    const built = readSheetSpecField(spec, ctx);
    if ("reason" in built) return built;
    const made = sheetOp(built);
    return { op: toSolidOp(made, ctx.pose), typed: { ...made } };
  }
  if (kind === "sew") {
    let tolerance: number | undefined;
    if (spec.tolerance !== undefined) {
      if (typeof spec.tolerance !== "number" || !Number.isFinite(spec.tolerance) || !(spec.tolerance > 0)) {
        return { reason: "Sew tolerance must be above 0 mm." };
      }
      tolerance = spec.tolerance;
    }
    const makeSolid = spec.makeSolid === undefined ? undefined : spec.makeSolid === true;
    const capPlanar = spec.capPlanar === true ? true : undefined;
    const made = sewOp({ ...(tolerance !== undefined ? { tolerance } : {}), ...(makeSolid !== undefined ? { makeSolid } : {}), ...(capPlanar ? { capPlanar } : {}) });
    return { op: toSolidOp(made, ctx.pose), typed: { ...made } };
  }
  if (kind === "thicken") {
    const thickness = spec.thickness;
    if (typeof thickness !== "number" || !Number.isFinite(thickness) || !(thickness > 0)) {
      return { reason: "Thicken needs a positive wall thickness in millimetres." };
    }
    let direction: ThickenDirection | undefined;
    if (spec.direction !== undefined) {
      if (spec.direction !== "normal" && spec.direction !== "reverse" && spec.direction !== "both") {
        return { reason: "Thicken direction must be normal, reverse, or both." };
      }
      direction = spec.direction;
    }
    let tolerance: number | undefined;
    if (spec.tolerance !== undefined) {
      if (typeof spec.tolerance !== "number" || !Number.isFinite(spec.tolerance) || !(spec.tolerance > 0)) {
        return { reason: "Thicken tolerance must be above 0 mm." };
      }
      tolerance = spec.tolerance;
    }
    const made = thickenOp(thickness, { ...(direction ? { direction } : {}), ...(tolerance !== undefined ? { tolerance } : {}) });
    return { op: toSolidOp(made, ctx.pose), typed: { ...made } };
  }
  if (kind === "trimSplit") {
    const built = readSheetSpecField(spec.sheet, ctx);
    if ("reason" in built) return built;
    let keep: TrimKeep | undefined;
    if (spec.keep !== undefined) {
      if (spec.keep !== "above" && spec.keep !== "below" && spec.keep !== "both") {
        return { reason: "trimSplit keep must be above, below, or both." };
      }
      keep = spec.keep;
    }
    const made = trimSplitOp(built, keep);
    return { op: toSolidOp(made, ctx.pose), typed: { ...made } };
  }
  if (kind === "replaceFace") {
    const face = bakedFace(spec.face, ctx);
    if (typeof face !== "number") return face;
    const built = readSheetSpecField(spec.sheet, ctx);
    if ("reason" in built) return built;
    const made = replaceFaceOp(face, built);
    return { op: toSolidOp(made, ctx.pose), typed: { ...made } };
  }
  if (kind === "splitFace") {
    if (!Array.isArray(spec.faces) || spec.faces.length < 1 || spec.faces.length > 50) {
      return { reason: "Pick at least one face to split." };
    }
    const faces: number[] = [];
    for (const raw of spec.faces) {
      const face = bakedFace(raw, ctx);
      if (typeof face !== "number") return face;
      if (!faces.includes(face)) faces.push(face);
    }
    const curve = readCurve3DField(spec.curve, ctx);
    if ("reason" in curve) return curve;
    let direction: Vec3 | undefined;
    if (spec.direction !== undefined) {
      const v = vec3Of(spec.direction);
      if (!v || Math.hypot(v[0], v[1], v[2]) < 1e-9) return { reason: "splitFace direction must be a non-zero [x, y, z] vector." };
      direction = v;
    }
    const made = splitFaceOp(faces, curve, direction);
    return { op: toSolidOp(made, ctx.pose), typed: { ...made } };
  }
  if (kind === "patch") {
    const boundaries = readBoundariesField(spec.boundaries, ctx);
    if ("reason" in boundaries) return boundaries;
    const guides: Curve3D[] = [];
    if (spec.guides !== undefined) {
      if (!Array.isArray(spec.guides)) return { reason: "A patch guide is a 3D curve." };
      for (const raw of spec.guides) {
        const curve = readCurve3DField(raw, ctx);
        if ("reason" in curve) return curve;
        guides.push(curve);
      }
    }
    const points: Vec3[] = [];
    if (spec.points !== undefined) {
      if (!Array.isArray(spec.points)) return { reason: "A patch guide point is [x, y, z] in millimetres." };
      for (const raw of spec.points) {
        const point = vec3Of(raw);
        if (!point) return { reason: "A patch guide point is [x, y, z] in millimetres." };
        points.push(point);
      }
    }
    let tolerance: number | undefined;
    if (spec.tolerance !== undefined) {
      if (typeof spec.tolerance !== "number" || !Number.isFinite(spec.tolerance) || !(spec.tolerance > 0) || spec.tolerance > 1e-4) {
        return { reason: "Patch tolerance is the gap the fill aims for, above 0 and at most 0.0001 mm." };
      }
      tolerance = spec.tolerance;
    }
    const made = patchOp(boundaries, { ...(guides.length > 0 ? { guides } : {}), ...(points.length > 0 ? { points } : {}), ...(tolerance !== undefined ? { tolerance } : {}) });
    return { op: toSolidOp(made, ctx.pose), typed: { ...made } };
  }
  if (kind === "blendSurface") {
    const a = readBoundaryField(spec.a, ctx, "Side A");
    if ("reason" in a) return a;
    const b = readBoundaryField(spec.b, ctx, "Side B");
    if ("reason" in b) return b;
    const continuity = readContinuityField(spec.continuity, "A blend");
    if (typeof continuity !== "string" && continuity !== undefined) return continuity;
    if (continuity === "g0") return { reason: "A blend is G1 or G2. Set the seam to G1 or G2." };
    const tensionA = readTension(spec.tensionA, "Side A");
    if (typeof tensionA !== "number" && tensionA !== undefined) return tensionA;
    const tensionB = readTension(spec.tensionB, "Side B");
    if (typeof tensionB !== "number" && tensionB !== undefined) return tensionB;
    let tolerance: number | undefined;
    if (spec.tolerance !== undefined) {
      if (typeof spec.tolerance !== "number" || !Number.isFinite(spec.tolerance) || !(spec.tolerance > 0) || spec.tolerance > 1e-4) {
        return { reason: "Blend tolerance is the gap the bridge aims for, above 0 and at most 0.0001 mm." };
      }
      tolerance = spec.tolerance;
    }
    const made = blendSurfaceOp(a, b, {
      ...(continuity ? { continuity } : {}),
      ...(tensionA !== undefined ? { tensionA } : {}),
      ...(tensionB !== undefined ? { tensionB } : {}),
      ...(tolerance !== undefined ? { tolerance } : {}),
    });
    return { op: toSolidOp(made, ctx.pose), typed: { ...made } };
  }
  // --- A gear (src/model-gear.ts): a boolean whose tool is the gear primitive, placed as a cylinder is. Fuse by default.
  if (kind === "gear") {
    const gearOp = spec.op === "cut" || spec.op === "common" ? spec.op : "fuse";
    const local = primitiveFrom({ ...spec, primitive: "gear" }, "gear");
    if ("reason" in local) return local;
    const why = gearRefusal(gearOf(local)!, local.height);
    if (why) return { reason: why };
    const solid = planePrimitive(local, ctx.plane);
    const op = toSolidOp({ kind: "boolean", op: gearOp, ...solid }, ctx.pose);
    return { op, typed: { kind: "boolean", op: gearOp, ...solid, ...(spec.centre !== undefined ? { centre: spec.centre } : {}) } };
  }
  if (kind === "boolean") {
    const booleanOp = spec.op === "fuse" || spec.op === "common" ? spec.op : "cut";
    const local = primitiveFrom(spec, "box");
    if ("reason" in local) return local;
    const solid = planePrimitive(local, ctx.plane);
    const op = toSolidOp({ kind: "boolean", op: booleanOp, ...solid, merge: true }, ctx.pose);
    // A tool placed by centre already says where its middle goes: turnEcho has no note for it. cleanOp drops the mark.
    return { op, typed: { kind: "boolean", op: booleanOp, ...solid, ...(spec.centre !== undefined ? { centre: spec.centre } : {}) } };
  }
  if (kind === "root") {
    const local = primitiveFrom(spec, "box");
    if ("reason" in local) return local;
    const solid = rootSpec(local);
    const op: ModelOp = { kind: "root", ...solid };
    return { op, typed: { kind: "root", ...solid } };
  }
  return { reason: "That edit is not one of hole, fillet, chamfer, transition, split, partition, scale, boolean, extrude, revolve, loft, sweep, shell, faceExtrude, moveFaces, draft, join, or root." };
}


/** What a print transition reads of the plate: the support limit, the nozzle, the printer, and the part's pose on it. */
export interface TransitionEnv {
  supportAngle: number;
  nozzleMm: number;
  printer: { id: string; belt: BeltSettings | null };
  /** The part's plate orientation, row-major. */
  orient: readonly number[];
}

/**
 * --- Print transitions (docs/plan-belt-transitions.md, step 2). The op in the solid's frame, and as typed with every
 * default filled, so a model_edit of the echo keeps the build direction it was made for; `build: null` aims it from
 * this pose again. The MCP session and the app's recipe calls both bake it here.
 */
export function bakeTransition(spec: Record<string, unknown>, ctx: BakeContext, env: TransitionEnv): { op: ModelOp; typed: Record<string, unknown> } | { reason: string } {
  const edges = resolveEdges(spec, ctx);
  if ("reason" in edges) return edges;
  const limit = transitionAngleLimit(env.supportAngle);
  const angleDeg = spec.angleDeg === undefined ? limit : spec.angleDeg;
  if (typeof angleDeg !== "number" || !Number.isFinite(angleDeg) || angleDeg > TRANSITION_MAX_DEG) return { reason: `angleDeg is the new face's angle to the layers, at most ${TRANSITION_MAX_DEG}°.` };
  if (angleDeg < limit - 1e-9) return { reason: `angleDeg must be at least ${formatMm(limit)}°, the support limit of these settings, so the new face holds its own rows.` };
  const size = spec.size === undefined ? TRANSITION_SIZE_MM : spec.size;
  if (size !== "face" && (typeof size !== "number" || !(size > 0))) return { reason: "size is millimetres along the flatter face, or \"face\" to its end." };
  const mode = spec.mode === undefined ? "auto" : spec.mode;
  if (mode !== "auto" && mode !== "add" && mode !== "cut") return { reason: "mode is auto, add, or cut." };
  const maxMm = spec.maxMm;
  if (maxMm !== undefined && (typeof maxMm !== "number" || !(maxMm > 0))) return { reason: "maxMm must be above 0 mm." };
  const kase = spec.case;
  if (kase !== undefined && kase !== "lip" && kase !== "corner") return { reason: "case is lip or corner; left out, each edge's case is found." };
  // --- Step 4. A lip's ramp keeps the wall floor at its first edge: twice the plate machine's nozzle, unless typed.
  const floorMm = spec.floorMm === undefined ? transitionFloorMm(env.nozzleMm) : spec.floorMm;
  if (typeof floorMm !== "number" || !(floorMm > 0)) return { reason: "floorMm must be above 0 mm." };
  const belt = env.printer.belt;
  const pose = ctx.pose;
  let build: [number, number, number];
  if (Array.isArray(spec.build)) {
    const typed = spec.build.slice(0, 3).map(Number);
    if (typed.length !== 3 || !typed.every(Number.isFinite) || Math.hypot(...typed) < 1e-9) return { reason: "build is a direction, three numbers not all 0." };
    build = typed as [number, number, number];
  } else if (spec.build === undefined || spec.build === null) {
    build = turnDir(pose, transitionBuild({ orient: env.orient as never, belt })).map((value) => Math.round(value * 1e9) / 1e9 + 0) as [number, number, number];
  } else return { reason: "build is a direction, or null to aim from this pose." };
  const made = {
    kind: "transition" as const,
    edges,
    build,
    angleDeg,
    size: size as number | "face",
    ...(mode !== "auto" ? { mode: mode as "add" | "cut" } : {}),
    ...(maxMm !== undefined ? { maxMm: maxMm as number } : {}),
    ...(kase !== undefined ? { case: kase as "lip" | "corner" } : {}),
    ...(mode === "cut" ? { floorMm } : {}),
    ...(belt ? { beltDeg: belt.angleDeg } : {}),
    orient: [...env.orient],
    printer: env.printer.id,
  };
  return { op: toSolidOp(made as ModelOp, pose), typed: { ...made } };
}
