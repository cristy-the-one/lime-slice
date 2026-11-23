/**
 * A `nurbs` profile segment as a curve, read the way the kernel reads it (`closed_spline` in kernel.cpp): a segment
 * that ends where it starts, with at least two interior poles, is ONE periodic curve whose poles are the start and
 * the interior poles. Its start is then a pole, not a point on the curve. Every client consumer samples through here,
 * so the preview, the hit tests and the solid agree.
 */
import { sampleNurbsCurve2DTotal, type NurbsCurve2D } from "../modeling/nurbs-eval.ts";

type P2 = readonly [number, number] | readonly number[];

export interface NurbsSegmentLike {
  poles?: readonly P2[];
  weights?: readonly number[];
  degree?: number;
  knots?: readonly number[];
  mults?: readonly number[];
  to: P2;
}

/** The kernel's `same_point` tolerance (kProfileMm). */
const SAME_MM = 1e-6;

/** True when the kernel builds this segment as one closed periodic curve. */
export function nurbsSegmentClosed(from: P2, segment: NurbsSegmentLike): boolean {
  return (segment.poles?.length ?? 0) >= 2
    && Math.abs(from[0]! - segment.to[0]!) <= SAME_MM
    && Math.abs(from[1]! - segment.to[1]!) <= SAME_MM;
}

/** The curve a `nurbs` segment from `from` stands for: clamped through its end poles, or periodic when closed. */
export function nurbsSegmentCurve(from: P2, segment: NurbsSegmentLike): NurbsCurve2D {
  const interior = (segment.poles ?? []).map((pt) => [pt[0]!, pt[1]!] as [number, number]);
  const closed = nurbsSegmentClosed(from, segment);
  const poles: [number, number][] = closed
    ? [[from[0]!, from[1]!], ...interior]
    : [[from[0]!, from[1]!], ...interior, [segment.to[0]!, segment.to[1]!]];
  return {
    poles,
    ...(segment.weights && segment.weights.length === poles.length ? { weights: segment.weights } : {}),
    ...(segment.degree !== undefined ? { degree: segment.degree } : {}),
    ...(segment.knots && segment.knots.length > 0 ? { knots: segment.knots } : {}),
    ...(segment.mults && segment.mults.length > 0 ? { mults: segment.mults } : {}),
    ...(closed ? { periodic: true } : {}),
  };
}

/** Points along a `nurbs` segment: about 8 per pole (at least 16) over the whole curve. A closed one starts and ends on the curve, not at its first pole. */
export function sampleNurbsSegment(from: P2, segment: NurbsSegmentLike): [number, number][] {
  const curve = nurbsSegmentCurve(from, segment);
  return sampleNurbsCurve2DTotal(curve, Math.max(16, curve.poles.length * 8));
}

/** True when `loop`'s start is a pole of a closed `nurbs` segment rather than a point on the outline. */
export function loopStartsOffCurve(loop: { start: P2; segments: readonly ({ kind: string } & Partial<NurbsSegmentLike>)[] }): boolean {
  const first = loop.segments[0];
  return loop.segments.length === 1 && first?.kind === "nurbs" && first.to !== undefined && nurbsSegmentClosed(loop.start, first as NurbsSegmentLike);
}
