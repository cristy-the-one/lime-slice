/**
 * What the view draws for a sketch: grid, reference, entities, the rubber band, and the
 * origin planes shown while choosing. Positions are in the same space as the frame.
 */
import { trimPieces } from "./edit.ts";
import { curveOf, dist, pointOn } from "./geom.ts";
import { toWorld, type SketchFrame } from "./frame.ts";
import type { Pt, Vec3 } from "./model.ts";
import { refChain } from "./refs.ts";
import { activeSketch, ghosts, rubber, trimHover, type SketchEditor } from "./session.ts";

/** `refHot` is a reference edge Copy edge would copy, brightened under the pointer (U1). */
export type StrokeRole = "grid" | "ref" | "refHot" | "entity" | "selected" | "construction" | "rubber" | "hint" | "axis" | "refuse";

export interface SketchStroke {
  xyz: number[];
  role: StrokeRole;
}

export interface SketchDot {
  at: Vec3;
  role: "point" | "selected" | "hover" | "refuse";
}

export interface SketchQuad {
  corners: [Vec3, Vec3, Vec3, Vec3];
  hot: boolean;
}

export interface SketchMesh {
  strokes: SketchStroke[];
  dots: SketchDot[];
  quads: SketchQuad[];
  /** What the Edit tools show, for the canvas dataset: Trim's pieces and its red one, Copy edge's bright edges. */
  shown?: { trimPieces: number; trimHot: string; refHot: number };
}

/** T1: the gap left at each crossing end of a piece while Trim is on, in screen pixels. */
const TRIM_GAP_PX = 7;

export interface OriginPlane {
  name: "XY" | "XZ" | "YZ" | "workplane";
  frame: SketchFrame;
  half: number;
}

/** Lines and dots for the open sketch, plus the planes offered while choosing. `mmPerPx` sizes Trim's gaps. */
export function sketchMesh(editor: SketchEditor, frame: SketchFrame | null, grid: readonly { a: Pt; b: Pt }[], planes: readonly OriginPlane[], mmPerPx = 0): SketchMesh {
  const strokes: SketchStroke[] = [];
  const dots: SketchDot[] = [];
  const quads: SketchQuad[] = planes.map((plane) => ({
    corners: quad(plane.frame, plane.half),
    hot: editor.hotPlane === plane.name,
  }));
  if (!frame || editor.phase !== "editing") return { strokes, dots, quads };
  for (const line of grid) strokes.push({ xyz: seg(frame, line.a, line.b), role: "grid" });
  const hotRefs = editor.tool === "use" ? hotReferences(editor) : new Set<number>();
  editor.refs.segments.forEach((line, index) => strokes.push({ xyz: seg(frame, line.a, line.b), role: hotRefs.has(index) ? "refHot" : "ref" }));
  const shown = { trimPieces: 0, trimHot: "", refHot: hotRefs.size };
  const sketch = activeSketch(editor);
  if (!sketch) return { strokes, dots, quads, shown };
  const selected = new Set(editor.selection.entities);
  // T1: with Trim on, every line is drawn as its pieces, a small gap at each crossing, the one a click removes in red.
  const trimming = editor.tool === "trim";
  const hot = trimming ? trimHover(editor) : null;
  const gap = mmPerPx > 0 ? mmPerPx * TRIM_GAP_PX : 0;
  for (const entity of sketch.entities) {
    const curve = curveOf(sketch, entity);
    if (!curve) continue;
    // Selected and hovered win over the construction style, so a construction line can be seen to be picked.
    const role: StrokeRole = selected.has(entity.id) ? "selected" : editor.hover.entity === entity.id ? "hint" : entity.construction ? "construction" : "entity";
    const pieces = trimming ? trimPieces(sketch, entity.id) : null;
    if (!pieces) {
      strokes.push({ xyz: flat(frame, curveSamples(curve)), role });
      continue;
    }
    pieces.pieces.forEach((piece, index) => {
      const red = hot?.entity === entity.id && hot.crossed && hot.piece === index;
      if (red) shown.trimHot = `${entity.id}:${index}`;
      shown.trimPieces += 1;
      strokes.push({ xyz: flat(frame, inset(piece.samples, piece.cut, gap)), role: red ? "refuse" : selected.has(entity.id) ? "selected" : entity.construction ? "construction" : "entity" });
    });
  }
  const pieces = ghosts(editor);
  if (pieces) for (const piece of pieces) if (piece.length >= 2) strokes.push({ xyz: flat(frame, piece), role: "rubber" });
  const band = pieces ? null : rubber(editor);
  if (band && band.length >= 2) strokes.push({ xyz: flat(frame, band), role: "rubber" });
  if (editor.snap?.from) strokes.push({ xyz: seg(frame, editor.snap.from, editor.snap.at), role: "hint" });
  const selectedPoints = new Set(editor.selection.points);
  for (const point of sketch.points) {
    const role = selectedPoints.has(point.id) ? "selected" : editor.hover.point === point.id ? "hover" : "point";
    dots.push({ at: toWorld(frame, point.at), role });
  }
  return { strokes, dots, quads, shown };
}

