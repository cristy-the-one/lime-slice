/**
 * The Model calls a recipe makes, as the MCP session and the app both answer them (docs/plan-recipe-plugins.md D16):
 * a solid as the calls read it, paging, the replies of model_describe, faces_find and edges_find, and the echoes an
 * applied or probed op carries. The session (mcp/session.ts) and the app's recipe calls (src/recipe/app-calls.ts) use
 * these, so a recipe reads the same answers in both.
 */
import { decodeSolid } from "../model-reply.ts";
import { isPrimitiveKind, type PrimitiveSpec } from "../model-primitive.ts";
import { boxGap, disjointBoolean, primitiveBox, probeFromBody, probeNote, turnedAxis, type ProbedTool } from "../model-feasibility.ts";
import { applyPose, IDENTITY_POSE, isIdentity, turnDir, type Affine } from "../model-space.ts";
import { closeCracks } from "../mesh-check.ts";
import { eulerOrient } from "../mesh-place.ts";
import { posedContext } from "../model-features.ts";
import { axesOf, isGlobalFrame, workplaneIn, workplaneOwn, type Workplane } from "../workplane.ts";
import { standRegion } from "./plane-region.ts";
import type { Fingerprint, ModelOp } from "../model-tree.ts";
import { readFingerprint } from "../model-reply.ts";
import { lostVolume, touchingEdges, touchingReason } from "./step-guard.ts";
import { frameNumbers, frameOf, type CutPlane } from "./sections.ts";
import { plainModelError } from "./model-error.ts";
import { addsPiece, cleanOp, cutsOffPiece, pieceReport, separateReason, splitReason, type ExpandContext } from "./compose.ts";
import { expandContextFromSolid, nearPick, ON_FACE_MM, pickSentence, type FrameFace } from "./frames.ts";
import { edgesMatching, facesMatching } from "./selectors.ts";
import { edgeGeometry, faceRows } from "./solid-geometry.ts";
import { typedView } from "./typed-view.ts";

/** A solid as the Model calls read it: its fingerprint, mesh, face and edge rows, edge polylines and box. */
export type SolidView = NonNullable<ReturnType<typeof solidView>>;

export function solidView(body: Record<string, unknown>) {
  const solid = decodeSolid(body);
  if (typeof solid === "string") return null;
  return {
    id: solid.id,
    volumeMm3: solid.volumeMm3,
    editable: solid.editable,
    fingerprint: solid.fingerprint,
    positions: Float32Array.from(solid.positions),
    triangles: Uint32Array.from(solid.triangles),
    faces: faceRows(solid.positions, solid.triangles, solid.faces),
    edges: solid.edges.map((edge) => ({ index: edge.id, lengthMm: edge.lengthMm, ...edgeGeometry(edge.points, edge.lengthMm) })),
    /** --- Print transitions, step 6b. Each edge's polyline in the solid's frame, for the check against a slice. */
    lines: solid.edges.map((edge) => ({ edge: edge.id, points: Float32Array.from(edge.points) })),
    bounds: boundsOf(solid.positions),
  };
}

export function boundsOf(pos: ArrayLike<number>): { min: [number, number, number]; max: [number, number, number] } {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = pos[i + axis] ?? 0;
      if (value < min[axis]) min[axis] = value;
      if (value > max[axis]) max[axis] = value;
    }
  }
  if (!Number.isFinite(min[0])) return { min: [0, 0, 0], max: [0, 0, 0] };
  return { min, max };
}

export function page<T>(items: T[], cursor: unknown, limit: unknown): { rows: T[]; nextCursor?: string } {
  const size = Math.min(100, Math.max(1, typeof limit === "number" ? limit : 20));
  const start = typeof cursor === "string" ? Number(cursor) : 0;
  const from = Number.isInteger(start) && start > 0 ? start : 0;
  const rows = items.slice(from, from + size);
  return from + size < items.length ? { rows, nextCursor: String(from + size) } : { rows };
}

