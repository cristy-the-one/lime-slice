/**
 * A study on one object, and the canned beam the Model view draws.
 * No DOM. The solver stays in `lime-sim`; this beam is a known field so a
 * click does not wait on a factorisation.
 */
import type { MaterialCard } from "./cards.ts";
import { LABEL, NOT_HELD, PROVISIONAL_SENTENCE } from "./label.ts";

export type Vec3 = [number, number, number];
export type TrustWord = "rough" | "usable" | "converged";
export type StressField = "vonMises" | "displacement" | "safety";

export interface StudyHold {
  kind: "bed" | "faces" | "plane";
  /** Face indexes. Empty when the hold is the bed or a plane. */
  faces: number[];
  /** A typed plane, in the part frame. */
  normal?: Vec3;
  origin?: Vec3;
}

export interface StudyBeam {
  lengthMm: number;
  widthMm: number;
  heightMm: number;
}

export type SimPatternName = "lines" | "grid" | "gyroid" | "lightning";

export interface StudyLoad {
  kind: "force" | "pressure";
  faces: number[];
  /** Newtons, or MPa when `kind` is pressure. */
  magnitude: number;
  direction: Vec3;
}

/** What the plate stores. Absent on an object that has no study. */
export interface ObjectStudy {
  holds: StudyHold[];
  loads: StudyLoad[];
  cardId: string;
  /** The printer's build axis. Off, `buildAxis` is the typed direction. */
  printer: boolean;
  buildAxis: Vec3;
  /** Off unless the user turns it on. */
  gravity: boolean;
  /** Edge length asked for, in millimetres. A later mesher reads it. */
  edgeMm: number;
  /** A generated box. Absent on a study of a real part. */
  beam?: StudyBeam;
  /** Infill pattern for the smear, when a sweep sets one. */
  pattern?: SimPatternName;
}

export interface ConstraintLimits {
  maxDeflectionMm?: number;
  minSafetyFactor?: number;
  maxMassG?: number;
  minMassG?: number;
}

export interface StudyBox {
  min: Vec3;
  max: Vec3;
}

export interface CannedNode {
  /** Rest position in the solid's frame, millimetres. */
  at: Vec3;
  /** Displacement, millimetres, before the view's scale. */
  u: Vec3;
  vonMises: number;
  displacement: number;
  safety: number;
}

/** One margin from a sliced study, with its hot spot in the model frame. */
export interface SlicedMargin {
  kind: string;
  value: number;
  margin: number;
  met: boolean;
  note?: string;
  at: Vec3;
}

export interface CannedResult {
  label: typeof LABEL;
  nodes: CannedNode[];
  /** Triangle corners, three indexes each. */
  triangles: number[];
  field: StressField;
  /** Vertices are drawn at rest + displacement × scale. */
  scale: number;
  peak: number;
  unit: string;
  trust: TrustWord;
  trustSentence: string;
  diagonal: number;
  /** Set when the bridge solved the part as sliced. */
  representation?: "sliced";
  notes?: string[];
  margins?: SlicedMargin[];
  maxDisplacementMm?: number;
  minSafetyFactor?: number | null;
  massG?: number;
}

const BED_MM = 0.05;

export function emptyStudy(): ObjectStudy {
  return {
    holds: [],
    loads: [{ kind: "force", faces: [], magnitude: 10, direction: [0, 0, -1] }],
    cardId: "inhouse-petg",
    printer: true,
    buildAxis: [0, 0, 1],
    gravity: false,
    edgeMm: 5,
  };
}

