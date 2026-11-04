/**
 * --- Recipe API 1.2: values a person picks (docs/plan-recipe-plugins.md, "API 1.2"). A `face` parameter names a flat
 * face of the part; an `outline` parameter a closed region from a sketch, a face's outline, or loops. The recipe asks
 * for one with the host's own `pick` call; this answers it the same way for the MCP session and the app, reading the
 * part through the run's own answers (`PickReads`).
 *
 * What is kept: a face as `{normal, nearPoint, areaMm2}`, found again on each run as the flat face with that normal
 * under that point (the nearest along the normal), so it survives a change to the steps before it. An index the MCP passes
 * is kept as that reference. A rule (`largest_up`) is the parameter's default and is never kept. An outline keeps
 * `{sketch, object?}` and `{face, object?, insetMm?}` (read again each run) or `{loops, origin?, turn?}` (as given);
 * `{data}` is read once and kept as its loops, so the project needs no file.
 */
import { pointTriangleDistance } from "../modeling/frames.ts";
import { frameOf } from "../modeling/sections.ts";
import type { FaceRow } from "../modeling/solid-geometry.ts";
import { readLoopsField } from "../modeling/bake.ts";
import { sampleLoopPoints, lineLoop } from "../sketch/loops.ts";
import { typedPlaneOf } from "../modeling/model-calls.ts";
import type { Affine } from "../model-space.ts";
import type { ModelTree, ProfileLoop, Vec2 } from "../model-tree.ts";
import type { Workplane } from "../workplane.ts";
import type { RecipeReply } from "./host.ts";

type Vec3 = [number, number, number];
type Body = Record<string, unknown>;

/** The rules a face parameter may default to (`lime_recipe::FACE_RULES`). */
export const FACE_RULES = ["largest", "largest_up", "largest_down", "top", "bottom"] as const;

/** A face as it is kept: its outward normal, a point on it, and its area when picked. */
export interface FaceValue {
  normal: Vec3;
  nearPoint: Vec3;
  areaMm2?: number;
}

/** What a run reads to answer a pick. */
export interface PickReads {
  /** A part's faces as faces_find reads them, with its mesh for distances; or why it cannot be read. */
  faces(object: string): Promise<{ faces: readonly FaceRow[]; positions?: ArrayLike<number>; triangles?: ArrayLike<number> } | { reason: string }>;
  /** section {face, insetMm} on that part, as the run answers it. */
  section(object: string, args: Body): Promise<Body>;
  /** The loops and plane (the part's typed frame) of the sketch on a step of that part. */
  sketch(object: string, step: number): { loops: ProfileLoop[]; plane: Workplane } | { reason: string };
  /** data {name}, where the run can read recipe data. */
  data?(name: string): Promise<{ value: unknown } | { reason: string }>;
  /**
   * The part's faces as the caller saw them when it named a face by index: a rebuild runs from the step before the
   * plugin's run, whose faces are numbered otherwise than the shown step's that `faces_find` listed. Absent, an index
   * names a face of the part the run starts from.
   */
  shownFaces?(object: string): FaceSet | null;
}

const round = (n: number, k = 1e4) => Math.round(n * k) / k;
const roundV = (v: readonly number[]): Vec3 => [round(v[0]!), round(v[1]!), round(v[2]!)];

