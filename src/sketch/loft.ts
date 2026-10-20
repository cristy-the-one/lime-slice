/**
 * --- F3. Loft two or more sketch regions, or flat faces, in the order they were picked. ---
 *
 * The op is a `loft` with `loops` on each section. The sketches are copied onto `drawing` and
 * stripped before the engine sees the op. A face is a section from `faceLoops`. Join, cut, and a
 * new object are the extrude's choice. A loft whose sections lie in one plane is refused in the
 * kernel's words, before anything is sent.
 */
import { loftOp } from "../model-request.ts";
import type { BooleanKind, LoftDrawing, LoftOp, LoftSection, ProfileLoop as EngineLoop, ProfileSegment as EngineSegment, Vec2, Vec3 } from "../model-tree.ts";
import { frameOf, toWorld } from "./frame.ts";
import { addCircle, emptySketch, readSketch, sketchJson, type Pt, type SketchData } from "./model.ts";
import { loopSignedArea, toLoops, type ProfileLoop, type Region } from "./regions.ts";
import { tooManyHoles, type ModeChoice, type ResolvedMode } from "./extrude.ts";
import { copyLoop, drawLoop, lineLoop, sampleLoopPoints, sentence } from "./loops.ts";

export const COPLANAR_REFUSAL = "The loft has no volume: its sections lie in one plane.";
export const SECTIONS_REFUSAL = "A loft needs two or more sections.";
export const FACE_SOLID_REFUSAL = "A face section needs a solid.";
const FACE_FLAT = "Face loops are for a flat face.";
const FACE_OUTLINE = "Open CASCADE could not read this face's outline.";

export interface LoftPickInput {
  /** The sketch the section was picked from. Null is a face, or a section with no drawing. */
  sketch: SketchData | null;
  section: LoftSection;
}

/** History Edit of a loft: the sections, and a sketch for each one that has a drawing. */
export interface LoftPreset {
  kind: "loft";
  choice: ModeChoice;
  ruled: boolean;
  sketches: (SketchData | null)[];
  sections: LoftSection[];
}

/** One flat face, as `faceLoops` answers it. */
export interface FaceLoops {
  origin: Vec3;
  turn: Vec3;
  loops: EngineLoop[];
}

/** A section on the sketch's plane, loops from the region. */
export function sectionFromRegion(sketch: SketchData, region: Region): LoftSection {
  return {
    origin: [...sketch.plane.origin] as Vec3,
    turn: [...sketch.plane.turn] as Vec3,
    loops: toLoops(region).map(copyLoop),
  };
}

