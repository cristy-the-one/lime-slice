/**
 * The `section` tool's planes and its mesh answers (docs/plan-recipe-ingredients.md I5–I7, groovi LESSONS R-B).
 *
 * Every answer has the same shape, from the kernel for a solid and from `mesh-section.ts` for a mesh: the plane's frame
 * `{origin, u, v, w}`, the `origin` and `turn` an extrude takes to draw in that frame, `loops` ready for `extrude.loops`
 * (outlines counter-clockwise, each followed by its holes), `regions` as sampled points (an outer loop and its holes),
 * and `areaMm2`. A mesh adds `open`: chains that do not close, where the mesh has a gap.
 */
import { orientEuler } from "../mesh-place.ts";
import { levelFrame } from "./frames.ts";
import { axesOf, type Workplane } from "../workplane.ts";
import { fanFrames, levelFrames, sectionMesh, type SectionFrame, type SectionLoop, type V3 } from "./mesh-section.ts";

/** One plane to cut by: its origin and unit normal, and the frame its loops are written in. */
export interface CutPlane {
  origin: V3;
  normal: V3;
  plane: Workplane;
}

/** The most points one section call answers with, over every plane and loop. */
export const MAX_SECTION_POINTS = 100_000;

const MAX_PLANES = 200;

function vec(value: unknown): V3 | null {
  if (!Array.isArray(value) || value.length !== 3 || !value.every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  return [value[0], value[1], value[2]];
}

function unit(v: V3): V3 | null {
  const length = Math.hypot(v[0], v[1], v[2]);
  return length > 1e-12 ? [v[0] / length, v[1] / length, v[2] / length] : null;
}

/** The workplane whose U, V, W are a section frame's. */
function planeOfFrame(frame: SectionFrame): Workplane {
  const { u, v, w } = frame;
  const turn = orientEuler([u[0], v[0], w[0], u[1], v[1], w[1], u[2], v[2], w[2]]);
  return { source: "face", origin: [...frame.origin], turn: [turn.rx, turn.ry, turn.rz] };
}

/**
 * The planes a call asks for: `planes` (each framed as a face with that normal is, so a level plane keeps X and Y),
 * `fan` (planes through one axis: U radial, V along the axis), or `levels` (square to X, Y, or Z). Exactly one.
 */
export function cutPlanes(input: Record<string, unknown>): CutPlane[] | { reason: string } {
  const asked = ["planes", "fan", "levels"].filter((key) => input[key] !== undefined);
  if (asked.length !== 1) return { reason: "Give one of planes, fan, or levels, or a face for its outline." };
  const out: CutPlane[] = [];
  if (input.planes !== undefined) {
    for (const [index, value] of (input.planes as unknown[]).entries()) {
      const row = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
      const origin = vec(row.origin);
      const normal = vec(row.normal);
      const direction = normal ? unit(normal) : null;
      if (!origin || !direction) return { reason: `planes[${index}] needs an origin and a normal with a length.` };
      const plane = levelFrame({ point: origin, normal: direction });
      out.push({ origin, normal: direction, plane });
    }
    return out;
  }
  let frames: SectionFrame[];
  if (input.fan !== undefined) {
    const fan = input.fan as Record<string, unknown>;
    const point = vec(fan.axisPoint);
    const dir = vec(fan.axisDir);
    const angles = Array.isArray(fan.anglesDeg) ? (fan.anglesDeg as unknown[]).filter((n): n is number => typeof n === "number" && Number.isFinite(n)) : [];
    if (!point || !dir || angles.length === 0) return { reason: "A fan needs axisPoint, axisDir, and anglesDeg." };
    const made = fanFrames(point, dir, angles);
    if ("reason" in made) return made;
    frames = made;
  } else {
    const levels = input.levels as Record<string, unknown>;
    const values = Array.isArray(levels.values) ? (levels.values as unknown[]).filter((n): n is number => typeof n === "number" && Number.isFinite(n)) : [];
    if ((levels.axis !== "x" && levels.axis !== "y" && levels.axis !== "z") || values.length === 0) return { reason: "Levels need an axis (x, y, or z) and values." };
    frames = levelFrames(levels.axis, values);
  }
  if (frames.length > MAX_PLANES) return { reason: `A section takes at most ${MAX_PLANES} planes.` };
  for (const frame of frames) out.push({ origin: [...frame.origin], normal: [...frame.w], plane: planeOfFrame(frame) });
  return out;
}

const round = (n: number, step = 1e-6) => Math.round(n / step) * step + 0;
const roundVec = (v: readonly number[]) => v.map((n) => round(n)) as V3;

/** The frame an answer names: origin, U, V, W. */
export function frameOf(plane: Workplane): { origin: V3; u: V3; v: V3; w: V3 } {
  const [u, v, w] = axesOf(plane);
  return { origin: roundVec(plane.origin), u: roundVec(u), v: roundVec(v), w: roundVec(w) };
}

/** The nine numbers (origin, U, V) the kernel's faceOutline and section take. */
export function frameNumbers(plane: Workplane): number[] {
  const [u, v] = axesOf(plane);
  return [...plane.origin, ...u, ...v];
}

/** Even-odd: `point` inside the closed polygon `ring`. */
function inside(point: readonly number[], ring: readonly (readonly number[])[]): boolean {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const a = ring[i]!;
    const b = ring[j]!;
    if (a[1]! > point[1]! !== b[1]! > point[1]! && point[0]! < ((b[0]! - a[0]!) * (point[1]! - a[1]!)) / (b[1]! - a[1]!) + a[0]!) hit = !hit;
  }
  return hit;
}

