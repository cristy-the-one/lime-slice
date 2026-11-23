import { base64ToBytes, bytesToBase64 } from "./base64.ts";
import type { Fingerprint } from "./model-tree.ts";
import type { ModelSolid } from "./model-view.ts";

/**
 * The layout of a solid reply. The engine ships with the app, so a reply that names another is
 * refused before any array is read, rather than drawn as a garbage mesh.
 *
 * The bulk arrays are base64 of little-endian words: `positions` (f32, nine per triangle),
 * `triangles` (u32, the face of each triangle), `edgePoints` (f32, every edge's polyline in turn),
 * and `edgeOffsets` (u32, edge `i` is points `edgeOffsets[i]` up to `edgeOffsets[i + 1]`). The
 * rest is JSON: `volumeMm3`, `solid`, `faces` (`areaMm2`, an optional outward `normal`, and, for a
 * cylinder, cone, or sphere, optional `surface`, `radiusMm`, `axisPoint`, and `axis`, by face
 * index), `edgeLengths` (by edge index), and the node's `fingerprint`.
 */
export const SOLID_FORMAT = "lime-solid-2";

export const MISMATCHED = "This modeler does not match the app. Install the matching Lime Slice.";
export const DAMAGED = "The modeler sent a damaged solid.";

type Vec3 = [number, number, number];

/** A solid as Model draws, picks, and measures it. Face and edge ids are their indexes. */
export type FaceSurface = "cylinder" | "cone" | "sphere";

/** A face as the engine writes it. */
export interface FaceRow {
  areaMm2: number;
  normal?: Vec3;
  /** P1. Present when the face is a cylinder, a cone, or a sphere. */
  radiusMm?: number;
  surface?: FaceSurface;
  axisPoint?: Vec3;
  axis?: Vec3;
  /**
   * The face is a whole closed shell (an ellipsoid, a sphere, a torus): it meets no other face, so a push or pull moves
   * all of it. `inMaxMm` and `outMaxMm` are the largest push and pull before it folds onto itself; absent where it never does.
   */
  closed?: true;
  inMaxMm?: number;
  outMaxMm?: number;
}

export interface ParsedFace extends FaceRow {
  id: number;
}

export interface ParsedSolid extends ModelSolid {
  faces: ParsedFace[];
  fingerprint: Fingerprint | null;
  /** False for surfaces with no closed solid: measured, never edited, and its volume means nothing. */
  editable: boolean;
}

/** What `encodeSolid` writes: a solid with plain number arrays. */
export interface SolidArrays {
  volumeMm3: number;
  positions: ArrayLike<number>;
  normals?: ArrayLike<number>;
  triangles: ArrayLike<number>;
  faces: FaceRow[];
  edges: { lengthMm: number; points: ArrayLike<number> }[];
  seams?: number[];
  /** --- Organic surfaces S4: open-border (naked) edge indices on open sheets. */
  nakedEdges?: number[];
  solid?: boolean;
  /** The node that made each face, or null for a face the step being previewed has not applied yet. */
  stepFaces?: (number | null)[];
}

/** --- Organic surfaces S1: shared-edge G0/G1/G2 continuity and NURBS health from `surfaceInspect`. */
export interface SeamContinuityRow {
  edge: number;
  faces: [number, number];
  kind: "gap" | "G0" | "G1" | "G2";
  gapMm: number;
  angleDeg: number;
  curvatureJump: number;
  mid: Vec3;
}

export interface ContinuitySummary {
  sharedEdges: number;
  g2: number;
  g1: number;
  g0: number;
  gaps: number;
  maxGapMm: number;
  worstSmoothAngleDeg: number;
  worstCurvatureJump: number;
  notable: SeamContinuityRow[];
  /** Every sampled shared edge, including a clean G2 seam. Capped at 256. */
  edges?: SeamContinuityRow[];
  /** A vertex where two faces that meet a smooth seam differ by more than 0.1°. G1 is not sampled there. */
  sharpVertices?: { at: Vec3; faces: [number, number]; angleDeg: number }[];
}

export interface SurfaceHealthSummary {
  faces: number;
  kinds: {
    plane: number;
    cylinder: number;
    cone: number;
    sphere: number;
    torus: number;
    bspline: number;
    bezier: number;
    other: number;
  };
  maxUDegree: number;
  maxVDegree: number;
  maxPoles: number;
  /** Distinct knot spans. Absent on a reply from before S6. */
  maxUSpans?: number;
  maxVSpans?: number;
  rationalFaces: number;
  highDegreeFaces: number;
  heavyFaces: number;
  minRadiusMm?: number;
  tightestFace?: number;
  tightestAt?: Vec3;
}

export interface DecodedSurfaceInspect {
  id: number;
  minRadiusMm?: Float32Array;
  gaussian?: Float32Array;
  mean?: Float32Array;
  isoPoints?: Float32Array;
  continuity: ContinuitySummary;
  surfaceHealth: SurfaceHealthSummary;
}