/** Area of one section: loops, a circle or ellipse, or a point profile. */
export function sectionArea(section: LoftSection): number {
  if (section.loops && section.loops.length > 0) {
    let area = 0;
    for (const loop of section.loops) area += loopSignedArea(loop as ProfileLoop);
    return Math.abs(area);
  }
  if (section.radius != null && section.radius > 0) return Math.PI * section.radius * (section.radiusV ?? section.radius);
  const profile = section.profile;
  if (!profile || profile.length < 3) return 0;
  let twice = 0;
  for (let i = 0; i < profile.length; i += 1) {
    const a = profile[i]!;
    const b = profile[(i + 1) % profile.length]!;
    twice += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(twice) / 2;
}

/**
 * Volume of a linear loft of similar sections. Each span is the prismatoid
 * `h/3 · (A + B + √(A·B))`, with `h` the distance between the section origins.
 * Exact when the sections are scaled copies on parallel planes.
 */
export function loftAreaVolume(sections: readonly LoftSection[]): number {
  let volume = 0;
  for (let i = 0; i < sections.length - 1; i += 1) {
    const a = sections[i]!;
    const b = sections[i + 1]!;
    const height = Math.hypot(b.origin[0] - a.origin[0], b.origin[1] - a.origin[1], b.origin[2] - a.origin[2]);
    const areaA = sectionArea(a);
    const areaB = sectionArea(b);
    volume += (height / 3) * (areaA + areaB + Math.sqrt(Math.max(0, areaA * areaB)));
  }
  return volume;
}

/** True when every section lies in the first section's plane. */
export function sectionsCoplanar(sections: readonly LoftSection[]): boolean {
  const first = sections[0];
  if (!first || sections.length < 2) return false;
  const base = frameOf({ origin: first.origin, turn: first.turn });
  for (const section of sections.slice(1)) {
    const frame = frameOf({ origin: section.origin, turn: section.turn });
    const parallel = Math.abs(base.w[0] * frame.w[0] + base.w[1] * frame.w[1] + base.w[2] * frame.w[2]);
    if (parallel < 0.999) return false;
    const rise = (section.origin[0] - base.origin[0]) * base.w[0] + (section.origin[1] - base.origin[1]) * base.w[1] + (section.origin[2] - base.origin[2]) * base.w[2];
    if (Math.abs(rise) > 1e-4) return false;
  }
  return true;
}

/** The loft op, with a copy of each sketch on `drawing`. An error is not sent. */
export function buildSketchLoft(input: { picks: readonly LoftPickInput[]; ruled: boolean; mode: ResolvedMode }): { op: LoftOp } | { error: string } {
  if (input.picks.length < 2) return { error: SECTIONS_REFUSAL };
  const sections = input.picks.map((pick) => pick.section);
  if (sectionsCoplanar(sections)) return { error: COPLANAR_REFUSAL };
  for (const section of sections) {
    const crowded = tooManyHoles(section.loops?.length ?? 1);
    if (crowded) return { error: crowded };
  }
  const boolean: BooleanKind = input.mode === "new" ? "fuse" : input.mode;
  const drawing: LoftDrawing = { sketches: input.picks.map((pick) => (pick.sketch ? sketchJson(pick.sketch) : null)) };
  return { op: { ...loftOp(boolean, sections, input.ruled), drawing } };
}

/**
 * What History Edit reopens. A stored drawing is copied. Without one, each section becomes a
 * sketch of lines, arcs, or a circle, so an MCP loft stays editable.
 */
export function loftEditOf(op: { kind: string }, root: boolean): LoftPreset | null {
  if (op.kind !== "loft") return null;
  const loft = op as LoftOp;
  if (loft.drawing?.sweep || loft.sections.length < 2) return null;
  const stored = loft.drawing?.sketches;
  const sketches = loft.sections.map((section, index) => {
    const kept = stored?.[index];
    if (kept) return sketchJson(kept);
    if (stored) return null;
    return sketchFromSection(section);
  });
  return {
    kind: "loft",
    choice: root ? "new" : loft.op,
    ruled: loft.ruled === true,
    sketches,
    sections: loft.sections.map(cloneSection),
  };
}

/** A sketch a section can be drawn as again. Null when the section has no outline. */
export function sketchFromSection(section: LoftSection): SketchData | null {
  const plane = { origin: [...section.origin] as Vec3, turn: [...section.turn] as Vec3 };
  let sketch = emptySketch(plane);
  if (section.loops && section.loops.length > 0) {
    for (const loop of section.loops) sketch = drawLoop(sketch, loop);
  } else if (section.profile && section.profile.length >= 3) {
    sketch = drawLoop(sketch, lineLoop(section.profile));
  } else if (section.radius != null && section.radius > 0 && (section.radiusV == null || Math.abs(section.radiusV - section.radius) < 1e-6)) {
    sketch = addCircle(sketch, [0, 0], section.radius).sketch;
  } else if (section.radius != null && section.radius > 0) {
    sketch = drawLoop(sketch, ellipseLoop(section.radius, section.radiusV ?? section.radius));
  }
  return sketch.entities.length > 0 ? sketch : null;
}

/** Sampled outline in model space, for the coarse ghost. The outer loop, or the circle. */
export function sectionOutline(section: LoftSection, count = 24): Vec3[] {
  const frame = frameOf({ origin: section.origin, turn: section.turn });
  let uv: Pt[] = [];
  if (section.loops && section.loops.length > 0) uv = sampleLoopPoints(section.loops[0]!);
  else if (section.profile && section.profile.length >= 3) uv = section.profile.map((point) => [point[0], point[1]]);
  else if (section.radius != null && section.radius > 0) {
    const radiusV = section.radiusV ?? section.radius;
    uv = [];
    for (let i = 0; i < count; i += 1) {
      const angle = (i / count) * Math.PI * 2;
      uv.push([Math.cos(angle) * section.radius, Math.sin(angle) * radiusV]);
    }
  }
  if (uv.length < 3) return [];
  return uv.map((point) => toWorld(frame, point));
}

/** `faceLoops` as a section, or the sentence to show. */
export function readFaceLoops(body: unknown): FaceLoops | { error: string } {
  if (!isRecord(body)) return { error: FACE_FLAT };
  if (typeof body.error === "string" && body.error) return { error: sentence(body.error) };
  const origin = vec(body.origin);
  const turn = body.turn === undefined ? ([0, 0, 0] as Vec3) : vec(body.turn);
  const loops = readLoops(body.loops);
  if (!origin || !turn || !loops || loops.length === 0) return { error: FACE_OUTLINE };
  return { origin, turn, loops };
}

/**
 * Optional `drawing` on a saved loft. Undefined when it is absent or unreadable, so the loft
 * still opens and an older file is unchanged.
 */
export function readLoftDrawing(value: unknown): LoftDrawing | undefined {
  if (!isRecord(value)) return undefined;
  const drawing: LoftDrawing = {};
  if (value.sketches !== undefined) {
    if (!Array.isArray(value.sketches)) return undefined;
    const sketches: (SketchData | null)[] = [];
    for (const raw of value.sketches) {
      if (raw === null) {
        sketches.push(null);
        continue;
      }
      const sketch = readSketch(raw);
      if (!sketch) return undefined;
      sketches.push(sketch);
    }
    drawing.sketches = sketches;
  }
  if (value.sweep !== undefined) {
    if (!isRecord(value.sweep)) return undefined;
    const profile = readSketch(value.sweep.profile);
    const pathSketch = value.sweep.pathSketch === undefined ? undefined : readSketch(value.sweep.pathSketch);
    if (!profile || (value.sweep.pathSketch !== undefined && !pathSketch)) return undefined;
    if (!Array.isArray(value.sweep.path) || value.sweep.path.length < 2) return undefined;
    const path: Vec3[] = [];
    for (const raw of value.sweep.path) {
      const point = vec(raw);
      if (!point) return undefined;
      path.push(point);
    }
    const scale = readScale(value.sweep.scale, path.length);
    if (!scale) return undefined;
    let edges: number[] | undefined;
    if (value.sweep.edges !== undefined) {
      if (!Array.isArray(value.sweep.edges) || value.sweep.edges.some((edge) => typeof edge !== "number" || !Number.isInteger(edge) || edge < 0)) return undefined;
      edges = [...value.sweep.edges];
    }
    drawing.sweep = { profile, path, scale, ...(value.sweep.scaleAtEnd === true ? { scaleAtEnd: true as const } : {}), ...(pathSketch ? { pathSketch } : {}), ...(edges && edges.length > 0 ? { edges } : {}) };
  }
  if (!drawing.sketches && !drawing.sweep) return undefined;
  return drawing;
}

function readScale(value: unknown, count: number): number | number[] | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (!Array.isArray(value) || value.length !== count) return null;
  if (!value.every((item) => typeof item === "number" && Number.isFinite(item) && item > 0)) return null;
  return [...value];
}

