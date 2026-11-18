/**
 * Checks on a step the kernel has already applied, for results Open CASCADE reports as done but that are not what
 * the step meant: a fuse that hands back only the tool, a cut that takes more than its tool, a fillet that loses most
 * of the part, a piece that meets the part only along an edge, or a damaged solid (new edges where pieces meet only
 * along a line, a mesh whose volume is not the solid's). The session takes such a step back
 * and refuses it. Only what the step changed counts: edges like these that the part already had are left alone.
 */
import { edgeReport, nonManifoldSegments, soupVolume, type EdgeReport, type Vec3 } from "../mesh-check.ts";

type Box = { min: Vec3 | number[]; max: Vec3 | number[] };

/** Kinds that remove on purpose and may leave little: a shell hollows, a split or a common keeps part, a scale shrinks. */
const MAY_SHRINK = new Set(["shell", "split", "scale", "root"]);
const ADDS = new Set(["boolean", "join", "extrude", "revolve", "loft", "sweep"]);

const mm3 = (value: number) => `${Math.round(value * 10) / 10} mm³`;

/**
 * Why a step's result is refused, or null. `before` and `after` are the part's volume; `toolBox` is a primitive
 * tool's box, the most a cut with it can remove.
 */
export function lostVolume(op: { kind: string; op?: string }, before: number, after: number, toolBox: Box | null): string | null {
  if (!(before > 0) || !Number.isFinite(after) || MAY_SHRINK.has(op.kind)) return null;
  const slack = Math.max(before * 1e-4, 0.01);
  if (ADDS.has(op.kind) && op.op === "fuse" && after < before - slack) {
    return `Open CASCADE returned ${mm3(after)} for a fuse on a ${mm3(before)} part, so the part would be lost. The step was taken back. Move or resize it so it overlaps the part more clearly, or split the edit into smaller steps.`;
  }
  if (op.op === "common") return null;
  if (op.kind === "boolean" && op.op === "cut" && toolBox) {
    const most = [0, 1, 2].reduce((acc, i) => acc * Math.max(0, Number(toolBox.max[i]) - Number(toolBox.min[i])), 1);
    if (before - after > most * 1.02 + slack) {
      return `Open CASCADE removed ${mm3(before - after)} with a cut whose tool holds at most ${mm3(most)}, leaving ${mm3(after)} of a ${mm3(before)} part. The step was taken back. Move the cut off the part's edges, or make it a little larger or smaller.`;
    }
    return null;
  }
  if (op.op === "cut" || op.kind === "hole") return null;
  if (after < before * 0.5) {
    return `This ${op.kind} would leave ${mm3(after)} of a ${mm3(before)} part. The step was taken back. Try a smaller size or fewer edges.`;
  }
  return null;
}

/** Triangles of a soup that reach into `box` grown by `pad` on every side. */
function trianglesNear(positions: ArrayLike<number>, box: Box, pad: number): Float32Array {
  const lo = [0, 1, 2].map((i) => Number(box.min[i]) - pad);
  const hi = [0, 1, 2].map((i) => Number(box.max[i]) + pad);
  const kept: number[] = [];
  for (let t = 0; t + 8 < positions.length; t += 9) {
    let inside = true;
    for (let i = 0; i < 3 && inside; i += 1) {
      const a = positions[t + i]!;
      const b = positions[t + 3 + i]!;
      const c = positions[t + 6 + i]!;
      if (Math.max(a, b, c) < lo[i]! || Math.min(a, b, c) > hi[i]!) inside = false;
    }
    if (inside) for (let k = 0; k < 9; k += 1) kept.push(positions[t + k]!);
  }
  return Float32Array.from(kept);
}

/** Edges near a tool used by more than two triangles: where pieces meet only along a line. */
export function touchingEdges(positions: ArrayLike<number>, box: Box): { count: number; at: Vec3 | null } {
  const report = edgeReport(trianglesNear(positions, box, 0.5), 1);
  return { count: report.nonManifold, at: report.nonManifoldAt[0]?.at ?? null };
}

/** A touching edge of the result lies on one the part had when it is this close to it along its whole length. */
const SAME_EDGE_MM = 0.01;
/** Grid cell for finding the part's own touching edges near a point, mm. */
const EDGE_CELL_MM = 2;

/** Each soup's touching edges, kept while the soup lives: the solid before a step is read again by the next one. */
const segmentsOf = new WeakMap<object, Float64Array>();

function touchingSegments(positions: ArrayLike<number>): Float64Array {
  const key = positions as unknown as object;
  const known = typeof key === "object" ? segmentsOf.get(key) : undefined;
  if (known) return known;
  const found = nonManifoldSegments(positions);
  if (typeof key === "object") segmentsOf.set(key, found);
  return found;
}