/**
 * Gaps 13. For a chamfer by two sizes, the face each edge's `size` runs along, as the engine chose it (each edge's upper
 * face, or its lower with flip), with that face's outward normal turned into the part's pose. Null for any other probe.
 */
export function chamferSides(raw: unknown, pose: Affine): { text: string; rows: { edge: number; face: number; normal: number[] }[] } | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const rows = raw.flatMap((row) => {
    const { edge, face, normal } = (row ?? {}) as { edge?: unknown; face?: unknown; normal?: unknown };
    if (typeof edge !== "number" || typeof face !== "number" || !Array.isArray(normal) || normal.length !== 3) return [];
    const turned = turnDir(pose, normal as [number, number, number]).map((value) => Math.round(value * 1000) / 1000 + 0);
    return [{ edge, face, normal: turned }];
  });
  if (rows.length === 0) return null;
  const faces = [...new Set(rows.map((row) => row.face))];
  const text = rows.length === 1
    ? `size runs along face ${rows[0]!.face} (normal ${rows[0]!.normal.join(", ")}); flip: true puts it on the other face.`
    : `size runs along face${faces.length === 1 ? "" : "s"} ${faces.join(", ")}, one for each edge; flip: true puts it on the other faces.`;
  return { text, rows };
}

/**
 * --- 3.1 F8. Where a turned round tool's axis lies, beside its echo, and a sentence when its base left `origin`: a
 * turn is about the middle of the axis, and 198 holes once went h/2 off because a caller took origin for the pivot.
 */
export function turnEcho(typed: Record<string, unknown>): Record<string, unknown> {
  if (typed.kind !== "boolean" || !isPrimitiveKind(typed.primitive) || !Array.isArray(typed.turn) || !Array.isArray(typed.origin)) return {};
  if ((typed.turn as number[]).every((value) => value === 0)) return {};
  const axis = turnedAxis(typed as unknown as PrimitiveSpec);
  if (!axis) return {};
  const at = (p: readonly number[]) => p.map((value) => Math.round(value * 1000) / 1000 + 0);
  const base = at(axis.base);
  const origin = typed.origin as number[];
  const moved = typed.centre === undefined && Math.hypot(base[0]! - origin[0]!, base[1]! - origin[1]!, base[2]! - origin[2]!) > 1e-3;
  return {
    axis: { base, top: at(axis.top) },
    ...(moved ? { turnNote: `It turns about the middle of its axis, so its base centre is at [${base.join(", ")}], not at origin. Give centre to place a turned shape by its middle.` } : {}),
  };
}

/** Past this many loops or steps, an applied op's echo counts them instead of listing them. */
const ECHO_ITEMS = 32;

/** I18–I20: an op as a reply echoes it, with a lattice's loops, its region, and a combined group's steps counted, not listed. */
export function compactEcho(op: Record<string, unknown>): Record<string, unknown> {
  const count = (value: unknown, noun: string) => (Array.isArray(value) ? `${value.length} ${noun}${value.length === 1 ? "" : "s"}` : value);
  const long = (value: unknown) => Array.isArray(value) && value.length > ECHO_ITEMS;
  return {
    ...op,
    ...(long(op.loops) || op.clip !== undefined ? { loops: count(op.loops, "loop") } : {}),
    ...(op.clip !== undefined ? { clip: count(op.clip, "loop") } : {}),
    ...(long(op.steps) || op.combine !== undefined ? { steps: count(op.steps, "step") } : {}),
  };
}

/**
 * model_describe's reply: the solid's volume and fingerprint, then its faces and edges, a page of each. Every point and
 * direction is in the frame ops are typed in (`pose`, the part's typed pose; `frame` names it), so a box or a face centre
 * read here is where a cut at it lands.
 */
