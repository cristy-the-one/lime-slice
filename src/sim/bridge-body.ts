/**
 * The JSON `lime_sim_bridge::study_json` reads, and the surface it draws.
 * Points stay in the model frame. Face triangles keep the solid's winding.
 */
import { withBeads, type MaterialCard } from "./cards.ts";
import { LABEL } from "./label.ts";
import {
  boxDiagonal,
  boxOf,
  defaultScale,
  paintField,
  type CannedResult,
  type ObjectStudy,
  type SlicedMargin,
  type StressField,
  type StudyBox,
  type StudyLoad,
  type Vec3,
} from "./study.ts";

export type FaceTriangles = [number, number, number][][];

/** Triangles of `faces`, wound as the solid stores them. */
export function faceTriangles(positions: ArrayLike<number>, triangles: ArrayLike<number>, faces: readonly number[]): FaceTriangles {
  const want = new Set(faces);
  const out: FaceTriangles = [];
  const count = Math.min(triangles.length, Math.floor(positions.length / 9));
  for (let tri = 0; tri < count; tri += 1) {
    if (!want.has(triangles[tri] ?? -1)) continue;
    const at = tri * 9;
    const corner = (offset: number): [number, number, number] => [
      positions[at + offset] ?? 0,
      positions[at + offset + 1] ?? 0,
      positions[at + offset + 2] ?? 0,
    ];
    out.push([corner(0), corner(3), corner(6)]);
  }
  return out;
}

export interface StudyBodyInput {
  request: Record<string, unknown>;
  study: ObjectStudy;
  card: MaterialCard;
  triangles(faces: readonly number[]): FaceTriangles;
  bounds: StudyBox | null;
  /** Multiplies the loads. The solve is linear. */
  loadScale?: number;
  /** Off skips the second cell size. The panel leaves this on. */
  checkResolution?: boolean;
  /** Min safety and max deflection. Empty sends a safety factor of 1, so the worst spot is marked. */
  constraints?: StudyTarget[];
}

/** A target the panel typed. The bridge turns these into margins. */
export interface StudyTarget {
  kind: "minSafetyFactor" | "maxDeflectionMm";
  value: number;
}

/** No target typed: mark the worst spot against a safety factor of 1. */
export function studyConstraints(targets?: readonly StudyTarget[]): StudyTarget[] {
  const rows = (targets ?? []).filter((row) => Number.isFinite(row.value) && row.value > 0);
  if (rows.length === 0) return [{ kind: "minSafetyFactor", value: 1 }];
  return rows.map((row) => ({ kind: row.kind, value: row.value }));
}

const PLANE_HOLD = "A plane hold is not on a sliced study. Hold the bed or faces.";
const NO_SURFACE = "A hold's region touches no surface of the sliced part.";
const NO_LOAD = "Pick a face to load, or type its index.";
const ZERO_DIR = "The load direction has zero length.";

function unitForce(load: StudyLoad, scale: number): Vec3 | { reason: string } {
  const n = Math.hypot(load.direction[0], load.direction[1], load.direction[2]);
  if (!(n > 1e-12)) return { reason: ZERO_DIR };
  const mag = load.magnitude * scale;
  return [load.direction[0] / n * mag, load.direction[1] / n * mag, load.direction[2] / n * mag];
}

/** A thin slab on the +X face, where the arrow sits when no face is chosen. */
function endSlab(bounds: StudyBox): { kind: "box"; min: Vec3; max: Vec3 } {
  const span = Math.max(1e-3, bounds.max[0] - bounds.min[0]);
  const thick = Math.min(1, span * 0.05);
  return {
    kind: "box",
    min: [bounds.max[0] - thick, bounds.min[1], bounds.min[2]],
    max: [bounds.max[0], bounds.max[1], bounds.max[2]],
  };
}

/**
 * `{ request, study }` for the bridge. A refusal is a sentence, not a body.
 */
export function buildStudyBody(input: StudyBodyInput): string | { reason: string } {
  const scale = input.loadScale ?? 1;
  if (!(scale > 0)) return { reason: "The load scale has to be positive." };
  const holds: Record<string, unknown>[] = [];
  for (const hold of input.study.holds) {
    if (hold.kind === "bed") {
      holds.push({ kind: "bed" });
      continue;
    }
    if (hold.kind === "plane") return { reason: PLANE_HOLD };
    const triangles = input.triangles(hold.faces);
    if (triangles.length === 0) return { reason: NO_SURFACE };
    holds.push({ kind: "region", region: { kind: "faces", triangles } });
  }
  if (holds.length === 0) return { reason: "Nothing is held." };
  const loads: Record<string, unknown>[] = [];
  for (const load of input.study.loads) {
    let region: Record<string, unknown>;
    if (load.faces.length === 0) {
      if (!input.bounds) return { reason: NO_LOAD };
      region = endSlab(input.bounds);
    } else {
      const triangles = input.triangles(load.faces);
      if (triangles.length === 0) return { reason: NO_SURFACE };
      region = { kind: "faces", triangles };
    }
    if (load.kind === "pressure") {
      loads.push({ kind: "pressure", region, mpa: load.magnitude * scale });
      continue;
    }
    const force = unitForce(load, scale);
    if ("reason" in force) return force;
    loads.push({ kind: "force", region, force });
  }
  if (loads.length === 0) return { reason: "This study has no load." };
  const study: Record<string, unknown> = {
    ...(input.study.edgeMm > 0 ? { hXy: input.study.edgeMm } : {}),
    card: withBeads(input.card),
    holds,
    loads,
    constraints: studyConstraints(input.constraints),
    checkResolution: input.checkResolution !== false,
  };
  return JSON.stringify({ request: input.request, study });
}

