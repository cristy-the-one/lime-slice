/**
 * Checks on a step the kernel has already applied, for results Open CASCADE reports as done but that are not what
 * the step meant: a fuse that hands back only the tool, a cut that takes more than its tool, a fillet that loses most
 * of the part, or a piece that meets the part only along an edge. The session takes such a step back and refuses it.
 */
import { edgeReport, type EdgeReport, type Vec3 } from "../src/mesh-check.ts";

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

export function touchingReason(at: Vec3 | null): string {
  const where = at ? ` at (${at.join(", ")})` : "";
  return `This step would leave pieces that meet only along an edge${where}, which is not a closed solid to print. The step was taken back. Move it so it overlaps the part, or clears it.`;
}

/** Why a mesh that does not close stays off the plate, with where the first open and touching edges are. */
export function notClosedReason(report: EdgeReport, toPart: (p: Vec3) => readonly number[]): string {
  const at = (p: Vec3) => `(${toPart(p).map((v) => Math.round(v * 100) / 100).join(", ")})`;
  const parts: string[] = [];
  if (report.open > 0) parts.push(`${report.open} open edge${report.open === 1 ? "" : "s"}${report.openAt[0] ? `, the first at ${at(report.openAt[0].at)}` : ""}`);
  if (report.nonManifold > 0) parts.push(`${report.nonManifold} edge${report.nonManifold === 1 ? "" : "s"} where pieces meet only along a line${report.nonManifoldAt[0] ? `, the first at ${at(report.nonManifoldAt[0].at)}` : ""}`);
  return `The solid's mesh does not close: ${parts.join(", and ")}. It was not put on the plate, because the slicer would have to guess at the gaps. model_check lists where they are; undo or move the step that made them.`;
}