function lineLoop(points: readonly [number, number][]): Record<string, unknown> {
  return { start: points[0], segments: points.map((_, i) => ({ kind: "line", to: points[(i + 1) % points.length] })) };
}

/** A mesh cut by one plane, answered as a solid's section is. `positions` is 9 floats a triangle. */
export function meshSection(positions: ArrayLike<number>, cut: CutPlane, options: { resample?: number; startAngleDeg?: number }): Record<string, unknown> {
  const [u, v, w] = axesOf(cut.plane);
  const section = sectionMesh(positions, { origin: [...cut.plane.origin], u, v, w }, options);
  const closed = section.loops.filter((loop) => loop.closed);
  const open = section.loops.filter((loop) => !loop.closed);
  const outers = closed.filter((loop) => loop.depth % 2 === 0);
  const holesOf = new Map<SectionLoop, SectionLoop[]>(outers.map((loop) => [loop, []]));
  for (const hole of closed.filter((loop) => loop.depth % 2 === 1)) {
    const parent = outers.find((outer) => outer.depth === hole.depth - 1 && inside(hole.points[0]!, outer.points));
    if (parent) holesOf.get(parent)!.push(hole);
  }
  const loops: Record<string, unknown>[] = [];
  const regions: Record<string, unknown>[] = [];
  let area = 0;
  for (const outer of outers) {
    const holes = holesOf.get(outer)!;
    loops.push(lineLoop(outer.points), ...holes.map((hole) => lineLoop(hole.points)));
    regions.push({ outer: outer.points, holes: holes.map((hole) => hole.points) });
    area += outer.areaMm2 - holes.reduce((sum, hole) => sum + hole.areaMm2, 0);
  }
  return {
    plane: { origin: roundVec(cut.origin), normal: roundVec(cut.normal) },
    frame: frameOf(cut.plane),
    origin: roundVec(cut.plane.origin),
    turn: cut.plane.turn.map((n) => round(n)),
    loops,
    regions,
    areaMm2: round(area, 1e-4),
    ...(open.length ? { open: open.map((loop) => loop.points) } : {}),
  };
}

/** How many [u, v] points an answer holds, in its regions, open chains, and loops. */
export function pointsIn(answer: Record<string, unknown>): number {
  let count = 0;
  for (const region of (answer.regions as { outer: unknown[]; holes: unknown[][] }[] | undefined) ?? []) {
    count += region.outer.length + region.holes.reduce((sum, hole) => sum + hole.length, 0);
  }
  for (const chain of (answer.open as unknown[][] | undefined) ?? []) count += chain.length;
  for (const loop of (answer.loops as { segments: { through?: unknown }[] }[] | undefined) ?? []) {
    for (const segment of loop.segments) count += 1 + (Array.isArray(segment.through) && Array.isArray(segment.through[0]) ? segment.through.length : 0);
  }
  return count;
}