export function cloneStudy(study: ObjectStudy): ObjectStudy {
  return {
    holds: study.holds.map((hold) => ({
      kind: hold.kind,
      faces: [...hold.faces],
      ...(hold.normal ? { normal: [...hold.normal] as Vec3 } : {}),
      ...(hold.origin ? { origin: [...hold.origin] as Vec3 } : {}),
    })),
    loads: study.loads.map((load) => ({
      kind: load.kind,
      faces: [...load.faces],
      magnitude: load.magnitude,
      direction: [...load.direction] as Vec3,
    })),
    cardId: study.cardId,
    printer: study.printer,
    buildAxis: [...study.buildAxis] as Vec3,
    gravity: study.gravity,
    edgeMm: study.edgeMm,
    ...(study.beam ? { beam: { ...study.beam } } : {}),
    ...(study.pattern ? { pattern: study.pattern } : {}),
  };
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function vec3(value: unknown): Vec3 | null {
  if (!Array.isArray(value) || value.length !== 3 || !value.every(finite)) return null;
  return [value[0] as number, value[1] as number, value[2] as number];
}

function facesOf(value: unknown): number[] | null {
  if (!Array.isArray(value) || !value.every((item) => Number.isInteger(item) && (item as number) >= 0)) return null;
  return [...value] as number[];
}

/** A saved study, or null when the key is damaged and should be left out. */
export function readStudy(value: unknown): ObjectStudy | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (!Array.isArray(row.holds) || !Array.isArray(row.loads)) return null;
  if (typeof row.cardId !== "string" || row.cardId.trim() === "") return null;
  if (typeof row.printer !== "boolean" || typeof row.gravity !== "boolean") return null;
  if (!finite(row.edgeMm) || row.edgeMm <= 0) return null;
  const buildAxis = vec3(row.buildAxis);
  if (!buildAxis) return null;
  const holds: StudyHold[] = [];
  for (const item of row.holds) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const hold = item as Record<string, unknown>;
    if (hold.kind !== "bed" && hold.kind !== "faces" && hold.kind !== "plane") return null;
    const faces = facesOf(hold.faces ?? []);
    if (!faces) return null;
    if (hold.kind === "plane") {
      const normal = vec3(hold.normal);
      const origin = vec3(hold.origin);
      if (!normal || !origin) return null;
      holds.push({ kind: "plane", faces, normal, origin });
      continue;
    }
    holds.push({ kind: hold.kind, faces });
  }
  const loads: StudyLoad[] = [];
  for (const item of row.loads) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const load = item as Record<string, unknown>;
    if (load.kind !== "force" && load.kind !== "pressure") return null;
    const faces = facesOf(load.faces);
    const direction = vec3(load.direction);
    if (!faces || !direction || !finite(load.magnitude)) return null;
    loads.push({ kind: load.kind, faces, magnitude: load.magnitude, direction });
  }
  const patterns = new Set(["lines", "grid", "gyroid", "lightning"]);
  let pattern: SimPatternName | undefined;
  if (row.pattern !== undefined) {
    if (typeof row.pattern !== "string" || !patterns.has(row.pattern)) return null;
    pattern = row.pattern as SimPatternName;
  }
  let beam: StudyBeam | undefined;
  if (row.beam !== undefined) {
    if (!row.beam || typeof row.beam !== "object" || Array.isArray(row.beam)) return null;
    const box = row.beam as Record<string, unknown>;
    if (!finite(box.lengthMm) || !finite(box.widthMm) || !finite(box.heightMm)) return null;
    if ((box.lengthMm as number) <= 0 || (box.widthMm as number) <= 0 || (box.heightMm as number) <= 0) return null;
    beam = { lengthMm: box.lengthMm as number, widthMm: box.widthMm as number, heightMm: box.heightMm as number };
  }
  return {
    holds,
    loads,
    cardId: row.cardId,
    printer: row.printer,
    buildAxis,
    gravity: row.gravity,
    edgeMm: row.edgeMm,
    ...(beam ? { beam } : {}),
    ...(pattern ? { pattern } : {}),
  };
}

/** Nothing is fixed: the rigid-body refusal. */
export function holdRefusal(study: ObjectStudy): string | null {
  const held = study.holds.some((hold) => hold.kind === "bed" || hold.kind === "plane" || hold.faces.length > 0);
  return held ? null : NOT_HELD;
}

export function holdLine(hold: StudyHold): string {
  if (hold.kind === "bed") return "Bed";
  if (hold.kind === "plane") return "A plane";
  const n = hold.faces.length;
  return n === 1 ? "1 face fixed" : `${n} faces fixed`;
}

/**
 * A rough row is not met. A provisional card uses its own sentence, ahead of
 * any other reason.
 */
