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
import { rootSpec } from "../model-primitive.ts";
import { extrudeOp, faceExtrudeOp, loftOp, moveFacesOp, revolveOp, shellOp, stepEdges, type ProfileShape } from "../model-request.ts";
import { toSolidOp, turnDir, type Affine } from "../model-space.ts";
import { formatMm } from "../model-plane.ts";
import { transitionAngleLimit, transitionBuild, transitionFloorMm, TRANSITION_MAX_DEG, TRANSITION_SIZE_MM } from "../model-transition.ts";
import type { BeltSettings } from "../belt.ts";
import type { EdgePick, LoftSection, ModelOp, ProfileLoop, ProfileSegment, Vec2 } from "../model-tree.ts";
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
    if (pieces.length > 200) return { reason: "A loop takes at most 200 segments." };
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
      } else {
        return { reason: "A segment kind is line, arc, or spline." };
      }
    }
    loops.push({ start, segments });
  }
  return { loops };
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

/** One loft section: origin and turn as a profile's plane, then a radius (radiusV for an ellipse) or a profile. */
export function readSection(value: unknown): LoftSection | { reason: string } {
  if (!value || typeof value !== "object") return { reason: "A section is an object with origin and a radius or a profile." };
  const spec = value as Record<string, unknown>;
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
  if (!Array.isArray(value) || value.length < 3 || value.length > 200) return null;
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
    if (kind === "fillet") return { op: toSolidOp({ kind, edges: picked, size }, ctx.pose), typed: { kind, edges: picked, size } };
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
    }
    const made = loftOp(booleanOp, sections, spec.ruled === true);
    const typed = kind === "sweep" ? { ...cleanOp(spec), op: booleanOp, sections: sections.length } : { ...made };
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
  return { reason: "That edit is not one of hole, fillet, chamfer, transition, split, partition, scale, boolean, extrude, revolve, loft, sweep, shell, faceExtrude, moveFaces, join, or root." };
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