function readLoops(value: unknown): EngineLoop[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) return null;
  const loops: EngineLoop[] = [];
  for (const raw of value) {
    if (!isRecord(raw) || !Array.isArray(raw.segments) || raw.segments.length < 1) return null;
    const start = pair(raw.start);
    if (!start) return null;
    const segments: EngineSegment[] = [];
    for (const seg of raw.segments) {
      if (!isRecord(seg)) return null;
      const to = pair(seg.to);
      if (!to) return null;
      if (seg.kind === "line") segments.push({ kind: "line", to });
      else if (seg.kind === "arc") {
        const through = pair(seg.through);
        if (!through) return null;
        segments.push({ kind: "arc", through, to });
      } else if (seg.kind === "spline") {
        if (!Array.isArray(seg.through)) return null;
        const through: Vec2[] = [];
        for (const point of seg.through) {
          const at = pair(point);
          if (!at) return null;
          through.push(at);
        }
        segments.push({ kind: "spline", through, to });
      } else return null;
    }
    loops.push({ start, segments });
  }
  return loops;
}

function cloneSection(section: LoftSection): LoftSection {
  return {
    origin: [...section.origin] as Vec3,
    turn: [...section.turn] as Vec3,
    ...(section.loops ? { loops: section.loops.map(copyLoop) } : {}),
    ...(section.profile ? { profile: section.profile.map((point) => [point[0], point[1]] as Vec2) } : {}),
    ...(section.radius !== undefined ? { radius: section.radius } : {}),
    ...(section.radiusV !== undefined ? { radiusV: section.radiusV } : {}),
    ...(section.smooth ? { smooth: true as const } : {}),
    ...(section.corners?.length ? { corners: [...section.corners] } : {}),
  };
}

function ellipseLoop(radius: number, radiusV: number): EngineLoop {
  const points: Vec2[] = [];
  const count = 16;
  for (let i = 0; i < count; i += 1) {
    const angle = (i / count) * Math.PI * 2;
    points.push([Math.cos(angle) * radius, Math.sin(angle) * radiusV]);
  }
  return lineLoop(points);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function pair(value: unknown): Vec2 | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  const u = value[0];
  const v = value[1];
  if (typeof u !== "number" || typeof v !== "number" || !Number.isFinite(u) || !Number.isFinite(v)) return null;
  return [u, v];
}

function vec(value: unknown): Vec3 | null {
  if (!Array.isArray(value) || value.length < 3) return null;
  const x = value[0];
  const y = value[1];
  const z = value[2];
  if (typeof x !== "number" || typeof y !== "number" || typeof z !== "number") return null;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  return [x, y, z];
}