export function constraintVerdict(
  row: { provisional: boolean; trust: TrustWord; maxDisplacementMm: number; minSafetyFactor: number | null; massG: number },
  limits: ConstraintLimits,
): { met: boolean; reason: string } {
  if (row.provisional) return { met: false, reason: PROVISIONAL_SENTENCE };
  if (row.trust === "rough") return { met: false, reason: "This result is rough." };
  if (limits.maxDeflectionMm !== undefined && row.maxDisplacementMm > limits.maxDeflectionMm) {
    return { met: false, reason: `Deflection is ${row.maxDisplacementMm.toFixed(3)} mm.` };
  }
  if (limits.minSafetyFactor !== undefined && (row.minSafetyFactor === null || row.minSafetyFactor < limits.minSafetyFactor)) {
    const value = row.minSafetyFactor === null ? "not defined" : row.minSafetyFactor.toFixed(2);
    return { met: false, reason: `Safety factor is ${value}.` };
  }
  if (limits.maxMassG !== undefined && row.massG > limits.maxMassG) return { met: false, reason: `Mass is ${row.massG.toFixed(2)} g.` };
  if (limits.minMassG !== undefined && row.massG < limits.minMassG) return { met: false, reason: `Mass is ${row.massG.toFixed(2)} g.` };
  return { met: true, reason: "" };
}

/** Provisional cards stay rough. The sentence is the one the solver returns. */
export function shownTrust(card: Pick<MaterialCard, "provisional">): { level: TrustWord; sentence: string } {
  if (card.provisional) return { level: "rough", sentence: PROVISIONAL_SENTENCE };
  return { level: "usable", sentence: "" };
}

export function boxOf(positions: ArrayLike<number>): StudyBox | null {
  if (positions.length < 3) return null;
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = positions[i + axis] ?? 0;
      if (value < min[axis]) min[axis] = value;
      if (value > max[axis]) max[axis] = value;
    }
  }
  if (!min.every(Number.isFinite) || !max.every(Number.isFinite)) return null;
  return { min, max };
}

export function boxDiagonal(box: StudyBox): number {
  const d = [box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]];
  return Math.hypot(d[0], d[1], d[2]);
}

/** Peak displacement drawn at about 5% of the part's diagonal. A still part stays at 1. */
export function defaultScale(peakDispMm: number, diagonalMm: number): number {
  if (!(peakDispMm > 1e-9) || !(diagonalMm > 0)) return 1;
  return (0.05 * diagonalMm) / peakDispMm;
}

function unit(v: Vec3): Vec3 {
  const n = Math.hypot(v[0], v[1], v[2]);
  if (!(n > 1e-12)) return [0, 0, -1];
  return [v[0] / n, v[1] / n, v[2] / n];
}

/**
 * Layer normal of a belt, copied from `belt_layer_normal` in lime-sim.
 * Angle only: the firmware axis does not rotate the layers.
 */
export function beltLayerNormal(angleDeg: number): Vec3 {
  const rad = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return [0, -(sin), cos];
}

const NX = 4;
const NY = 1;
const NZ = 1;

function gridIndex(ix: number, iy: number, iz: number): number {
  return ix * (NY + 1) * (NZ + 1) + iy * (NZ + 1) + iz;
}

function pushQuad(tris: number[], a: number, b: number, c: number, d: number) {
  tris.push(a, b, c, a, c, d);
}

function surfaceTriangles(): number[] {
  const tris: number[] = [];
  for (let ix = 0; ix < NX; ix += 1) {
    for (let iz = 0; iz < NZ; iz += 1) {
      pushQuad(tris, gridIndex(ix, 0, iz), gridIndex(ix + 1, 0, iz), gridIndex(ix + 1, 0, iz + 1), gridIndex(ix, 0, iz + 1));
      pushQuad(tris, gridIndex(ix, NY, iz), gridIndex(ix, NY, iz + 1), gridIndex(ix + 1, NY, iz + 1), gridIndex(ix + 1, NY, iz));
    }
    for (let iy = 0; iy < NY; iy += 1) {
      pushQuad(tris, gridIndex(ix, iy, 0), gridIndex(ix, iy + 1, 0), gridIndex(ix + 1, iy + 1, 0), gridIndex(ix + 1, iy, 0));
      pushQuad(tris, gridIndex(ix, iy, NZ), gridIndex(ix + 1, iy, NZ), gridIndex(ix + 1, iy + 1, NZ), gridIndex(ix, iy + 1, NZ));
    }
  }
  for (let iy = 0; iy < NY; iy += 1) {
    for (let iz = 0; iz < NZ; iz += 1) {
      pushQuad(tris, gridIndex(0, iy, iz), gridIndex(0, iy, iz + 1), gridIndex(0, iy + 1, iz + 1), gridIndex(0, iy + 1, iz));
      pushQuad(tris, gridIndex(NX, iy, iz), gridIndex(NX, iy + 1, iz), gridIndex(NX, iy + 1, iz + 1), gridIndex(NX, iy, iz + 1));
    }
  }
  return tris;
}