function vec3(value: unknown): Vec3 | null {
  if (!Array.isArray(value) || value.length < 3 || !value.slice(0, 3).every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  return [value[0], value[1], value[2]];
}

function isRecord(value: unknown): value is Body {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function unit(v: Vec3): Vec3 | null {
  const len = Math.hypot(v[0], v[1], v[2]);
  return len < 1e-12 ? null : [v[0] / len, v[1] / len, v[2] / len];
}

/** Whether `value` is a kept face, rule or outline (an object a stamp, a preset or a form may hold as a value). */
export function isPickValue(value: unknown): value is Body {
  return isRecord(value) && (("normal" in value && "nearPoint" in value) || "rule" in value || "sketch" in value || "face" in value || "loops" in value || "data" in value);
}

/** Why `value` is not a value of a `face` or `outline` parameter, or null when it is (the shape only). */
export function pickProblem(kind: "face" | "outline", value: unknown, label: string): string | null {
  if (kind === "face") {
    if (typeof value === "number") return Number.isInteger(value) && value >= 0 ? null : `${label} is a face index (0 or more), or {normal, nearPoint}.`;
    if (!isRecord(value)) return `${label} is a face: an index, or {normal, nearPoint}.`;
    if (typeof value.rule === "string") return (FACE_RULES as readonly string[]).includes(value.rule) ? null : `${label}'s rule is one of ${FACE_RULES.join(", ")}.`;
    if (!vec3(value.normal) || !vec3(value.nearPoint)) return `${label} is a face: an index, or {normal, nearPoint} with three numbers each.`;
    return null;
  }
  if (!isRecord(value)) return `${label} is an outline: {sketch}, {face}, {loops}, or {data}.`;
  if (value.sketch !== undefined) return stepOf(value.sketch) === null ? `${label}'s sketch is a step id, such as 4 or "node_4".` : null;
  if (value.face !== undefined) return pickProblem("face", value.face, `${label}'s face`);
  if (value.loops !== undefined) {
    const read = readLoopsField(value.loops);
    return "reason" in read ? `${label}: ${read.reason}` : null;
  }
  if (value.data !== undefined) return typeof value.data === "string" && value.data ? null : `${label}'s data is the name of recipe data.`;
  return `${label} is an outline: {sketch}, {face}, {loops}, or {data}.`;
}

/** A step id as a value names it: a number, or a handle `node_4`. */
export function stepOf(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  const m = typeof value === "string" ? /^(?:node_)?(\d+)$/.exec(value) : null;
  return m ? Number(m[1]) : null;
}

/** One line for a picked value: what the form and `plugin get` show. */
export function pickText(value: unknown): string {
  if (typeof value === "number") return `face ${value}`;
  if (!isRecord(value)) return "none";
  if (typeof value.rule === "string") {
    const facing = vec3(value.facing);
    return facing ? `${value.rule.replace("_", " ")} facing ${facing.join(", ")}` : value.rule.replace("_", " ");
  }
  const normal = vec3(value.normal);
  if (normal) return `face facing ${axisWord(normal)}`;
  const where = typeof value.object === "string" ? ` of ${value.object}` : "";
  if (value.sketch !== undefined) return `sketch on step ${stepOf(value.sketch) ?? "?"}${where}`;
  if (value.face !== undefined) return `outline of the ${pickText(value.face)}${where}`;
  if (Array.isArray(value.loops)) return `${value.loops.length} loop${value.loops.length === 1 ? "" : "s"}`;
  if (typeof value.data === "string") return `data ${value.data}`;
  return "none";
}

/** A direction in words: `+Z`, or the numbers when it is not along an axis. */
export function axisWord(n: readonly number[]): string {
  const names = ["X", "Y", "Z"];
  for (let axis = 0; axis < 3; axis += 1) {
    if (Math.abs(Math.abs(n[axis]!) - 1) < 1e-3) return `${n[axis]! > 0 ? "+" : "−"}${names[axis]}`;
  }
  return n.map((v) => round(v, 1e3)).join(", ");
}

type FaceSet = { faces: readonly FaceRow[]; positions?: ArrayLike<number>; triangles?: ArrayLike<number> };

/** A point on face `index`: the centre of its triangle nearest the face's centre (the centre can lie off an L-shaped face). */
function pointOn(set: FaceSet, face: FaceRow): Vec3 {
  const { positions, triangles } = set;
  if (!positions || !triangles) return face.centre;
  let best: Vec3 = face.centre;
  let gap = Infinity;
  const count = Math.min(triangles.length, Math.floor(positions.length / 9));
  for (let tri = 0; tri < count; tri += 1) {
    if (triangles[tri] !== face.index) continue;
    const at = tri * 9;
    const c: Vec3 = [0, 1, 2].map((k) => (positions[at + k]! + positions[at + 3 + k]! + positions[at + 6 + k]!) / 3) as Vec3;
    const d = Math.hypot(c[0] - face.centre[0], c[1] - face.centre[1], c[2] - face.centre[2]);
    if (d < gap) {
      gap = d;
      best = c;
    }
  }
  return best;
}

/** Face `index` as it is kept: its normal, a point on it and its area. Null when it is not a flat face of the part. */
export function faceValueOf(set: FaceSet, index: number): FaceValue | null {
  const face = set.faces.find((row) => row.index === index);
  if (!face || face.kind !== "plane" || !face.normal) return null;
  const n = unit(face.normal);
  if (!n) return null;
  return { normal: roundV(n), nearPoint: roundV(pointOn(set, face)), areaMm2: round(face.areaMm2, 100) };
}

const UP: Vec3 = [0, 0, 1];

function facingWithin(face: FaceRow, dir: Vec3, deg = 5): boolean {
  const n = face.normal ? unit(face.normal) : null;
  const d = unit(dir);
  if (!n || !d) return false;
  return n[0] * d[0] + n[1] * d[1] + n[2] * d[2] >= Math.cos((deg * Math.PI) / 180);
}

/**
 * The face a value names on the part as it stands: its index and what is kept of it. `label` names the parameter in a
 * refusal. A kept face is found again as the flat face with its normal (within 5°) under the kept point, the nearest
 * along the normal when several are: an earlier step may move it along its normal or grow it, and it is still the face.
 * It is gone when no such face lies under the point (half a millimetre of slack).
 */
export function resolveFace(set: FaceSet, value: unknown, label: string): { index: number; kept: FaceValue; rule: boolean } | { reason: string } {
  const flat = set.faces.filter((face) => face.kind === "plane" && face.normal);
  if (typeof value === "number") {
    const kept = Number.isInteger(value) ? faceValueOf(set, value) : null;
    if (!kept) return { reason: `${label}: face ${value} is not a flat face of this part. Pick a flat face.` };
    return { index: value, kept, rule: false };
  }
  if (!isRecord(value)) return { reason: `${label} needs a face. Pick a flat face of the part.` };
  if (typeof value.rule === "string") {
    const rule = value.rule;
    const facing = vec3(value.facing);
    const larger = (a: FaceRow, b: FaceRow) => b.areaMm2 - a.areaMm2 || a.index - b.index;
    let rows: FaceRow[];
    if (rule === "largest") rows = flat.filter((f) => !facing || facingWithin(f, facing)).sort(larger);
    else if (rule === "largest_up" || rule === "largest_down") rows = flat.filter((f) => facingWithin(f, rule === "largest_up" ? UP : [0, 0, -1])).sort(larger);
    else if (rule === "top" || rule === "bottom") {
      const sign = rule === "top" ? 1 : -1;
      rows = flat.filter((f) => facingWithin(f, [0, 0, sign])).sort((a, b) => sign * (b.centre[2] - a.centre[2]) || larger(a, b));
    } else return { reason: `${label}'s rule is one of ${FACE_RULES.join(", ")}.` };
    const first = rows[0];
    const kept = first ? faceValueOf(set, first.index) : null;
    if (!first || !kept) return { reason: `${label}: this part has no flat face for the rule ${pickText(value)}. Pick a face.` };
    return { index: first.index, kept, rule: true };
  }
  const normal = vec3(value.normal);
  const near = vec3(value.nearPoint);
  if (!normal || !near) return { reason: `${label} is a face: an index, or {normal, nearPoint}.` };
  // The flat faces with the kept normal (within 5°) that lie under the kept point, nearest along the normal first.
  const under = flat
    .filter((face) => facingWithin(face, normal))
    .map((face) => {
      const n = unit(face.normal!)!;
      const off = (near[0] - face.centre[0]) * n[0] + (near[1] - face.centre[1]) * n[1] + (near[2] - face.centre[2]) * n[2];
      const onPlane: Vec3 = [near[0] - off * n[0], near[1] - off * n[1], near[2] - off * n[2]];
      return { face, n, off, onPlane, across: acrossFace(set, face, onPlane) };
    })
    .filter((row) => row.across <= ACROSS_MM)
    .sort((x, y) => Math.abs(x.off) - Math.abs(y.off) || x.across - y.across);
  const first = under[0];
  if (!first) {
    return { reason: `The face picked for ${label} (facing ${axisWord(normal)}, near ${near.map((v) => round(v, 100)).join(", ")}) is no longer on the part. Pick it again; the part is kept as it was.` };
  }
  // The point follows the face when an earlier step moved it along its normal.
  return { index: first.face.index, kept: { normal: roundV(first.n), nearPoint: roundV(first.onPlane), areaMm2: round(first.face.areaMm2, 100) }, rule: false };
}

/** How far a point in a face's plane lies from the face itself, mm: 0 inside it. The face's box stands in without a mesh. */
const ACROSS_MM = 0.5;
function acrossFace(set: FaceSet, face: FaceRow, p: Vec3): number {
  const { positions, triangles } = set;
  if (!positions || !triangles) {
    let sum = 0;
    for (let axis = 0; axis < 3; axis += 1) {
      const gap = p[axis]! < face.bbox.min[axis]! ? face.bbox.min[axis]! - p[axis]! : p[axis]! > face.bbox.max[axis]! ? p[axis]! - face.bbox.max[axis]! : 0;
      sum += gap * gap;
    }
    return Math.sqrt(sum);
  }
  let best = Infinity;
  const count = Math.min(triangles.length, Math.floor(positions.length / 9));
  for (let tri = 0; tri < count; tri += 1) {
    if (triangles[tri] !== face.index) continue;
    const at = tri * 9;
    const d = pointTriangleDistance(p, [positions[at]!, positions[at + 1]!, positions[at + 2]!], [positions[at + 3]!, positions[at + 4]!, positions[at + 5]!], [positions[at + 6]!, positions[at + 7]!, positions[at + 8]!]);
    if (d < best) best = d;
  }
  return best;
}

/** Even-odd nesting of sampled loops: each outer with the holes directly inside it, and the net area. */
function regionsOf(rings: Vec2[][]): { regions: { outer: Vec2[]; holes: Vec2[][] }[]; areaMm2: number } {
  const areaOf = (pts: Vec2[]) => {
    let a = 0;
    for (let i = 0; i < pts.length; i += 1) {
      const p = pts[i]!;
      const q = pts[(i + 1) % pts.length]!;
      a += p[0] * q[1] - q[0] * p[1];
    }
    return a / 2;
  };
  const inside = (pt: Vec2, poly: Vec2[]) => {
    let hit = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i, i += 1) {
      const a = poly[i]!;
      const b = poly[j]!;
      if (a[1] > pt[1] !== b[1] > pt[1] && pt[0] < ((b[0] - a[0]) * (pt[1] - a[1])) / (b[1] - a[1]) + a[0]) hit = !hit;
    }
    return hit;
  };
  const parents = rings.map((ring, i) => rings.map((other, j) => (j !== i && ring.length && inside(ring[0]!, other) ? j : -1)).filter((j) => j >= 0));
  const depth = parents.map((list) => list.length);
  const regions: { outer: Vec2[]; holes: Vec2[][] }[] = [];
  const byOuter = new Map<number, number>();
  let areaMm2 = 0;
  rings.forEach((ring, i) => {
    const size = Math.abs(areaOf(ring));
    areaMm2 += depth[i]! % 2 === 0 ? size : -size;
    if (depth[i]! % 2 === 0) {
      byOuter.set(i, regions.length);
      regions.push({ outer: ring, holes: [] });
    }
  });
  rings.forEach((ring, i) => {
    if (depth[i]! % 2 === 0) return;
    const parent = parents[i]!.find((j) => depth[j] === depth[i]! - 1);
    const at = parent === undefined ? undefined : byOuter.get(parent);
    if (at !== undefined) regions[at]!.holes.push(ring);
  });
  return { regions, areaMm2: round(areaMm2, 1e3) };
}

/** An outline as `section` answers one: the plane's frame, the extrude origin and turn, the loops, the regions, the area. */
export function outlineRow(loops: ProfileLoop[], plane: Workplane): Body {
  const frame = frameOf(plane);
  const rings = loops.map((loop) => sampleLoopPoints(loop).map((p) => [round(p[0], 1e6), round(p[1], 1e6)] as Vec2));
  const { regions, areaMm2 } = regionsOf(rings);
  return { frame, origin: frame.origin, turn: plane.turn.map((n) => round(n, 1e6)), loops, regions, areaMm2 };
}

/**
 * The sketch on step `step` of a part's tree: an extrude's or a revolve's loops (or its point profile as one loop), on
 * its plane in the part's typed frame (`pose` maps the solid's own frame, where ops are stored, to it).
 */
export function sketchOutline(tree: ModelTree, step: number, pose: Affine): { loops: ProfileLoop[]; plane: Workplane } | { reason: string } {
  const node = tree.nodes.get(step);
  if (!node) return { reason: `this part has no step ${step}.` };
  const op = node.op;
  if (!op || (op.kind !== "extrude" && op.kind !== "revolve")) return { reason: `step ${step} is not a sketch: pick an extrude's or a revolve's step.` };
  const loops = op.loops?.length ? op.loops : op.profile && op.profile.length >= 3 ? [lineLoop(op.profile)] : null;
  if (!loops) return { reason: `step ${step} has no closed outline.` };
  return { loops, plane: typedPlaneOf({ source: "face", origin: op.origin, turn: op.turn }, pose) };
}

/** Loops from recipe data: a `section` answer kept with saveAs (its first section), or a list of [x, y] points. */
function dataOutline(value: unknown): { loops: ProfileLoop[]; origin: Vec3; turn: Vec3 } | null {
  if (isRecord(value) && Array.isArray(value.sections) && isRecord(value.sections[0])) {
    const row = value.sections[0];
    const read = readLoopsField(row.loops);
    if ("reason" in read || !read.loops) return null;
    return { loops: read.loops, origin: vec3(row.origin) ?? [0, 0, 0], turn: vec3(row.turn) ?? [0, 0, 0] };
  }
  if (Array.isArray(value) && value.length >= 3) {
    const pts = value.map((row) => (Array.isArray(row) && typeof row[0] === "number" && typeof row[1] === "number" ? [row[0], row[1]] as Vec2 : isRecord(row) && typeof row.x === "number" && typeof row.y === "number" ? [row.x, row.y] as Vec2 : null));
    if (pts.some((p) => p === null)) return null;
    return { loops: [lineLoop(pts as Vec2[])], origin: [0, 0, 0], turn: [0, 0, 0] };
  }
  return null;
}

/** A default may name only what the recipe's own code can: a rule, loops, or a face by rule. */
function defaultAllowed(value: unknown): boolean {
  if (!isRecord(value)) return value === null || value === undefined;
  if (typeof value.rule === "string") return true;
  if (value.loops !== undefined && value.sketch === undefined && value.data === undefined && value.object === undefined) return true;
  return isRecord(value.face) && typeof value.face.rule === "string" && value.object === undefined;
}

/**
 * The host's `pick` call: `{param, kind, object?, value}`. The value is the one the run was given for `param` when it
 * was given one (never what the recipe sends), else the recipe's default, which may only be a rule or loops. What a
 * given value resolved to is written to `picked`, for the step's stamp: a face index becomes a kept face.
 */
export async function answerPick(args: Body, given: Body, reads: PickReads, picked: Body): Promise<RecipeReply> {
  const param = typeof args.param === "string" ? args.param : "";
  const kind = args.kind === "face" || args.kind === "outline" ? args.kind : null;
  if (!param || !kind) return { ok: false, error: "pick takes {param, kind: face | outline, value}." };
  const isGiven = Object.prototype.hasOwnProperty.call(given, param) && given[param] !== null && given[param] !== undefined;
  const value = isGiven ? given[param] : args.value;
  if (!isGiven && !defaultAllowed(value)) return { ok: false, error: `${param}: a default is a rule or loops; a face or a sketch is picked by the person.` };
  const object = typeof args.object === "string" ? args.object : undefined;
  if (value === null || value === undefined) return { ok: false, error: `${param} needs ${kind === "face" ? "a face. Pick a flat face of the part" : "an outline. Pick a sketch or a face's outline"}.` };
  if (kind === "face") {
    if (!object) return { ok: false, error: `${param} is a face of the part the plugin runs on; pass object.` };
    const faced = await pickFace(reads, object, value, param, 0);
    if ("reason" in faced) return { ok: false, error: faced.reason };
    if (isGiven && !faced.rule) picked[param] = faced.kept;
    return { ok: true, result: { ok: true, object, face: faced.index, normal: faced.kept.normal, nearPoint: faced.kept.nearPoint, areaMm2: faced.kept.areaMm2, sections: [faced.row] } };
  }
  const problem = pickProblem("outline", value, param);
  if (problem) return { ok: false, error: problem };
  const v = value as Body;
  const on = typeof v.object === "string" ? v.object : object;
  if (v.sketch !== undefined) {
    if (!on) return { ok: false, error: `${param} names a sketch on a step; pass object, or name the part in the value.` };
    const sketch = reads.sketch(on, stepOf(v.sketch)!);
    if ("reason" in sketch) return { ok: false, error: `${param}: ${sketch.reason}` };
    return { ok: true, result: { ok: true, sections: [outlineRow(sketch.loops, sketch.plane)] } };
  }
  if (v.face !== undefined) {
    if (!on) return { ok: false, error: `${param} is a face's outline; pass object, or name the part in the value.` };
    const inset = typeof v.insetMm === "number" && Number.isFinite(v.insetMm) ? v.insetMm : 0;
    const faced = await pickFace(reads, on, v.face, param, inset);
    if ("reason" in faced) return { ok: false, error: faced.reason };
    if (isGiven && !faced.rule) picked[param] = { ...v, face: faced.kept };
    return { ok: true, result: { ok: true, face: faced.index, sections: [faced.row] } };
  }
  if (v.data !== undefined) {
    if (!reads.data) return { ok: false, error: `${param}: recipe data is read over MCP. Pick a sketch or a face's outline here.` };
    const got = await reads.data(String(v.data));
    if ("reason" in got) return { ok: false, error: `${param}: ${got.reason}` };
    const read = dataOutline(got.value);
    if (!read) return { ok: false, error: `${param}: the data ${String(v.data)} is not an outline (a section answer kept with saveAs, or [x, y] points).` };
    if (isGiven) picked[param] = read;
    return { ok: true, result: { ok: true, sections: [outlineRow(read.loops, { source: "global", origin: read.origin, turn: read.turn })] } };
  }
  const loops = (readLoopsField(v.loops) as { loops: ProfileLoop[] }).loops;
  return { ok: true, result: { ok: true, sections: [outlineRow(loops, { source: "global", origin: vec3(v.origin) ?? [0, 0, 0], turn: vec3(v.turn) ?? [0, 0, 0] })] } };
}

async function pickFace(reads: PickReads, object: string, value: unknown, label: string, insetMm: number): Promise<{ index: number; kept: FaceValue; rule: boolean; row: Body } | { reason: string }> {
  const set = await reads.faces(object);
  if ("reason" in set) return { reason: `${label}: ${set.reason}` };
  // An index is the shown step's face, as faces_find listed it: kept as a reference, then found on the run's start.
  const shown = typeof value === "number" ? reads.shownFaces?.(object) ?? null : null;
  let named: unknown = value;
  if (shown) {
    const kept = Number.isInteger(value) ? faceValueOf(shown, value as number) : null;
    if (!kept) return { reason: `${label}: face ${String(value)} is not a flat face of this part. Pick a flat face.` };
    named = kept;
  }
  const found = resolveFace(set, named, label);
  if ("reason" in found) return found;
  const reply = await reads.section(object, { object, face: found.index, insetMm });
  const rows = Array.isArray(reply.sections) ? reply.sections : [];
  if (reply.ok === false || !isRecord(rows[0])) return { reason: `${label}: ${String(reply.reason ?? "the face's outline could not be read.")}` };
  return { ...found, row: rows[0] };
}