export function describeReply(own: SolidView, input: Record<string, unknown>, frame: string, extra: Record<string, unknown> = {}, pose: Affine = IDENTITY_POSE): Record<string, unknown> {
  const solid = typedView(own, pose);
  const faces = page(solid.faces.map((face) => ({
    index: face.index,
    areaMm2: face.areaMm2,
    ...(face.normal ? { normal: face.normal } : {}),
    centre: face.centre,
    bbox: face.bbox,
    kind: face.kind,
    ...(face.radiusMm !== undefined ? { radiusMm: face.radiusMm, axis: face.axis, ...(face.axisPoint ? { axisPoint: face.axisPoint } : {}) } : {}),
  })), input.facesCursor ?? input.cursor, input.limit);
  const edges = page(solid.edges.map((edge) => ({
    index: edge.index,
    mid: edge.mid,
    start: edge.start,
    end: edge.end,
    lengthMm: edge.lengthMm,
    ...(edge.dir ? { dir: edge.dir } : {}),
  })), input.edgesCursor, input.limit);
  return {
    ok: true,
    ...extra,
    volumeMm3: solid.volumeMm3,
    solid: solid.editable,
    fingerprint: solid.fingerprint,
    bounds: solid.bounds,
    frame,
    faces: faces.rows,
    edges: edges.rows,
    ...(faces.nextCursor ? { facesNextCursor: faces.nextCursor, nextCursor: faces.nextCursor } : {}),
    ...(edges.nextCursor ? { edgesNextCursor: edges.nextCursor } : {}),
  };
}

/**
 * faces_find's reply: the faces a filter matches, a page of them, each flat one with the frame that draws on it. The
 * filter's normal and nearPoint, and every row, are in the frame ops are typed in (`pose`; `frame` names it), as the
 * face frames from `ctx` are.
 */
export function facesReply(own: SolidView, input: Record<string, unknown>, ctx: ExpandContext, pose: Affine = IDENTITY_POSE, frame = "model"): Record<string, unknown> {
  const solid = typedView(own, pose);
  const matched = facesMatching(solid.faces, input, solid);
  if ("reason" in matched) return { ok: false, reason: matched.reason };
  const listed = page(matched, input.cursor, input.limit);
  // --- I8. A nearPoint on no face is said so, with the face level with it that has material.
  const near = Array.isArray(input.nearPoint) ? (input.nearPoint as number[]) : null;
  const first = matched[0];
  let note: string | undefined;
  if (near && first && typeof first.distanceMm === "number" && first.distanceMm > ON_FACE_MM) {
    const gap = new Map(matched.map((row) => [row.index, row.distanceMm ?? Infinity] as const));
    note = pickSentence(nearPick(solid.faces as FrameFace[], first.index, near, gap), near).replace("The face selector picked", "The nearest face is");
  }
  // --- I7. A flat face's frame, as extrude {face}, array, and section use it: origin, U, V, W and the turn that draws in it.
  const rows = listed.rows.map((row) => {
    if (!row.normal) return row;
    const framed = ctx.face(row.index);
    if ("reason" in framed) return row;
    return { ...row, frame: { ...frameOf(framed.plane), turn: framed.plane.turn.map((n) => Math.round(n * 1e6) / 1e6) } };
  });
  return { ok: true, total: matched.length, frame, faces: rows, ...(listed.nextCursor ? { nextCursor: listed.nextCursor } : {}), ...(note ? { note } : {}) };
}

/** edges_find's reply, in the frame ops are typed in (`pose`; `frame` names it). `onFace` turns an onFace selector into its face's index. */
export function edgesReply(own: SolidView, input: Record<string, unknown>, onFace: (filter: Record<string, unknown>) => Record<string, unknown> | string, pose: Affine = IDENTITY_POSE, frame = "model"): Record<string, unknown> {
  const solid = typedView(own, pose);
  const filter = onFace(input);
  if (typeof filter === "string") return { ok: false, reason: filter };
  const matched = edgesMatching(solid.edges, solid.faces, filter, solid);
  if ("reason" in matched) return { ok: false, reason: matched.reason };
  const listed = page(matched, input.cursor, input.limit);
  return { ok: true, total: matched.length, frame, edges: listed.rows, ...(listed.nextCursor ? { nextCursor: listed.nextCursor } : {}) };
}

/** A step's handle in replies, `node_4`, and back. */
export function nodeHandle(id: number): string {
  return `node_${id}`;
}