/**
 * The solid in a reply, or why there is none: the engine's error, a format this app does not
 * read, or arrays that do not fit together. The typed arrays view the decoded bytes in place.
 */
export function decodeSolid(body: Record<string, unknown>): ParsedSolid | string {
  if (typeof body.error === "string" && body.error) return body.error;
  if (body.format !== SOLID_FORMAT) return MISMATCHED;
  const { faces: faceRows, edgeLengths } = body;
  if (typeof body.volumeMm3 !== "number" || !Array.isArray(faceRows) || !Array.isArray(edgeLengths)) return DAMAGED;
  const positions = words(body.positions, Float32Array);
  const rawNormals = body.normals === undefined ? null : words(body.normals, Float32Array);
  const triangles = words(body.triangles, Uint32Array);
  const points = words(body.edgePoints, Float32Array);
  const offsets = words(body.edgeOffsets, Uint32Array);
  if (!positions || !triangles || !points || !offsets) return DAMAGED;
  if (positions.length !== triangles.length * 9 || offsets.length !== edgeLengths.length + 1 || offsets[0] !== 0) return DAMAGED;
  const normals = rawNormals && rawNormals.length === positions.length ? rawNormals : undefined;
  for (const face of triangles) if (face >= faceRows.length) return DAMAGED;
  const faces: ParsedSolid["faces"] = [];
  for (const row of faceRows as { [K in keyof FaceRow]?: unknown }[]) {
    if (!row || typeof row.areaMm2 !== "number") return DAMAGED;
    const normal = readNormal(row.normal);
    const surface = row.surface === "cylinder" || row.surface === "cone" || row.surface === "sphere" ? row.surface : undefined;
    const radiusMm = typeof row.radiusMm === "number" && row.radiusMm > 0 ? row.radiusMm : undefined;
    const axisPoint = readNormal(row.axisPoint);
    const axis = readNormal(row.axis);
    faces.push({
      id: faces.length,
      areaMm2: row.areaMm2,
      ...(normal ? { normal } : {}),
      ...(surface && radiusMm != null ? { surface, radiusMm, ...(axisPoint && axis ? { axisPoint, axis } : {}) } : {}),
      ...closedFields(row),
    });
  }
  const edges: ParsedSolid["edges"] = [];
  for (let edge = 0; edge < edgeLengths.length; edge += 1) {
    const from = offsets[edge]!;
    const to = offsets[edge + 1]!;
    const lengthMm = edgeLengths[edge];
    if (typeof lengthMm !== "number" || to < from || to * 3 > points.length) return DAMAGED;
    edges.push({ id: edge, lengthMm, points: points.subarray(from * 3, to * 3) });
  }
  if (offsets[edgeLengths.length]! * 3 !== points.length) return DAMAGED;
  const stepFaces = readStepFaces(body.stepFaces, faces.length);
  const seams = Array.isArray(body.edgeSeams) ? body.edgeSeams.filter((edge): edge is number => Number.isInteger(edge) && edge >= 0 && edge < edges.length) : [];
  const nakedEdges = Array.isArray(body.nakedEdges) ? body.nakedEdges.filter((edge): edge is number => Number.isInteger(edge) && edge >= 0 && edge < edges.length) : [];
  return {
    id: typeof body.id === "number" ? body.id : 0,
    volumeMm3: body.volumeMm3,
    positions,
    ...(normals ? { normals } : {}),
    triangles,
    faces,
    edges,
    fingerprint: readFingerprint(body.fingerprint),
    editable: body.solid !== false,
    ...(seams.length > 0 ? { seams } : {}),
    ...(nakedEdges.length > 0 ? { nakedEdges } : {}),
    ...(stepFaces ? { stepFaces } : {}),
  };
}

/** A closed face's flag and fold distances, or nothing for any other face. A distance that is not a number 0 or over is dropped. */
function closedFields(row: { closed?: unknown; inMaxMm?: unknown; outMaxMm?: unknown }): Pick<FaceRow, "closed" | "inMaxMm" | "outMaxMm"> {
  if (row.closed !== true) return {};
  const most = (value: unknown) => (typeof value === "number" && value >= 0 ? value : undefined);
  const inMaxMm = most(row.inMaxMm);
  const outMaxMm = most(row.outMaxMm);
  return { closed: true, ...(inMaxMm != null ? { inMaxMm } : {}), ...(outMaxMm != null ? { outMaxMm } : {}) };
}

/** A solid reply's fields as the engine writes them, but for `id` and `fingerprint`. */
export type SolidWire = {
  format: string;
  volumeMm3: number;
  solid: boolean;
  faces: FaceRow[];
  edgeLengths: number[];
  edgeSeams?: number[];
  nakedEdges?: number[];
  positions: string;
  normals?: string;
  triangles: string;
  edgePoints: string;
  edgeOffsets: string;
};

