/**
 * What the view draws for a sketch: grid, reference, entities, the rubber band, and the
 * origin planes shown while choosing. Positions are in the same space as the frame.
 */
import { curveOf, pointOn } from "./geom.ts";
import { toWorld, type SketchFrame } from "./frame.ts";
import type { Pt, Vec3 } from "./model.ts";
import { activeSketch, rubber, type SketchEditor } from "./session.ts";

export type StrokeRole = "grid" | "ref" | "entity" | "selected" | "construction" | "rubber" | "hint" | "axis" | "refuse";

export interface SketchStroke {
  xyz: number[];
  role: StrokeRole;
}

export interface SketchDot {
  at: Vec3;
  role: "point" | "selected" | "hover";
}

export interface SketchQuad {
  corners: [Vec3, Vec3, Vec3, Vec3];
  hot: boolean;
}

export interface SketchMesh {
  strokes: SketchStroke[];
  dots: SketchDot[];
  quads: SketchQuad[];
}

export interface OriginPlane {
  name: "XY" | "XZ" | "YZ" | "workplane";
  frame: SketchFrame;
  half: number;
}

/** Lines and dots for the open sketch, plus the planes offered while choosing. */
export function sketchMesh(editor: SketchEditor, frame: SketchFrame | null, grid: readonly { a: Pt; b: Pt }[], planes: readonly OriginPlane[]): SketchMesh {
  const strokes: SketchStroke[] = [];
  const dots: SketchDot[] = [];
  const quads: SketchQuad[] = planes.map((plane) => ({
    corners: quad(plane.frame, plane.half),
    hot: editor.hotPlane === plane.name,
  }));
  if (!frame || editor.phase !== "editing") return { strokes, dots, quads };
  for (const line of grid) strokes.push({ xyz: seg(frame, line.a, line.b), role: "grid" });
  for (const line of editor.refs.segments) strokes.push({ xyz: seg(frame, line.a, line.b), role: "ref" });
  const sketch = activeSketch(editor);
  if (!sketch) return { strokes, dots, quads };
  const selected = new Set(editor.selection.entities);
  for (const entity of sketch.entities) {
    const curve = curveOf(sketch, entity);
    if (!curve) continue;
    const samples = curveSamples(curve);
    // Selected and hovered win over the construction style, so a construction line can be seen to be picked.
    const role: StrokeRole = selected.has(entity.id) ? "selected" : editor.hover.entity === entity.id ? "hint" : entity.construction ? "construction" : "entity";
    strokes.push({ xyz: flat(frame, samples), role });
  }
  const band = rubber(editor);
  if (band && band.length >= 2) strokes.push({ xyz: flat(frame, band), role: "rubber" });
  if (editor.snap?.from) strokes.push({ xyz: seg(frame, editor.snap.from, editor.snap.at), role: "hint" });
  const selectedPoints = new Set(editor.selection.points);
  for (const point of sketch.points) {
    const role = selectedPoints.has(point.id) ? "selected" : editor.hover.point === point.id ? "hover" : "point";
    dots.push({ at: toWorld(frame, point.at), role });
  }
  return { strokes, dots, quads };
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