export function parseNode(handle: unknown): number | null {
  if (typeof handle !== "string") return null;
  const match = /^node_(\d+)$/.exec(handle);
  return match ? Number(match[1]) : null;
}

/** A probe's reply: the body, then the edges a blend picked, and the op as stored and as typed. */
export function probeEcho(baked: { op: ModelOp; typed: Record<string, unknown> }, body: Record<string, unknown>): Record<string, unknown> {
  const picked = baked.op.kind === "fillet" || baked.op.kind === "chamfer" || baked.op.kind === "transition" ? { edges: baked.typed.edges } : {};
  return { ...body, ...picked, stored: cleanOp(baked.op as unknown as Record<string, unknown>), typed: cleanOp(baked.typed), ...turnEcho(baked.typed) };
}

/** A Boolean whose tool misses the part, found from the boxes before the kernel is asked, with the gap in mm. */
export function disjointRefusal(bounds: { min: [number, number, number]; max: [number, number, number] }, op: ModelOp): { reason: string; gapMm: number } | null {
  if (op.kind !== "boolean") return null;
  const missed = disjointBoolean(bounds, op, op.op);
  if (!missed) return null;
  // In the solid's frame both boxes; the gap is a lower bound on how far the tool must move.
  const gap = Math.round(boxGap(bounds, primitiveBox(op)) * 100) / 100;
  return { reason: op.op === "fuse" && gap > 0 ? `${missed} It is at least ${gap} mm clear of the part's bounding box.` : missed, gapMm: gap };
}

/**
 * What the kernel's probe of `op` says: it fits (with the sentence, and the faces a two-size chamfer runs along), or
 * it does not (the reply body). A shell too thick says so in `tooThick`, for a caller that looks for the wall that fits.
 * `composite` refuses a cut that splits a piece off, as a pattern's step must not.
 */
export function probeVerdict(op: ModelOp, reply: Record<string, unknown>, pose: Affine, composite = false): { ok: true; text: string; firstFaces?: { edge: number; face: number; normal: number[] }[] } | { ok: false; body: Record<string, unknown>; tooThick?: string } {
  const tool = (op.kind === "join" ? "boolean" : op.kind) as ProbedTool;
  const view = probeFromBody(reply, op.kind === "group" ? op.steps.length : undefined);
  const note = probeNote(tool, view);
  // --- A9. A group probe names the step that failed, counting from 1. ---
  const failedStep = view?.phase === "done" && view.ok === false && view.failedStep != null ? { failedStep: view.failedStep } : {};
  if (!note || note.bad) {
    const tooThick = op.kind === "shell" && note?.bad && /too thick/.test(note.text) ? { tooThick: note.text } : {};
    return { ok: false, body: { ok: false, reason: note?.text ?? "This does not fit.", ...(typeof reply.maxMm === "number" ? { maxMm: reply.maxMm } : {}), ...failedStep }, ...tooThick };
  }
  if (view?.phase === "done" && addsPiece(op as { kind: string; op?: string }, view.measure)) {
    const where = pieceReport(reply, (p) => applyPose(pose, p));
    return { ok: false, body: { ok: false, reason: separateReason(where), ...(where ? { where } : {}) } };
  }
  if (composite && view?.phase === "done" && cutsOffPiece(op as { kind: string; op?: string }, view.measure)) {
    const where = pieceReport(reply, (p) => applyPose(pose, p));
    return { ok: false, body: { ok: false, reason: splitReason(where), ...(where ? { where } : {}) } };
  }
  const sides = chamferSides(reply.firstFaces, pose);
  if (sides) return { ok: true, text: `${note.text} ${sides.text}`, firstFaces: sides.rows };
  return { ok: true, text: note.text };
}

/**
 * The op an applied step stores: a blend as the kernel echoes it (each picked edge as a reference with its signature,
 * so a replay after an edit above, or a variable that moves the part, finds the same edge rather than whatever has
 * its old index), and a transition the kernel found all lips as one.
 */
