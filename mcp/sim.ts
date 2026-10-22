/**
 * Stress tools. A generated beam is solved by the `lime-sim` binary, which is
 * the same factorisation as the Rust tests. An STL or STEP with a printer is
 * solved in-process by the engine's `simStudy`. A sweep does not slice.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { MaterialCard } from "../src/sim/cards.ts";
import { NOT_HELD, PROVISIONAL_SENTENCE } from "../src/sim/label.ts";
import {
  constraintVerdict,
  type ConstraintLimits,
  type ObjectStudy,
  type SimPatternName,
  type SimRepresentation,
  type StudyHold,
  type StudyLoad,
  type Vec3,
} from "../src/sim/study.ts";

export const SWEEP_CAP = 16;
export const SWEEP_REFUSAL = "A sweep takes up to 16 variants.";
export const OPEN_MESH = "This mesh is open, so it has no interior to mesh.";
/** What a test stand-in answers when a sliced study asks it to solve. */
export const SOLVER_STAND_IN = "The stress solver is not in this stand-in.";
export const SLICED_SWEEP = "A sliced study sweeps by reslicing: pass reslice true. Each variant is then a slice plus a solve.";
export const RESLICE_BEAM = "reslice is for a sliced study. A generated beam's sweep does not slice.";
export const RESLICE_PARAMETERS = "A resliced sweep varies walls, infill, pattern and load. Change a model parameter with model_params, then sim_run.";
export const RESLICE_PATTERN_KEEP = "A pattern variant is the plate's blend, so it is not kept per object. Set the blend with settings_set, then sim_run.";
export const SLICED_FIELD = "A sliced result has no paged field. Read the margins from sim_run.";
export const TET4_REFUSAL = "This study uses quadratic tetrahedra. Linear tetrahedra lock in bending.";
export const ZERO_AXIS = "The build direction has zero length.";
export const BEAM_SIZE = "The beam length and the edge length have to be positive.";
export { PROVISIONAL_SENTENCE, NOT_HELD, constraintVerdict };
export type { ConstraintLimits };

const PATTERNS = new Set<SimPatternName>(["lines", "grid", "gyroid", "lightning"]);

/**
 * `sliced` for an STL or STEP once a printer is chosen. A generated beam stays
 * a smear, and so does a part with no printer, a 3mf, or an explicit smear.
 */
export function representationOf(input: {
  asked?: SimRepresentation;
  beam?: boolean;
  printerId?: string;
  fileName?: string;
}): SimRepresentation {
  if (input.asked) return input.asked;
  if (input.beam) return "smear";
  if (!input.printerId) return "smear";
  const name = input.fileName ?? "";
  if (/\.(stl|step|stp)$/i.test(name)) return "sliced";
  return "smear";
}

/** The checkout's `lime-sim` binary: the release build when there is one, else the debug build. */
export function solverPath(): string {
  const exe = process.platform === "win32" ? "lime-sim.exe" : "lime-sim";
  const built = ["release", "debug"].map((profile) => fileURLToPath(new URL(`../target/${profile}/${exe}`, import.meta.url)));
  return built.find((path) => existsSync(path)) ?? built[1]!;
}

export function boxPositions(length: number, width: number, height: number): Float32Array {
  const out: number[] = [];
  const quad = (a: number[], b: number[], c: number[], d: number[]) => {
    out.push(...a, ...b, ...c, ...a, ...c, ...d);
  };
  const p = (x: number, y: number, z: number) => [x, y, z];
  const x1 = length;
  const y1 = width;
  const z1 = height;
  quad(p(0, 0, 0), p(x1, 0, 0), p(x1, y1, 0), p(0, y1, 0));
  quad(p(0, 0, z1), p(0, y1, z1), p(x1, y1, z1), p(x1, 0, z1));
  quad(p(0, 0, 0), p(0, 0, z1), p(x1, 0, z1), p(x1, 0, 0));
  quad(p(0, y1, 0), p(x1, y1, 0), p(x1, y1, z1), p(0, y1, z1));
  quad(p(0, 0, 0), p(0, y1, 0), p(0, y1, z1), p(0, 0, z1));
  quad(p(x1, 0, 0), p(x1, 0, z1), p(x1, y1, z1), p(x1, y1, 0));
  return Float32Array.from(out);
}