/**
 * Euler-Bernoulli cantilever along Width X, bent by the load's direction.
 * Tip δ = P L³ / (3 E I) with I from Depth Y and Height Z. The view multiplies
 * the displacement; this function stores the unscaled field.
 */
export function cannedBeam(
  study: ObjectStudy,
  box: StudyBox,
  card: MaterialCard,
  field: StressField,
  scale?: number,
): CannedResult | { error: string } {
  const refused = holdRefusal(study);
  if (refused) return { error: refused };
  const span = [box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]];
  const length = span[0];
  const width = span[1];
  const height = span[2];
  if (!(length > 0) || !(width > 0) || !(height > 0)) return { error: "This part has no size to show." };
  const load = study.loads[0];
  const area = width * height;
  const newtons = !load ? 0 : load.kind === "pressure" ? load.magnitude * area : load.magnitude;
  const dir = unit(load?.direction ?? [0, 0, -1]);
  const inertia = (width * height ** 3) / 12;
  const modulus = card.EInPlaneMPa > 0 ? card.EInPlaneMPa : 1;
  const bend = (x: number) => (newtons / (6 * modulus * inertia)) * (3 * length * x * x - x * x * x);
  const fibre = (x: number, z: number) => Math.abs((newtons * (length - x) * (z - height / 2)) / inertia);
  const trust = shownTrust(card);
  const nodes: CannedNode[] = [];
  for (let ix = 0; ix <= NX; ix += 1) {
    const x = (ix / NX) * length;
    const deflection = bend(x);
    for (let iy = 0; iy <= NY; iy += 1) {
      const y = (iy / NY) * width;
      for (let iz = 0; iz <= NZ; iz += 1) {
        const z = (iz / NZ) * height;
        const vm = fibre(x, z);
        const safety = vm > 1e-9 ? card.strengthInPlaneMPa / vm : 1e6;
        nodes.push({
          at: [box.min[0] + x, box.min[1] + y, box.min[2] + z],
          u: [dir[0] * deflection, dir[1] * deflection, dir[2] * deflection],
          vonMises: vm,
          displacement: Math.abs(deflection),
          safety,
        });
      }
    }
  }
  const peakDisp = nodes.reduce((peak, node) => Math.max(peak, node.displacement), 0);
  const diagonal = boxDiagonal(box);
  const drawn = scale ?? defaultScale(peakDisp, diagonal);
  const result: CannedResult = {
    label: LABEL,
    nodes,
    triangles: surfaceTriangles(),
    field,
    scale: drawn,
    peak: 0,
    unit: "",
    trust: trust.level,
    trustSentence: trust.sentence,
    diagonal,
  };
  return paintField(result, field);
}

export function paintField(result: CannedResult, field: StressField): CannedResult {
  const values = result.nodes.map((node) => scalarOf(node, field));
  const peak = field === "safety" ? values.reduce((min, value) => Math.min(min, value), Infinity) : values.reduce((max, value) => Math.max(max, value), 0);
  return {
    ...result,
    field,
    peak: Number.isFinite(peak) ? peak : 0,
    unit: field === "vonMises" ? "MPa" : field === "displacement" ? "mm" : "",
  };
}

export function scalarOf(node: CannedNode, field: StressField): number {
  if (field === "displacement") return node.displacement;
  if (field === "safety") return node.safety;
  return node.vonMises;
}

export function fieldLabel(field: StressField): string {
  if (field === "displacement") return "Displacement";
  if (field === "safety") return "Safety factor";
  return "von Mises";
}

/** Blue at the low end, red at the high end. No green, so a provisional card is not drawn as safe. */
export function ramp(t: number): [number, number, number] {
  const u = Math.min(1, Math.max(0, t));
  if (u < 0.5) {
    const s = u / 0.5;
    return [0.15 + 0.75 * s, 0.28 + 0.22 * s, 0.72 * (1 - s) + 0.08];
  }
  const s = (u - 0.5) / 0.5;
  return [0.9 + 0.1 * s, 0.5 * (1 - s) + 0.12, 0.08 * (1 - s)];
}