export function storedOp(op: ModelOp, reply: Record<string, unknown>): ModelOp {
  const echo = reply.op && typeof reply.op === "object" ? reply.op as ModelOp : null;
  const blended = (op.kind === "fillet" || op.kind === "chamfer") && echo?.kind === op.kind ? { ...echo, ...(op.exprs ? { exprs: op.exprs } : {}) } : op;
  // --- Print transitions, step 4: a step the kernel found all lips is stored as one, as the app stores the echo.
  return op.kind === "transition" && echo?.kind === "transition" && echo.case && !op.case ? { ...op, case: echo.case } : blended;
}

/**
 * A step the kernel applied but that is not what it meant: a fuse that lost the part, a cut that took more than its
 * tool, a step that lost most of the volume, or a Boolean that left pieces meeting along an edge.
 */
export function stepGuard(op: ModelOp, prior: SolidView | null, after: SolidView | null, pose: Affine): { reason: string; touching?: true } | null {
  if (!prior || !after) return null;
  const box = op.kind === "boolean" ? primitiveBox(op) : null;
  const lost = lostVolume(op as { kind: string; op?: string }, prior.volumeMm3, after.volumeMm3, box);
  if (lost) return { reason: lost };
  if (box) {
    const was = touchingEdges(prior.positions, box);
    const now = touchingEdges(after.positions, box);
    if (now.count > was.count) return { reason: touchingReason(now.at ? applyPose(pose, now.at).map((v) => Math.round(v * 100) / 100) as [number, number, number] : null), touching: true };
  }
  return null;
}

/** An applied step's reply: its handle, the op as stored and as typed, and what a combined group or cells counted. */
export function appliedReply(node: number, baked: { op: ModelOp; typed: Record<string, unknown> }, reply: Record<string, unknown>, extra: Record<string, unknown> = {}): Record<string, unknown> {
  // --- I19–I20: what a combined group or an extrude of cells did, as the kernel counted it.
  const counted = { ...(reply.cells ? { cells: reply.cells } : {}), ...(reply.combined ? { combined: reply.combined } : {}) };
  return { ok: true, node: nodeHandle(node), ...extra, stored: compactEcho(cleanOp(baked.op as unknown as Record<string, unknown>)), typed: compactEcho(cleanOp(baked.typed)), ...turnEcho(baked.typed), ...counted };
}

/**
 * --- D24. The workplane in model space, where ops are typed. It is stored in the part's own frame, as the app and the
 * file keep it, so it moves with the part when it is placed. Global is model space itself, on any pose.
 */
export function typedPlaneOf(own: Workplane, pose: Affine): Workplane {
  if (isIdentity(pose) || isGlobalFrame(own)) return own;
  return workplaneIn(own, pose);
}

/**
 * What composite ops and face selectors read of a part: its faces' frames and the typed workplane. A moved part is read
 * in model space, as the app reads it, since every op goes through toSolidOp once; the posed mesh and its face frames
 * are kept per solid and pose (posedContext), so a batch reads them once.
 */
export function partExpandContext(solid: SolidView | null, pose: Affine, own: Workplane): ExpandContext {
  if (solid && !isIdentity(pose)) return { ...posedContext(solid, pose), plane: typedPlaneOf(own, pose) };
  // --- A3 composite features: one context builder for the session and the panel. ---
  return expandContextFromSolid(
    solid ? { positions: solid.positions, triangles: solid.triangles, faces: solid.faces as FrameFace[] } : null,
    own,
    {
      matchFaces: (faces, input) => facesMatching(faces as Parameters<typeof facesMatching>[0], input),
      stand: (positions, frame, depth, overlap) => standRegion(positions as Float32Array, frame, depth, overlap),
      closeCracks,
    },
  );
}

/**
 * section on a solid (I5-I7, R-B): a flat face's outline inset by insetMm, or the part cut by `cuts`, each read exactly
 * by the kernel through `call` (which adds the tree's key and the shown step), in each plane's frame with the extrude
 * origin and turn that draw in it. The kernel reads the solid in its own frame; the answer names the frame the part's
 * numbers are typed in.
 */