function bytesOf(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

function floatsOf(b64: unknown): Float32Array | null {
  if (typeof b64 !== "string" || b64.length === 0) return null;
  try {
    const bytes = bytesOf(b64);
    if (bytes.byteLength % 4 !== 0) return null;
    return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
  } catch {
    return null;
  }
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function vec3(value: unknown): Vec3 | null {
  if (!Array.isArray(value) || value.length !== 3 || !value.every(finite)) return null;
  return [value[0], value[1], value[2]];
}

function trustOf(value: unknown): CannedResult["trust"] {
  if (value === "rough" || value === "usable" || value === "converged") return value;
  return "rough";
}

function marginsOf(value: unknown): SlicedMargin[] {
  if (!Array.isArray(value)) return [];
  const out: SlicedMargin[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const spot = row.hotSpot && typeof row.hotSpot === "object" ? (row.hotSpot as Record<string, unknown>) : null;
    const at = spot ? vec3(spot.at) : null;
    if (typeof row.kind !== "string" || !finite(row.value) || !finite(row.margin) || typeof row.met !== "boolean" || !at) continue;
    const governs = spot && typeof spot.governs === "string" && spot.governs ? spot.governs : undefined;
    const role = spot && typeof spot.role === "string" && spot.role ? spot.role : undefined;
    out.push({
      kind: row.kind,
      value: row.value,
      margin: row.margin,
      met: row.met,
      ...(typeof row.note === "string" && row.note ? { note: row.note } : {}),
      ...(finite(row.limit) ? { limit: row.limit } : {}),
      ...(role ? { role } : {}),
      ...(governs ? { governs } : {}),
      at,
    });
  }
  return out;
}

/**
 * The bridge reply as the view's result. Corners stay in the order the
 * surface lists them, so a probe reads the nearest one.
 */
export function surfaceResult(text: string, field: StressField, scale?: number): CannedResult | { error: string } {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { error: "The stress solve did not finish." };
  }
  if (!parsed || typeof parsed !== "object") return { error: "The stress solve did not finish." };
  if (parsed.ok !== true) {
    return { error: typeof parsed.reason === "string" && parsed.reason ? parsed.reason : "The stress solve did not finish." };
  }
  const report = parsed.report && typeof parsed.report === "object" ? (parsed.report as Record<string, unknown>) : null;
  const surface = parsed.surface && typeof parsed.surface === "object" ? (parsed.surface as Record<string, unknown>) : null;
  if (!report || !surface) return { error: "The stress solve did not finish." };
  const positions = floatsOf(surface.positionsB64);
  const displacement = floatsOf(surface.displacementB64);
  const vonMises = floatsOf(surface.vonMisesB64);
  const safety = floatsOf(surface.safetyB64);
  if (!positions || !displacement || !vonMises || !safety) return { error: "The stress solve did not finish." };
  const corners = Math.floor(positions.length / 3);
  if (corners < 3 || displacement.length < corners * 3 || vonMises.length < corners || safety.length < corners) {
    return { error: "The slice has no surface to draw." };
  }
  const nodes = [];
  for (let i = 0; i < corners; i += 1) {
    const u: Vec3 = [displacement[i * 3] ?? 0, displacement[i * 3 + 1] ?? 0, displacement[i * 3 + 2] ?? 0];
    nodes.push({
      at: [positions[i * 3] ?? 0, positions[i * 3 + 1] ?? 0, positions[i * 3 + 2] ?? 0] as Vec3,
      u,
      vonMises: vonMises[i] ?? 0,
      displacement: Math.hypot(u[0], u[1], u[2]),
      safety: safety[i] ?? 0,
    });
  }
  const triangles: number[] = [];
  for (let i = 0; i < corners; i += 1) triangles.push(i);
  const box = boxOf(positions);
  const diagonal = box ? boxDiagonal(box) : 1;
  const peakDisp = nodes.reduce((peak, node) => Math.max(peak, node.displacement), 0);
  const notes = Array.isArray(report.notes) ? report.notes.filter((note): note is string => typeof note === "string") : [];
  const result: CannedResult = {
    label: LABEL,
    nodes,
    triangles,
    field,
    scale: scale ?? defaultScale(peakDisp, diagonal),
    peak: 0,
    unit: "",
    trust: trustOf(report.trust),
    trustSentence: notes.join(" "),
    diagonal,
    representation: "sliced",
    notes,
    margins: marginsOf(report.margins),
    maxDisplacementMm: finite(report.maxDisplacementMm) ? report.maxDisplacementMm : peakDisp,
    minSafetyFactor: finite(report.minSafetyFactor) ? report.minSafetyFactor : null,
    massG: finite(report.massG) ? report.massG : 0,
  };
  return paintField(result, field);
}