export function elementRefusal(element: unknown): string | null {
  if (element === undefined || element === "tet10") return null;
  if (element === "tet4") return TET4_REFUSAL;
  return `${String(element)} is not in this version.`;
}

export function axisLength(axis: Vec3): number {
  return Math.hypot(axis[0], axis[1], axis[2]);
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function vec3(value: unknown): Vec3 | null {
  if (!Array.isArray(value) || value.length !== 3 || !value.every(finite)) return null;
  return [value[0], value[1], value[2]];
}

export interface SweepPatch {
  parameters?: Record<string, unknown>;
  walls?: number;
  infill?: number;
  pattern?: SimPatternName;
  loadScale?: number;
}

export function readPatch(value: unknown): SweepPatch | string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "A variant is an object.";
  const row = value as Record<string, unknown>;
  const patch: SweepPatch = {};
  if (row.parameters !== undefined) {
    if (!row.parameters || typeof row.parameters !== "object" || Array.isArray(row.parameters)) return "parameters must be an object of names.";
    patch.parameters = row.parameters as Record<string, unknown>;
  }
  if (row.walls !== undefined) {
    if (!Number.isInteger(row.walls) || (row.walls as number) < 1 || (row.walls as number) > 12) return "Walls are 1 to 12.";
    patch.walls = row.walls as number;
  }
  if (row.infill !== undefined) {
    if (!finite(row.infill) || row.infill < 0 || row.infill > 1) return "Infill is 0 to 1.";
    patch.infill = row.infill;
  }
  if (row.pattern !== undefined) {
    if (typeof row.pattern !== "string" || !PATTERNS.has(row.pattern as SimPatternName)) {
      return `${String(row.pattern)} is not in this version.`;
    }
    patch.pattern = row.pattern as SimPatternName;
  }
  if (row.loadScale !== undefined) {
    if (!finite(row.loadScale) || row.loadScale <= 0) return "The load scale has to be positive.";
    patch.loadScale = row.loadScale;
  }
  return patch;
}

export function readLimits(value: unknown): ConstraintLimits | string {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return "Constraints are an object.";
  const row = value as Record<string, unknown>;
  const out: ConstraintLimits = {};
  for (const key of ["maxDeflectionMm", "minSafetyFactor", "maxMassG", "minMassG"] as const) {
    if (row[key] === undefined) continue;
    if (!finite(row[key]) || (row[key] as number) <= 0) return `${key} has to be positive.`;
    out[key] = row[key] as number;
  }
  return out;
}

export function setupSentence(study: ObjectStudy, polymer: string, provisional: boolean): string {
  const faces = study.holds.find((hold) => hold.kind === "faces" && hold.faces.length > 0);
  const bed = study.holds.some((hold) => hold.kind === "bed");
  const plane = study.holds.some((hold) => hold.kind === "plane");
  const held = faces
    ? faces.faces.length === 1 ? "Held 1 face" : `Held ${faces.faces.length} faces`
    : bed ? "Held the bed" : plane ? "Held a plane" : "Nothing is held";
  const load = study.loads[0];
  const face = load?.faces[0];
  const where = face === undefined ? "" : ` on face ${face}`;
  const loadBit = !load ? "" : load.kind === "pressure" ? `, ${load.magnitude} MPa${where}` : `, ${load.magnitude} N${where}`;
  const cardBit = polymer ? `, ${provisional ? "provisional " : ""}${polymer}` : "";
  return `${held}${loadBit}${cardBit}.`;
}