/** Distance from p to the segment a–b. */
function toSegment(p: readonly number[], s: Float64Array, i: number): number {
  const ax = s[i]!, ay = s[i + 1]!, az = s[i + 2]!;
  const dx = s[i + 3]! - ax, dy = s[i + 4]! - ay, dz = s[i + 5]! - az;
  const len2 = dx * dx + dy * dy + dz * dz;
  const t = len2 > 0 ? Math.min(1, Math.max(0, ((p[0]! - ax) * dx + (p[1]! - ay) * dy + (p[2]! - az) * dz) / len2)) : 0;
  return Math.hypot(p[0]! - ax - t * dx, p[1]! - ay - t * dy, p[2]! - az - t * dz);
}

/**
 * The touching edges a step made: edges of `after` used by more than two triangles that do not lie on one `before`
 * already had. The part's own (an imported part may bring some) are left out wherever they are, and so are those the
 * mesher split differently this time, since both ends and the middle of such a piece lie on the old edge. With `box`,
 * only those that come within 0.5 mm of it count. The whole meshes are read, not the triangles near a tool: an edge four
 * triangles share may have only two of them near the tool, so a count near it said nothing about what changed.
 */
export function newTouchingEdges(before: ArrayLike<number>, after: ArrayLike<number>, box: Box | null = null): { count: number; at: Vec3 | null } {
  const now = touchingSegments(after);
  if (now.length === 0) return { count: 0, at: null };
  const was = touchingSegments(before);
  const cells = new Map<string, number[]>();
  const long: number[] = [];
  const cellOf = (x: number, y: number, z: number) => `${Math.floor(x / EDGE_CELL_MM)},${Math.floor(y / EDGE_CELL_MM)},${Math.floor(z / EDGE_CELL_MM)}`;
  for (let i = 0; i < was.length; i += 6) {
    const lo = [0, 1, 2].map((k) => Math.floor((Math.min(was[i + k]!, was[i + 3 + k]!) - SAME_EDGE_MM) / EDGE_CELL_MM));
    const hi = [0, 1, 2].map((k) => Math.floor((Math.max(was[i + k]!, was[i + 3 + k]!) + SAME_EDGE_MM) / EDGE_CELL_MM));
    if ((hi[0]! - lo[0]! + 1) * (hi[1]! - lo[1]! + 1) * (hi[2]! - lo[2]! + 1) > 64) {
      long.push(i);
      continue;
    }
    for (let x = lo[0]!; x <= hi[0]!; x += 1) {
      for (let y = lo[1]!; y <= hi[1]!; y += 1) {
        for (let z = lo[2]!; z <= hi[2]!; z += 1) {
          const key = `${x},${y},${z}`;
          const row = cells.get(key);
          if (row) row.push(i);
          else cells.set(key, [i]);
        }
      }
    }
  }
  const onOld = (p: number[]) => {
    for (const i of cells.get(cellOf(p[0]!, p[1]!, p[2]!)) ?? []) if (toSegment(p, was, i) <= SAME_EDGE_MM) return true;
    for (const i of long) if (toSegment(p, was, i) <= SAME_EDGE_MM) return true;
    return false;
  };
  const lo = box ? [0, 1, 2].map((k) => Number(box.min[k]) - 0.5) : null;
  const hi = box ? [0, 1, 2].map((k) => Number(box.max[k]) + 0.5) : null;
  let count = 0;
  let at: Vec3 | null = null;
  for (let i = 0; i < now.length; i += 6) {
    const a = [now[i]!, now[i + 1]!, now[i + 2]!];
    const b = [now[i + 3]!, now[i + 4]!, now[i + 5]!];
    const mid = [0, 1, 2].map((k) => (a[k]! + b[k]!) / 2);
    // At the tool when any of the edge is within half a millimetre of its box.
    if (lo && hi && [0, 1, 2].some((k) => Math.max(a[k]!, b[k]!) < lo[k]! || Math.min(a[k]!, b[k]!) > hi[k]!)) continue;
    if (onOld(mid) && onOld(a) && onOld(b)) continue;
    count += 1;
    at ??= mid.map((v) => Math.round(v * 100) / 100) as Vec3;
  }
  return { count, at };
}

export function touchingReason(at: Vec3 | null): string {
  const where = at ? ` at (${at.join(", ")})` : "";
  return `This step would leave pieces that meet only along an edge${where}, which is not a closed solid to print. The step was taken back. Move it so it overlaps the part, or clears it.`;
}

/**
 * At most this many new touching edges, all at a primitive tool, read as a tool placed against the part (moving it
 * fixes that). More, or any away from a tool, is a result Open CASCADE got wrong.
 */
export const FEW_TOUCHING = 4;

