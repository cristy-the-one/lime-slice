/**
 * --- E1 (`docs/plan-sketch-for-people.md`). Close the gap: one action closes a drawing whose lines don't meet. ---
 *
 * The open ends are the red dots of milestone 1 (`openEnds` in `reasons.ts`). They are paired nearest first. A pair
 * closer than {@link SNAP_GAP_MM} is snapped: the later end moves onto the earlier one and the two become one point,
 * as if the person had dropped it there. A wider pair is joined with a line between the two ends, as if the person
 * had drawn it. Either way the result is ordinary sketch data, so Extrude stores the op it stores for a drawing that
 * was closed by hand.
 */
import { dist } from "./geom.ts";
import { addLine, pointNear, prunePoints, type Dimension, type Pt, type SketchData, type SketchEntity } from "./model.ts";
import { openEnds } from "./reasons.ts";
import { sketchRegions } from "./regions.ts";

/** Ends this close are snapped together instead of joined: under half a nozzle, so the move can't be seen in a print. */
export const SNAP_GAP_MM = 0.2;

const END_MM = 1e-3;

/** One closing step: snap `from` onto `to`, or draw a line between them. */
export interface GapJoin {
  kind: "snap" | "line";
  from: Pt;
  to: Pt;
}

export interface ClosedGap {
  sketch: SketchData;
  joins: GapJoin[];
}

/**
 * The drawing with its open ends closed, or null when closing them makes no new shape (a lone line, ends that
 * would cross the drawing, or nothing open). Nearest pairs go first. An end left over with no partner stays open.
 */
export function closeGap(sketch: SketchData): ClosedGap | null {
  const ends = openEnds(sketch)
    .map((at) => ({ at, id: pointNear(sketch, at, END_MM)?.id }))
    .filter((end): end is { at: Pt; id: number } => end.id != null);
  if (ends.length < 2) return null;
  const pairs: [number, number][] = [];
  for (let i = 0; i < ends.length; i += 1) for (let j = i + 1; j < ends.length; j += 1) pairs.push([i, j]);
  pairs.sort((p, q) => dist(ends[p[0]]!.at, ends[p[1]]!.at) - dist(ends[q[0]]!.at, ends[q[1]]!.at) || p[0] - q[0] || p[1] - q[1]);
  const used = new Set<number>();
  let next = sketch;
  const joins: GapJoin[] = [];
  for (const [i, j] of pairs) {
    if (used.has(i) || used.has(j)) continue;
    const a = ends[i]!;
    const b = ends[j]!;
    // The later point moves onto the earlier one, so the first thing drawn stays where it was put.
    const [keep, move] = a.id < b.id ? [a, b] : [b, a];
    const gap = dist(a.at, b.at);
    const snapped = gap <= SNAP_GAP_MM && !named(next, move.id) ? mergePoint(next, move.id, keep.id) : null;
    if (snapped) {
      next = snapped;
      joins.push({ kind: "snap", from: [move.at[0], move.at[1]], to: [keep.at[0], keep.at[1]] });
    } else {
      next = addLine(next, keep.id, move.id).sketch;
      joins.push({ kind: "line", from: [keep.at[0], keep.at[1]], to: [move.at[0], move.at[1]] });
    }
    used.add(i);
    used.add(j);
  }
  if (joins.length === 0) return null;
  if (sketchRegions(next).length <= sketchRegions(sketch).length) return null;
  return { sketch: next, joins };
}

/** True when a constraint or dimension names the point: moving it would fight the size the person set. */
function named(sketch: SketchData, point: number): boolean {
  return (sketch.dims ?? []).some((dim) => pointFields(dim).some((field) => dim[field] === point));
}

/** The fields of a stored constraint that hold point ids (see `SketchConstraint` in `solve.ts`). */
function pointFields(dim: Dimension): string[] {
  const fields = "point" in dim ? ["point"] : [];
  const twoPoints = (dim.kind === "horizontal" || dim.kind === "vertical" || dim.kind === "distance") && !("line" in dim) && !("point" in dim);
  if (twoPoints) fields.push("a", "b");
  return fields;
}

/** `from` becomes `to` in every entity, and the point `from` goes. Null when an entity would end on itself. */
function mergePoint(sketch: SketchData, from: number, to: number): SketchData | null {
  const swap = (id: number) => (id === from ? to : id);
  const entities: SketchEntity[] = [];
  for (const entity of sketch.entities) {
    if (entity.kind === "line" || entity.kind === "arc") {
      const moved = { ...entity, a: swap(entity.a), b: swap(entity.b) };
      if (moved.a === moved.b) return null;
      entities.push(moved);
    } else if (entity.kind === "circle") entities.push(entity.centre === from ? { ...entity, centre: to } : entity);
    else entities.push({ ...entity, through: entity.through.map(swap) });
  }
  return prunePoints({ ...sketch, entities, points: sketch.points.filter((point) => point.id !== from) });
}