export function scaleLoads(loads: StudyLoad[], scale: number): StudyLoad[] {
  return loads.map((load) => ({ ...load, faces: [...load.faces], direction: [...load.direction] as Vec3, magnitude: load.magnitude * scale }));
}

interface SolverHold {
  kind: "bed" | "faces" | "plane";
  faces?: number[];
  normal?: Vec3;
  origin?: Vec3;
}

function solverHold(hold: StudyHold): SolverHold {
  if (hold.kind === "bed") return { kind: "bed" };
  if (hold.kind === "plane" && hold.normal && hold.origin) return { kind: "plane", normal: hold.normal, origin: hold.origin };
  return { kind: "faces", faces: hold.faces };
}

export interface SolverRequest {
  op: "run" | "field";
  study: ObjectStudy;
  card: MaterialCard;
  loadScale?: number;
  walls?: number;
  infill?: number;
  pattern?: SimPatternName;
  field?: string;
  points?: Vec3[];
  box?: { min: Vec3; max: Vec3 };
  face?: number;
  stride?: number;
  limit?: number;
  cursor?: number;
}

export function solverJob(request: SolverRequest): Record<string, unknown> | { reason: string } {
  const beam = request.study.beam;
  if (!beam) return { reason: OPEN_MESH };
  if (!(beam.lengthMm > 0) || !(beam.widthMm > 0) || !(beam.heightMm > 0) || !(request.study.edgeMm > 0)) return { reason: BEAM_SIZE };
  if (axisLength(request.study.buildAxis) <= 1e-12) return { reason: ZERO_AXIS };
  const scale = request.loadScale ?? 1;
  if (!(scale > 0)) return { reason: "The load scale has to be positive." };
  return {
    op: request.op,
    length: beam.lengthMm,
    width: beam.widthMm,
    height: beam.heightMm,
    edge: request.study.edgeMm,
    holds: request.study.holds.map(solverHold),
    loads: scaleLoads(request.study.loads, scale).map((load) => ({
      kind: load.kind,
      faces: load.faces,
      magnitude: load.magnitude,
      direction: load.direction,
    })),
    card: request.card,
    buildAxis: request.study.buildAxis,
    gravity: request.study.gravity,
    ...(request.walls !== undefined ? { walls: request.walls } : {}),
    ...(request.infill !== undefined ? { infill: request.infill } : {}),
    ...(request.pattern ? { pattern: request.pattern } : {}),
    loadScale: 1,
    ...(request.field ? { field: request.field } : {}),
    ...(request.points ? { points: request.points } : {}),
    ...(request.box ? { box: request.box } : {}),
    ...(request.face !== undefined ? { face: request.face } : {}),
    ...(request.stride !== undefined ? { stride: request.stride } : {}),
    ...(request.limit !== undefined ? { limit: request.limit } : {}),
    ...(request.cursor !== undefined ? { cursor: request.cursor } : {}),
  };
}

export function runSolver(job: Record<string, unknown>): Record<string, unknown> {
  const bin = solverPath();
  const child = spawnSync(bin, [], {
    input: JSON.stringify(job),
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (child.error && (child.error as NodeJS.ErrnoException).code === "ENOENT") {
    return { ok: false, reason: "The stress solver is not built." };
  }
  const text = child.stdout?.trim() ?? "";
  if (child.status !== 0 && !text) return { ok: false, reason: "The stress solver did not finish." };
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    // The binary writes one JSON object. Anything else is a crash.
  }
  return { ok: false, reason: "The stress solver did not finish." };
}

export function pageLimit(value: unknown): number {
  const size = typeof value === "number" ? value : 20;
  return Math.min(100, Math.max(1, Math.floor(size)));
}

export function pageCursor(value: unknown): number {
  const start = typeof value === "string" ? Number(value) : typeof value === "number" ? value : 0;
  return Number.isInteger(start) && start > 0 ? start : 0;
}

export function vec3Of(value: unknown): Vec3 | null {
  return vec3(value);
}
