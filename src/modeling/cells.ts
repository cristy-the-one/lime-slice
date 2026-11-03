/**
 * I20 (docs/plan-recipe-ingredients.md): an array whose cell is loops. The cell is laid out on the face's lattice as any
 * array cell is (pitch, stagger, angleDeg about the face's middle, turnDeg about the cell's own centre), and every copy
 * becomes loops of one extrude. The kernel clips each cell to the face's outline less the margin, drops slivers, rounds
 * the corners, and cuts or raises every cell in one boolean.
 */
import type { BooleanKind, ProfileLoop, ProfileSegment, Vec2 } from "../model-tree.ts";

/** How far a cut cell starts outside the face and a raised one sinks into it, as `cellSpan` in compose.ts lays shape cells. */
const CUT_PAST = 1;
const BOSS_SINK = 0.2;

/** The most loops one extrude takes (I18). */
export const MAX_LOOPS = 1000;

type UV = [number, number];

function turned(p: readonly number[], deg: number): UV {
  if (deg === 0) return [p[0]!, p[1]!];
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [p[0]! * c - p[1]! * s, p[0]! * s + p[1]! * c];
}

/** Every point a loop names: its start, each segment's end and through points. */
function loopPoints(loop: ProfileLoop): Vec2[] {
  const points: Vec2[] = [loop.start];
  for (const segment of loop.segments) {
    if (segment.kind === "arc") points.push(segment.through);
    if (segment.kind === "spline") points.push(...segment.through);
    points.push(segment.to);
  }
  return points;
}

function moved(loop: ProfileLoop, deg: number, at: UV): ProfileLoop {
  const place = (p: readonly number[]): Vec2 => {
    const q = turned(p, deg);
    return [q[0] + at[0], q[1] + at[1]];
  };
  const segments = loop.segments.map((segment): ProfileSegment => {
    if (segment.kind === "arc") return { kind: "arc", through: place(segment.through), to: place(segment.to) };
    if (segment.kind === "spline") return { kind: "spline", through: segment.through.map(place), to: place(segment.to) };
    return { kind: "line", to: place(segment.to) };
  });
  return { start: place(loop.start), segments };
}

export interface CellLayout {
  /** The cell's loops, about its centre. */
  cell: ProfileLoop[];
  /** The face's extent in its frame, from which the lattice is laid and past which no cell can reach. */
  extent: { u: [number, number]; v: [number, number] };
  pitch: [number, number];
  stagger: boolean;
  angleDeg: number;
  turnDeg: number;
}

/** The cell copied to every lattice point whose copy can reach the face: the loops of one extrude. */
export function latticeLoops(layout: CellLayout): ProfileLoop[] | { reason: string } {
  const { cell, extent, pitch, stagger, angleDeg, turnDeg } = layout;
  const reachOfCell = Math.max(...cell.flatMap(loopPoints).map((p) => Math.hypot(p[0], p[1])));
  const mid: UV = [(extent.u[0] + extent.u[1]) / 2, (extent.v[0] + extent.v[1]) / 2];
  const reach = Math.hypot(extent.u[1] - extent.u[0], extent.v[1] - extent.v[0]) / 2 + Math.max(pitch[0], pitch[1]);
  const rows = Math.ceil(reach / pitch[1]);
  const cols = Math.ceil(reach / pitch[0]) + 1;
  const loops: ProfileLoop[] = [];
  for (let j = -rows; j <= rows; j += 1) {
    const shift = stagger && Math.abs(j) % 2 === 1 ? pitch[0] / 2 : 0;
    for (let i = -cols; i <= cols; i += 1) {
      const local = turned([i * pitch[0] + shift, j * pitch[1]], angleDeg);
      const at: UV = [mid[0] + local[0], mid[1] + local[1]];
      const off = at[0] + reachOfCell < extent.u[0] || at[0] - reachOfCell > extent.u[1] || at[1] + reachOfCell < extent.v[0] || at[1] - reachOfCell > extent.v[1];
      if (off) continue;
      for (const loop of cell) loops.push(moved(loop, angleDeg + turnDeg, at));
      if (loops.length > MAX_LOOPS) {
        return { reason: `This array makes more than ${MAX_LOOPS} loops. Use a larger pitch, fewer loops per cell, or split the face into regions.` };
      }
    }
  }
  if (loops.length === 0) return { reason: "No cell reaches that face. Use a smaller pitch." };
  return loops;
}

/**
 * The extrude's span on the face's plane: a cut cell runs `depth` into the face and starts CUT_PAST outside it, so its
 * tool never shares the face's plane; a raised one sinks BOSS_SINK into it. `draftDeg` leans each wall in toward the
 * cell's far end: the kernel's draft shrinks the +W end for a positive angle, so a cut takes the angle reversed.
 */
export function cellExtent(op: BooleanKind, depth: number, draftDeg: number): { depth: number; depth2: number; draftDeg?: number } {
  const span = op === "fuse" ? { depth: depth, depth2: BOSS_SINK } : { depth: CUT_PAST, depth2: depth };
  return { ...span, ...(draftDeg !== 0 ? { draftDeg: op === "fuse" ? draftDeg : -draftDeg } : {}) };
}
