/**
 * Words for a two-point measure, shared by Prepare's point-to-point Measure and Model's Measure tool: what a point is
 * snapped to, and the distance and per-axis change between two of them. Pure, in millimetres.
 */
import { MEASURE_KIND_LABEL, type MeasureKind, type Vec3 } from "./measure-snap.ts";

/** A point a measure was put on. `kind` is "surface" when it landed on a face with no feature near it. */
export interface PickedPoint {
  at: Vec3;
  kind: MeasureKind | "surface";
  /** What the object is called, when more than one is on screen. */
  object?: string;
}

function mm(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return Object.is(rounded, -0) ? "0" : String(rounded);
}

/** "Vertex · Cube", or "Surface · Cube" when no feature was near. */
export function pointLabel(point: Pick<PickedPoint, "kind" | "object">): string {
  const kind = point.kind === "surface" ? "Surface" : MEASURE_KIND_LABEL[point.kind];
  return point.object ? `${kind} · ${point.object}` : kind;
}

export interface Between {
  distance: number;
  delta: Vec3;
}

export function between(a: Vec3, b: Vec3): Between {
  const delta: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  return { distance: Math.hypot(delta[0], delta[1], delta[2]), delta };
}

/** The distance and the change on each axis, as one sentence: Model's note and Prepare's readout both open with it. */
export function distanceText(a: Vec3, b: Vec3): string {
  const { distance, delta } = between(a, b);
  return `Distance ${mm(distance)} mm. ΔX ${mm(delta[0])}, ΔY ${mm(delta[1])}, ΔZ ${mm(delta[2])} mm.`;
}

/** What each end is snapped to, for a point that was put there by a pick. Empty when neither was. */
export function endsText(a: PickedPoint | null | undefined, b: PickedPoint | null | undefined): string {
  const parts: string[] = [];
  if (a) parts.push(`A: ${pointLabel(a)}.`);
  if (b) parts.push(`B: ${pointLabel(b)}.`);
  return parts.join(" ");
}

/** The readout as lines: the distance, the change on each axis, then what each end is on. */
export function readoutLines(a: PickedPoint, b: PickedPoint): string[] {
  const { distance, delta } = between(a.at, b.at);
  return [
    `Distance ${mm(distance)} mm`,
    `ΔX ${mm(delta[0])} · ΔY ${mm(delta[1])} · ΔZ ${mm(delta[2])} mm`,
    `A: ${pointLabel(a)}`,
    `B: ${pointLabel(b)}`,
  ];
}

/** The whole readout for two picked points. */
export function pickedText(a: PickedPoint, b: PickedPoint): string {
  return `${distanceText(a.at, b.at)} ${endsText(a, b)}`;
}