/** Why a step whose result Open CASCADE built wrong is taken back: `count` new touching edges, the first at `at`. */
export function damagedReason(count: number, at: Vec3 | null): string {
  const where = at ? `, the first at (${at.join(", ")})` : "";
  return `Open CASCADE returned a damaged solid for this step: ${count} new edge${count === 1 ? "" : "s"} where pieces meet only along a line${where}. model_check and the plate would reject it, so the step was taken back. On an imported part a tool that crosses many faces at once can do this: split the edit into smaller steps, or keep the tool's faces off the part's own faces.`;
}

/**
 * The mesh and the solid disagree about the volume by more than this share, and by more than half of it beyond what
 * they did before the step. A sound mesh of a small round part can be a few percent under its solid (a 1 mm radius at
 * a 0.05 mm chord is about 6 % under); a damaged one has been 25 % over.
 */
const VOLUME_DISAGREES = 0.1;

/**
 * Why a step's result is not a sound solid by its volume, or null: a mesh that holds a different volume from the solid
 * it shows (a damaged cut on an imported part reported +0.68 mm³ while its mesh grew by a quarter). `before` and
 * `after` carry the solid's volume and its mesh; a step whose mesh is not built yet (an empty soup) passes.
 */
export function brokenVolume(before: { volumeMm3: number; positions: ArrayLike<number> }, after: { volumeMm3: number; positions: ArrayLike<number> }): string | null {
  if (!(before.volumeMm3 > 0) || !Number.isFinite(after.volumeMm3)) return null;
  if (before.positions.length < 9 || after.positions.length < 9 || !(after.volumeMm3 > 0)) return null;
  // A mesh that is the solid before's, point for point, was not built for this step, so it says nothing about it.
  if (sameSoup(before.positions, after.positions)) return null;
  const off = (solid: { volumeMm3: number; positions: ArrayLike<number> }) => Math.abs(Math.abs(soupVolume(solid.positions)) - solid.volumeMm3) / solid.volumeMm3;
  const now = off(after);
  if (now > VOLUME_DISAGREES && now > off(before) + VOLUME_DISAGREES / 2) {
    return `Open CASCADE returned a damaged solid for this step: its mesh holds ${mm3(Math.abs(soupVolume(after.positions)))} but the solid reports ${mm3(after.volumeMm3)}. The step was taken back. Split the edit into smaller steps, or keep the tool's faces off the part's own faces.`;
  }
  return null;
}

function sameSoup(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/** Kinds that move or rebuild the whole part, so every touching edge it had is somewhere new: not judged by edges. */
const MOVES_ALL = new Set(["scale", "root"]);

/**
 * What a step's result says about the step, by the meshes before and after: null, or the refusal with `touching` when
 * a primitive tool sits against the part (a shorter tool may clear it) and `damaged` when Open CASCADE built it wrong.
 * `box` is a primitive tool's box. Either mesh missing (a step not meshed yet) skips the edge checks.
 */
export function meshGuard(
  op: { kind: string; op?: string },
  before: { volumeMm3: number; positions: ArrayLike<number> },
  after: { volumeMm3: number; positions: ArrayLike<number> },
  box: Box | null,
  place: (at: Vec3) => Vec3 = (at) => at,
): { reason: string; touching?: true; damaged?: true } | null {
  // The edges first: where pieces meet only along a line says more than a volume that is off.
  if (before.positions.length >= 9 && after.positions.length >= 9 && !MOVES_ALL.has(op.kind)) {
    const fresh = newTouchingEdges(before.positions, after.positions);
    if (fresh.count > 0) {
      const at = fresh.at ? place(fresh.at) : null;
      if (box && fresh.count <= FEW_TOUCHING && newTouchingEdges(before.positions, after.positions, box).count === fresh.count) {
        return { reason: touchingReason(at), touching: true };
      }
      return { reason: damagedReason(fresh.count, at), damaged: true };
    }
  }
  const broken = brokenVolume(before, after);
  return broken ? { reason: broken, damaged: true } : null;
}

/** Why a mesh that does not close stays off the plate, with where the first open and touching edges are: in the solid's frame, as model_check lists them. */
export function notClosedReason(report: EdgeReport): string {
  const at = (p: Vec3) => `(${p.join(", ")})`;
  const parts: string[] = [];
  if (report.open > 0) parts.push(`${report.open} open edge${report.open === 1 ? "" : "s"}${report.openAt[0] ? `, the first at ${at(report.openAt[0].at)}` : ""}`);
  if (report.nonManifold > 0) parts.push(`${report.nonManifold} edge${report.nonManifold === 1 ? "" : "s"} where pieces meet only along a line${report.nonManifoldAt[0] ? `, the first at ${at(report.nonManifoldAt[0].at)}` : ""}`);
  return `The solid's mesh does not close: ${parts.join(", and ")}. It was not put on the plate, because the slicer would have to guess at the gaps. model_check lists where they are; undo or move the step that made them.`;
}