/** U1: the reference segments Copy edge would copy for the pointer: the edge under it, or the face's whole outline. */
function hotReferences(editor: SketchEditor): Set<number> {
  const out = new Set<number>();
  const { index, face } = editor.hoverRef;
  if (face) {
    editor.refs.segments.forEach((segment, i) => {
      if (segment.source === "outline") out.add(i);
    });
    return out;
  }
  if (index == null) return out;
  const chain = refChain(editor.refs, index);
  if (!chain) return out;
  const key = (at: Pt) => `${Math.round(at[0] * 1e4)},${Math.round(at[1] * 1e4)}`;
  const keys = new Set(chain.points.map(key));
  const hit = editor.refs.segments[index]!;
  editor.refs.segments.forEach((segment, i) => {
    const same = hit.source === "outline" ? segment.source === "outline" : hit.edge != null ? segment.edge === hit.edge : i === index;
    if (same && keys.has(key(segment.a)) && keys.has(key(segment.b))) out.add(i);
  });
  return out;
}

/** T1: a piece drawn short of each crossing end by `gap`, at most a quarter of its length, so pieces read apart. */
function inset(samples: readonly Pt[], cut: readonly [boolean, boolean], gap: number): Pt[] {
  if (gap <= 0 || samples.length < 2) return [...samples];
  let length = 0;
  for (let i = 0; i + 1 < samples.length; i += 1) length += dist(samples[i]!, samples[i + 1]!);
  const trim = Math.min(gap, length / 4);
  let out = [...samples];
  if (cut[0]) out = cutFront(out, trim);
  if (cut[1]) out = cutFront(out.reverse(), trim).reverse();
  return out;
}

function cutFront(points: Pt[], amount: number): Pt[] {
  let left = amount;
  for (let i = 0; i + 1 < points.length; i += 1) {
    const a = points[i]!;
    const b = points[i + 1]!;
    const step = dist(a, b);
    if (step >= left && step > 0) {
      const t = left / step;
      return [[a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], ...points.slice(i + 1)];
    }
    left -= step;
  }
  return points.slice(-2);
}


function curveSamples(curve: NonNullable<ReturnType<typeof curveOf>>): Pt[] {
  if (curve.kind === "line") return [curve.a, curve.b];
  if (curve.kind === "circle") {
    const out: Pt[] = [];
    for (let i = 0; i <= 32; i += 1) out.push(pointOn(curve, i / 32));
    return out;
  }
  if (curve.kind === "arc") {
    const out: Pt[] = [];
    for (let i = 0; i <= 16; i += 1) out.push(pointOn(curve, i / 16));
    return out;
  }
  return curve.samples;
}

function quad(frame: SketchFrame, half: number): [Vec3, Vec3, Vec3, Vec3] {
  return [
    toWorld(frame, [-half, -half]),
    toWorld(frame, [half, -half]),
    toWorld(frame, [half, half]),
    toWorld(frame, [-half, half]),
  ];
}

function seg(frame: SketchFrame, a: Pt, b: Pt): number[] {
  return [...toWorld(frame, a), ...toWorld(frame, b)];
}

function flat(frame: SketchFrame, points: readonly Pt[]): number[] {
  const out: number[] = [];
  for (const point of points) out.push(...toWorld(frame, point));
  return out;
}

