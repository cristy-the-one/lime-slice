/**
 * --- B29. Profile loops shared by extrude, revolve, loft and sweep: copies for the engine, a point profile as a loop,
 * a loop drawn into a sketch, and a loop sampled for a ghost. One copy, so the four features cannot drift apart.
 */
import type { ProfileLoop, ProfileSegment, Vec2 } from "../model-tree.ts";
import { arcFrom3, arcPoint, sampleSpline } from "./geom.ts";
import { addArc, addLine, addSpline, type Pt, type SketchData } from "./model.ts";

/** A loop the engine owns: every point copied. */
export function copyLoop(loop: ProfileLoop): ProfileLoop {
  return {
    start: [loop.start[0], loop.start[1]] as Vec2,
    segments: loop.segments.map((segment): ProfileSegment => {
      if (segment.kind === "line") return { kind: "line", to: [segment.to[0], segment.to[1]] };
      if (segment.kind === "arc") return { kind: "arc", through: [segment.through[0], segment.through[1]], to: [segment.to[0], segment.to[1]] };
      return { kind: "spline", through: segment.through.map((pt) => [pt[0], pt[1]] as Vec2), to: [segment.to[0], segment.to[1]] };
    }),
  };
}

export function copyLoops(loops: readonly ProfileLoop[]): ProfileLoop[] {
  return loops.map(copyLoop);
}

/** A point profile as a closed loop of lines. */
export function lineLoop(profile: readonly Vec2[]): ProfileLoop {
  const points = profile.map((pt) => [pt[0], pt[1]] as Vec2);
  const first = points[0] ?? [0, 0];
  const rest = points.slice(1);
  const last = rest[rest.length - 1];
  if (!last || Math.hypot(last[0] - first[0], last[1] - first[1]) > 1e-6) rest.push([first[0], first[1]]);
  return { start: [first[0], first[1]], segments: rest.map((pt) => ({ kind: "line" as const, to: pt })) };
}

/** `loop` drawn into `sketch` as lines, arcs and splines. */
export function drawLoop(sketch: SketchData, loop: ProfileLoop): SketchData {
  let next = sketch;
  let prev: Pt = [loop.start[0], loop.start[1]];
  for (const segment of loop.segments) {
    const to: Pt = [segment.to[0], segment.to[1]];
    if (segment.kind === "line") next = addLine(next, prev, to).sketch;
    else if (segment.kind === "arc") next = addArc(next, prev, to, [segment.through[0], segment.through[1]]).sketch;
    else next = addSpline(next, [prev, ...segment.through.map((pt) => [pt[0], pt[1]] as Pt), to]).sketch;
    prev = to;
  }
  return next;
}

/** Points along `loop` for a ghost: arcs in eight steps, and a spline along its curve, not through its points only. */
export function sampleLoopPoints(loop: ProfileLoop): Pt[] {
  const points: Pt[] = [];
  let prev: Pt = [loop.start[0], loop.start[1]];
  const push = (point: Pt) => {
    const last = points[points.length - 1];
    if (!last || Math.hypot(last[0] - point[0], last[1] - point[1]) > 1e-6) points.push(point);
  };
  push(prev);
  for (const segment of loop.segments) {
    const to: Pt = [segment.to[0], segment.to[1]];
    if (segment.kind === "line") push(to);
    else if (segment.kind === "arc") {
      const arc = arcFrom3(prev, [segment.through[0], segment.through[1]], to);
      if (!arc) push(to);
      else for (let step = 1; step <= 8; step += 1) push(arcPoint(arc, step / 8));
    } else {
      for (const point of sampleSpline([prev, ...segment.through.map((pt) => [pt[0], pt[1]] as Pt), to], false, 1)) push(point);
    }
    prev = to;
  }
  const first = points[0];
  const last = points[points.length - 1];
  if (first && last && Math.hypot(first[0] - last[0], first[1] - last[1]) <= 1e-6) points.pop();
  return points;
}

/** An engine reason as a sentence that ends with a full stop. */
export function sentence(text: string): string {
  const trimmed = text.trim();
  return trimmed.endsWith(".") ? trimmed : `${trimmed}.`;
}
