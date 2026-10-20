/**
 * Solid edges dropped onto the sketch plane (`docs/plan-gui-cad-modeling.md`, Plan B §4.3).
 *
 * The face outline is always kept. An edge that lies in the plane is kept whole. An edge that
 * crosses the plane is kept as its shadow, and the point where it crosses is a vertex a snap
 * can land on. Edges that miss the plane are left out. These lines are reference: they snap,
 * and they are not sketch entities.
 */
import { toPlane, type SketchFrame } from "./frame.ts";
import type { Pt, Vec3 } from "./model.ts";

export interface RefSegment {
  a: Pt;
  b: Pt;
  /** Which solid line this is. Absent on a segment built before that tag existed. */
  source?: "edge" | "outline";
  /** The solid edge a piece came from, so Use copies that whole edge (a circle's 32 pieces are one circle). */
  edge?: number;
}

export interface RefGeom {
  segments: RefSegment[];
  vertices: Pt[];
}

/** An edge this close to the plane, in millimetres, is on it. */
const ON_MM = 0.05;

/**
 * `edges` and `outline` are polylines in the same space as `frame`: xyz, and the outline is
 * packed as segment pairs (six numbers each).
 */
export function projectReferences(
  frame: SketchFrame,
  edges: readonly { points: ArrayLike<number> }[],
  outline: ArrayLike<number> | null,
): RefGeom {
  const segments: RefSegment[] = [];
  const vertices: Pt[] = [];
  const seen = new Set<string>();
  const addVertex = (at: Pt) => {
    const key = `${at[0].toFixed(3)},${at[1].toFixed(3)}`;
    if (seen.has(key)) return;
    seen.add(key);
    vertices.push(at);
  };
  const addSegment = (a: Pt, b: Pt, source: "edge" | "outline", edge?: number) => {
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) <= 1e-6) {
      addVertex(a);
      return;
    }
    segments.push(edge == null ? { a, b, source } : { a, b, source, edge });
    addVertex(a);
    addVertex(b);
    addVertex([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
  };
  if (outline) {
    for (let i = 0; i + 5 < outline.length; i += 6) {
      const a = project(frame, [outline[i]!, outline[i + 1]!, outline[i + 2]!]);
      const b = project(frame, [outline[i + 3]!, outline[i + 4]!, outline[i + 5]!]);
      addSegment(a, b, "outline");
    }
  }
  edges.forEach((edge, index) => {
    const points = edge.points;
    for (let i = 0; i + 5 < points.length; i += 3) {
      const a: Vec3 = [points[i]!, points[i + 1]!, points[i + 2]!];
      const b: Vec3 = [points[i + 3]!, points[i + 4]!, points[i + 5]!];
      const ha = height(frame, a);
      const hb = height(frame, b);
      const onA = Math.abs(ha) <= ON_MM;
      const onB = Math.abs(hb) <= ON_MM;
      if (onA && onB) {
        addSegment(project(frame, a), project(frame, b), "edge", index);
        continue;
      }
      if (onA || onB || ha * hb < 0) {
        addSegment(project(frame, a), project(frame, b), "edge", index);
        if (ha * hb < 0) {
          const t = ha / (ha - hb);
          addVertex(project(frame, [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]));
        }
      }
    }
  });
  return { segments, vertices };
}

/** A run of reference pieces, end to end, as one polyline. */
export interface RefChain {
  points: Pt[];
  closed: boolean;
}

/**
 * The pieces Use copies for a click on `index`: the whole solid edge it is part of, or the one loop of the face outline
 * it is on (not the face's other loops), in order along it.
 */
export function refChain(refs: RefGeom, index: number): RefChain | null {
  const hit = refs.segments[index];
  if (!hit) return null;
  const pool = hit.source === "outline" ? refs.segments.filter((item) => item.source === "outline") : hit.edge != null ? refs.segments.filter((item) => item.edge === hit.edge) : [hit];
  const key = (at: Pt) => `${Math.round(at[0] * 1e4)},${Math.round(at[1] * 1e4)}`;
  const unused = new Set(pool.map((_, i) => i));
  const start = pool.indexOf(hit);
  unused.delete(start);
  const points: Pt[] = [hit.a, hit.b];
  // Walk on from each end of the clicked piece while another piece shares that end.
  for (const forward of [true, false]) {
    for (;;) {
      const end = forward ? points[points.length - 1]! : points[0]!;
      const next = [...unused].find((i) => key(pool[i]!.a) === key(end) || key(pool[i]!.b) === key(end));
      if (next == null) break;
      unused.delete(next);
      const piece = pool[next]!;
      const far = key(piece.a) === key(end) ? piece.b : piece.a;
      if (forward) points.push(far);
      else points.unshift(far);
    }
  }
  const closed = points.length > 3 && key(points[0]!) === key(points[points.length - 1]!);
  if (closed) points.pop();
  return { points, closed };
}

function project(frame: SketchFrame, point: Vec3): Pt {
  return toPlane(frame, point).uv;
}

function height(frame: SketchFrame, point: Vec3): number {
  return toPlane(frame, point).height;
}