export function encodeSolid(solid: SolidArrays): SolidWire & { stepFaces?: (number | null)[] } {
  const offsets = [0];
  const points: number[] = [];
  for (const edge of solid.edges) {
    for (let i = 0; i < edge.points.length; i += 1) points.push(edge.points[i]!);
    offsets.push(points.length / 3);
  }
  return {
    format: SOLID_FORMAT,
    volumeMm3: solid.volumeMm3,
    solid: solid.solid !== false,
    faces: solid.faces.map((face) => {
      const { areaMm2, normal, radiusMm, surface, axisPoint, axis } = face;
      return {
        areaMm2,
        ...(normal ? { normal } : {}),
        ...(surface && radiusMm != null ? { surface, radiusMm, ...(axisPoint && axis ? { axisPoint, axis } : {}) } : {}),
        ...closedFields(face),
      };
    }),
    edgeLengths: solid.edges.map((edge) => edge.lengthMm),
    ...(solid.seams && solid.seams.length > 0 ? { edgeSeams: solid.seams } : {}),
    ...(solid.nakedEdges && solid.nakedEdges.length > 0 ? { nakedEdges: solid.nakedEdges } : {}),
    positions: wordsBase64(Float32Array.from(solid.positions)),
    ...(solid.normals && solid.normals.length === solid.positions.length ? { normals: wordsBase64(Float32Array.from(solid.normals)) } : {}),
    triangles: wordsBase64(Uint32Array.from(solid.triangles)),
    edgePoints: wordsBase64(Float32Array.from(points)),
    edgeOffsets: wordsBase64(Uint32Array.from(offsets)),
    ...(solid.stepFaces && solid.stepFaces.length === solid.faces.length ? { stepFaces: solid.stepFaces } : {}),
  };
}

/** Decode a `surfaceInspect` engine reply into typed curvature/isoparm buffers plus continuity & health summaries. */
export function decodeSurfaceInspect(body: Record<string, unknown>): DecodedSurfaceInspect | string {
  if (typeof body.error === "string" && body.error) return body.error;
  if (!body.continuity || typeof body.continuity !== "object" || !body.surfaceHealth || typeof body.surfaceHealth !== "object") {
    return DAMAGED;
  }
  const minRadiusMm = body.minRadiusMm === undefined ? undefined : (words(body.minRadiusMm, Float32Array) ?? undefined);
  const gaussian = body.gaussian === undefined ? undefined : (words(body.gaussian, Float32Array) ?? undefined);
  const mean = body.mean === undefined ? undefined : (words(body.mean, Float32Array) ?? undefined);
  const isoPoints = body.isoPoints === undefined ? undefined : (words(body.isoPoints, Float32Array) ?? undefined);
  return {
    id: typeof body.id === "number" ? body.id : 0,
    ...(minRadiusMm ? { minRadiusMm } : {}),
    ...(gaussian ? { gaussian } : {}),
    ...(mean ? { mean } : {}),
    ...(isoPoints ? { isoPoints } : {}),
    continuity: body.continuity as ContinuitySummary,
    surfaceHealth: body.surfaceHealth as SurfaceHealthSummary,
  };
}

/** Base64 of the words' little-endian bytes, which is how every machine the app runs on keeps them. */
function wordsBase64(words: Float32Array | Uint32Array): string {
  return bytesToBase64(new Uint8Array(words.buffer, words.byteOffset, words.byteLength));
}

/**
 * The words in base64 `text`, viewed in place: the decoded bytes are a fresh buffer, so they start
 * on a word. Null when it is not base64 of whole words.
 */
function words<T extends Float32Array | Uint32Array>(
  text: unknown,
  kind: { new (buffer: ArrayBuffer, offset: number, length: number): T },
): T | null {
  if (typeof text !== "string") return null;
  const bytes = base64ToBytes(text);
  if (!bytes || bytes.byteLength % 4 !== 0) return null;
  return new kind(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength / 4);
}

function readNormal(value: unknown): Vec3 | null {
  if (!Array.isArray(value) || value.length < 3) return null;
  const normal = value.slice(0, 3).map((item) => (typeof item === "number" ? item : Number.NaN));
  if (normal.some((item) => !Number.isFinite(item))) return null;
  return [normal[0]!, normal[1]!, normal[2]!];
}

/**
 * `stepFaces` when it names one node, or null, per face. A missing field, or one that does not match
 * the faces, is ignored: an older engine, and a damaged list, still draw the solid.
 */
function readStepFaces(value: unknown, faces: number): (number | null)[] | null {
  if (!Array.isArray(value) || value.length !== faces) return null;
  const owners: (number | null)[] = [];
  for (const item of value) {
    if (item == null) owners.push(null);
    else if (typeof item === "number" && Number.isFinite(item)) owners.push(item);
    else return null;
  }
  return owners;
}

/** A fingerprint as the engine writes it, or null. */
export function readFingerprint(value: unknown): Fingerprint | null {
  if (!value || typeof value !== "object") return null;
  const row = value as { volumeMm3?: unknown; faces?: unknown; edges?: unknown };
  if (typeof row.volumeMm3 !== "number" || typeof row.faces !== "number" || typeof row.edges !== "number") return null;
  return { volumeMm3: row.volumeMm3, faces: row.faces, edges: row.edges };
}