export async function solidSections(input: Record<string, unknown>, chordMm: number, cuts: CutPlane[] | null, pose: Affine, ctx: ExpandContext, call: (request: Record<string, unknown>) => Promise<Record<string, unknown>>): Promise<{ sections: Record<string, unknown>[]; extra: Record<string, unknown> } | { reason: string }> {
  const restate = (reply: Record<string, unknown>, plane: Workplane, cut?: CutPlane): Record<string, unknown> => {
    const { id: _id, face: _face, frame: _frame, origin: _origin, turn: _turn, ...rest } = reply;
    return {
      ...(cut ? { plane: { origin: cut.origin, normal: cut.normal } } : {}),
      frame: frameOf(plane),
      origin: frameOf(plane).origin,
      turn: plane.turn.map((n) => Math.round(n * 1e6) / 1e6),
      ...rest,
    };
  };
  if (!cuts) {
    const index = typeof input.face === "number" ? input.face : input.face && typeof input.face === "object" ? ctx.faceBy(input.face as Record<string, unknown>) : { reason: "face is an index or {normal, nearPoint}." };
    if (typeof index !== "number") return { reason: index.reason };
    const framed = ctx.face(index);
    if ("reason" in framed) return { reason: framed.reason };
    const own = workplaneOwn(framed.plane, pose);
    const reply = await call({ call: "faceOutline", face: index, insetMm: typeof input.insetMm === "number" ? input.insetMm : 0, chordMm, frame: frameNumbers(own) });
    if (typeof reply.error === "string" && reply.error) return { reason: plainModelError(reply.error) };
    return { sections: [restate(reply, framed.plane)], extra: { face: index } };
  }
  const sections: Record<string, unknown>[] = [];
  for (const [index, cut] of cuts.entries()) {
    const own = workplaneOwn(cut.plane, pose);
    const normal = axesOf(own)[2];
    const reply = await call({ call: "section", origin: own.origin, normal, frame: frameNumbers(own), chordMm });
    if (typeof reply.error === "string" && reply.error) return { reason: `Plane ${index + 1}: ${plainModelError(reply.error)}` };
    sections.push(restate(reply, cut.plane, cut));
  }
  return { sections, extra: {} };
}

/** A model-space point in the workplane's frame, the frame a part's ops are typed in. */
export function typedPointIn(plane: Workplane, p: [number, number, number]): [number, number, number] {
  if (isGlobalFrame(plane)) return p;
  const m = eulerOrient(plane.turn[0], plane.turn[1], plane.turn[2]);
  const d = [p[0] - plane.origin[0], p[1] - plane.origin[1], p[2] - plane.origin[2]];
  return [0, 1, 2].map((c) => m[c]! * d[0]! + m[3 + c]! * d[1]! + m[6 + c]! * d[2]!) as [number, number, number];
}

/** An edit's built steps: each step's op as the kernel stored it and its fingerprint, by id. */
export function readBuilt(value: unknown): Map<number, { op: ModelOp; fingerprint: Fingerprint | null }> | null {
  if (!Array.isArray(value)) return null;
  const out = new Map<number, { op: ModelOp; fingerprint: Fingerprint | null }>();
  for (const step of value) {
    if (!step || typeof step !== "object") return null;
    const row = step as { id?: unknown; op?: unknown; fingerprint?: unknown };
    const kind = row.op && typeof row.op === "object" ? (row.op as { kind?: unknown }).kind : undefined;
    if (typeof row.id !== "number" || typeof kind !== "string") return null;
    out.set(row.id, { op: row.op as ModelOp, fingerprint: readFingerprint(row.fingerprint) });
  }
  return out;
}

/** The step an edit could not build, and why. */
export function readBroken(value: unknown): { id: number; error: string } | null {
  if (!value || typeof value !== "object") return null;
  const row = value as { id?: unknown; error?: unknown };
  return typeof row.id === "number" && typeof row.error === "string" ? { id: row.id, error: row.error } : null;
}