export function vertexColours(result: CannedResult): Float32Array {
  const values = result.nodes.map((node) => scalarOf(node, result.field));
  let lo = Infinity;
  let hi = -Infinity;
  for (const value of values) {
    if (value < lo) lo = value;
    if (value > hi) hi = value;
  }
  const span = hi - lo;
  const colours = new Float32Array(values.length * 3);
  values.forEach((value, index) => {
    const t = result.field === "safety" ? (span > 1e-12 ? (hi - value) / span : 0) : span > 1e-12 ? (value - lo) / span : 0;
    const rgb = ramp(t);
    colours[index * 3] = rgb[0];
    colours[index * 3 + 1] = rgb[1];
    colours[index * 3 + 2] = rgb[2];
  });
  return colours;
}

export function restPositions(result: CannedResult): Float32Array {
  const out = new Float32Array(result.nodes.length * 3);
  result.nodes.forEach((node, index) => {
    out[index * 3] = node.at[0];
    out[index * 3 + 1] = node.at[1];
    out[index * 3 + 2] = node.at[2];
  });
  return out;
}

export function displacements(result: CannedResult): Float32Array {
  const out = new Float32Array(result.nodes.length * 3);
  result.nodes.forEach((node, index) => {
    out[index * 3] = node.u[0];
    out[index * 3 + 1] = node.u[1];
    out[index * 3 + 2] = node.u[2];
  });
  return out;
}

export function deformedAt(node: CannedNode, scale: number): Vec3 {
  return [node.at[0] + node.u[0] * scale, node.at[1] + node.u[1] * scale, node.at[2] + node.u[2] * scale];
}

/** Nearest surface node. `deformed` uses the drawn position; a typed point uses the part frame. */
export function probeNearest(result: CannedResult, at: Vec3, space: "rest" | "deformed"): { index: number; at: Vec3; value: number } {
  let best = 0;
  let bestD = Infinity;
  result.nodes.forEach((node, index) => {
    const point = space === "deformed" ? deformedAt(node, result.scale) : node.at;
    const d = (point[0] - at[0]) ** 2 + (point[1] - at[1]) ** 2 + (point[2] - at[2]) ** 2;
    if (d < bestD) {
      bestD = d;
      best = index;
    }
  });
  const node = result.nodes[best]!;
  return { index: best, at: space === "deformed" ? deformedAt(node, result.scale) : [...node.at] as Vec3, value: scalarOf(node, result.field) };
}

export function formatProbe(value: number, field: StressField): string {
  const text = Math.abs(value) >= 100 ? value.toFixed(1) : value.toPrecision(3);
  const unit = field === "vonMises" ? " MPa" : field === "displacement" ? " mm" : "";
  return `${text}${unit}`;
}

/**
 * The section hides the side its normal points toward.
 * three.js drops the negative half of a plane whose normal is the opposite, so a point with
 * `normal · (point − origin) > 0` is the cut half.
 */
export function sectionHides(point: readonly number[], origin: readonly number[], normal: readonly number[]): boolean {
  const along =
    ((point[0] ?? 0) - (origin[0] ?? 0)) * (normal[0] ?? 0) +
    ((point[1] ?? 0) - (origin[1] ?? 0)) * (normal[1] ?? 0) +
    ((point[2] ?? 0) - (origin[2] ?? 0)) * (normal[2] ?? 0);
  return along > 1e-6;
}

export function arrowSeat(study: ObjectStudy, box: StudyBox, faceAt: (index: number) => Vec3 | null): Vec3 {
  const face = study.loads[0]?.faces[0];
  if (face !== undefined) {
    const at = faceAt(face);
    if (at) return at;
  }
  return [box.max[0], (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2];
}

/** Typing a larger magnitude lengthens the arrow, and it stays on the part. */
export function arrowLength(magnitude: number, diagonal: number): number {
  const reach = Math.max(6, diagonal * 0.35);
  const grown = 6 + Math.max(0, magnitude) * 0.35;
  return Math.min(reach, Math.max(6, grown));
}

/** Nodes on Z = 0 within 0.05 mm. The bed fixture. */
export function onBed(z: number): boolean {
  return Math.abs(z) <= BED_MM;
}
