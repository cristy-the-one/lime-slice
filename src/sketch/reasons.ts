/**
 * --- P1 and P3 (`docs/plan-sketch-for-people.md`). What each sketch-card button is for, why a Make button is greyed,
 * in the drawing's words, and where the viewport marks the problem. ---
 *
 * Every reason ends with what to do next (R1), checked by `reasons.test.ts` for every reason in `src/sketch/`.
 */
import type { Vec3 } from "../model-tree.ts";
import { arcPoint, curveOf, curveProject, type Curve } from "./geom.ts";
import type { Pt, SketchData } from "./model.ts";
import type { RevolveAxis } from "./revolve.ts";
import { SHARP_DEG, turningDeg } from "./sweep.ts";

export type EditButton = "select" | "trim" | "offset" | "constrain" | "construction" | "fillet" | "use";
export type MakeButton = "extrude" | "revolve" | "loft" | "sweep" | "holes";
export type CardButton = EditButton | MakeButton;

/** The Edit row, in the card's order. */
export const EDIT_BUTTONS: readonly EditButton[] = ["select", "trim", "offset", "constrain", "construction", "fillet", "use"];
/** The Make row, in the card's order. */
export const MAKE_BUTTONS: readonly MakeButton[] = ["extrude", "revolve", "loft", "sweep", "holes"];

/**
 * R4: what each button is for, before its key. The Construction and Use lines do not repeat the button's name, so
 * they read the same once the labels become "Helper line" and "Copy edge" (plan C1 and U1).
 */
export const PURPOSE: Readonly<Record<CardButton, string>> = {
  select: "Pick and drag lines and points. Drag across empty space to pick several.",
  trim: "Cut away the part of a line between crossings, to clean up a drawing.",
  offset: "Copy a line or outline at a distance, for walls and borders.",
  constrain: "Lock how lines relate (level, square, same length) and set exact sizes.",
  construction: "Helper lines for axes and symmetry. They snap but aren't part of the shape.",
  fillet: "Round off a corner where two lines meet.",
  use: "Copy an edge of your part into the sketch, to draw from it.",
  extrude: "Push a shape into a solid, or cut it into the part.",
  revolve: "Spin a shape around a line, like a lathe: cups, knobs, wheels.",
  loft: "Blend between shapes at different heights: square to round, a bottle neck.",
  sweep: "Carry a shape along a route: pipes, handles, cable guides.",
  holes: "Drill a hole at each point or circle you drew on a face.",
};

/**
 * R4 for the buttons that appear only when they help: Close the gap beside a drawing with open ends, and Add a shape
 * above in a loft with one section.
 */
export const ASSIST_PURPOSE = {
  closeGap: "Join the red open ends, so the lines close a shape. Ctrl+Z undoes it.",
  above: "Start the next section on a plane above, with a copy of this shape to edit.",
  backToLoft: "Keep this shape and go back to the loft, with both sections picked.",
} as const;

/** True for either open-ends reason: both mark the red ends. */
export function namesOpenEnds(reason: string | undefined): boolean {
  return reason === REASON.openEnds || reason === REASON.openEndsClose;
}

/** A greyed button's tip: what it is for, then why it is greyed. */
export function blockedTip(idle: string, why: string): string {
  if (!why) return idle;
  return idle ? `${idle}\n${why}` : why;
}

/** Why a Make button or Apply is greyed. Each names what is missing in the drawing and how to fix it. */
export const REASON = {
  noSketch: "There is no open sketch. Click Sketch, then a face or a plane.",
  empty: "Nothing is drawn yet. Draw a closed shape: a rectangle (R), a circle (C), or lines that end where they started (L).",
  openEnds: "Your lines don't close a shape yet, so the red ends need to meet. Drag one onto the other, or trim the overhang (T).",
  /** E1: the same, when Close the gap can join them. */
  openEndsClose: "Your lines don't close a shape yet, so the red ends need to meet. Click Close the gap, or drag one end onto the other.",
  onlyHelpers: "Only helper lines are drawn, and they aren't part of a shape. Draw the outline with solid lines, or press X on a helper line to make it solid.",
  noShape: "Your lines cross but don't close one shape. Trim the pieces that stick out (T), so one outline is left.",
  pickExtrude: "Click inside the shape to extrude.",
  pickRevolveStart: "Click inside the shape to spin.",
  pickRevolve: "Click the shape to spin, then the line to spin it around.",
  crossAxis: "The shape crosses the axis. Pick a line beside the shape, or move the shape off it.",
  loftSecond: "A loft needs a second shape at another height. Click another sketch's card, or a flat face of the part.",
  /** L1: the same, when the open sketch's one shape can be copied up. */
  loftAbove: "A loft needs a second shape at another height. Click Add a shape above, or another sketch's card.",
  /** L1: the many-shapes refusal for the shape above, which names what to delete. */
  manyRegionsAbove: "The sketch above has more than one shape. Delete the ones the loft shouldn't use, then click Back to loft.",
  sweepNothing: "A sweep needs a shape and a route. Draw a closed shape to carry and an open line for it to follow.",
  sweepProfile: "The sweep has no shape to carry yet. Click a closed shape, here or on another sketch's card.",
  sweepRoute: "The sweep has no route yet. Draw an open line for the shape to follow, or Shift-click edges of the part.",
  manyRegionsLoft: "That sketch has more than one shape. Click the one to loft in the view.",
  manyRegionsSweep: "That sketch has more than one shape. Click the one to sweep in the view.",
  noRegionLoft: "That sketch has no closed shape. Close its lines, or click another sketch.",
  nothingToSweep: "That sketch has no closed shape and no open line. Click another sketch, or draw one here.",
} as const;

/** Why a sketch with no shape has none: nothing drawn, ends that don't meet, only helper lines, or crossings. */
export function noShapeReason(sketch: SketchData): string {
  const solid = sketch.entities.filter((entity) => !entity.construction);
  if (sketch.entities.length === 0) return REASON.empty;
  if (solid.length === 0) return REASON.onlyHelpers;
  if (openEnds(sketch).length > 0) return REASON.openEnds;
  return REASON.noShape;
}

const KEY_MM = 1e-3;

/**
 * R2: the ends of solid lines, arcs and splines that meet nothing: no other end and no other line passes through them.
 * A circle and a closed spline have no ends. These are the red dots of {@link REASON.openEnds}.
 */
export function openEnds(sketch: SketchData): Pt[] {
  const curves: Curve[] = [];
  for (const entity of sketch.entities) {
    if (entity.construction) continue;
    const curve = curveOf(sketch, entity);
    if (curve) curves.push(curve);
  }
  const ends: { at: Pt; owner: number }[] = [];
  curves.forEach((curve, owner) => {
    const pair = endsOf(curve);
    if (pair) ends.push({ at: pair[0], owner }, { at: pair[1], owner });
  });
  const key = (pt: Pt) => `${Math.round(pt[0] / KEY_MM)}_${Math.round(pt[1] / KEY_MM)}`;
  const count = new Map<string, number>();
  for (const end of ends) count.set(key(end.at), (count.get(key(end.at)) ?? 0) + 1);
  const out: Pt[] = [];
  const seen = new Set<string>();
  for (const end of ends) {
    const k = key(end.at);
    if ((count.get(k) ?? 0) !== 1 || seen.has(k)) continue;
    const touches = curves.some((curve, index) => index !== end.owner && (curveProject(curve, end.at)?.distance ?? Infinity) <= KEY_MM);
    if (touches) continue;
    seen.add(k);
    out.push([end.at[0], end.at[1]]);
  }
  return out;
}

function endsOf(curve: Curve): [Pt, Pt] | null {
  if (curve.kind === "line") return [curve.a, curve.b];
  if (curve.kind === "arc") return [arcPoint(curve.arc, 0), arcPoint(curve.arc, 1)];
  if (curve.kind === "circle" || curve.closed) return null;
  return [curve.controls[0]!, curve.controls[curve.controls.length - 1]!];
}

/** R2: the route points a sweep refuses as sharp corners, by the same rule as `sharpCorner` in `sweep.ts`. */
export function sharpCorners(path: readonly Vec3[], check?: readonly boolean[]): Vec3[] {
  const out: Vec3[] = [];
  for (let i = 1; i < path.length - 1; i += 1) {
    if (check && !check[i]) continue;
    const a = path[i - 1]!;
    const b = path[i]!;
    const c = path[i + 1]!;
    if (turningDeg([b[0] - a[0], b[1] - a[1], b[2] - a[2]], [c[0] - b[0], c[1] - b[1], c[2] - b[2]]) > SHARP_DEG) out.push([b[0], b[1], b[2]]);
  }
  return out;
}

/** R2: where a closed outline (sampled, in sketch space) crosses the revolve axis from one side to the other. */
export function axisCrossings(samples: readonly Pt[], axis: RevolveAxis): Pt[] {
  const side = (pt: Pt) => (pt[0] - axis.origin[0]) * axis.dir[1] - (pt[1] - axis.origin[1]) * axis.dir[0];
  const out: Pt[] = [];
  const n = samples.length;
  for (let i = 0; i < n; i += 1) {
    const a = samples[i]!;
    const b = samples[(i + 1) % n]!;
    const sa = side(a);
    const sb = side(b);
    if ((sa < -1e-6 && sb > 1e-6) || (sa > 1e-6 && sb < -1e-6)) {
      const t = sa / (sa - sb);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out;
}

const ACTION_VERBS = new Set([
  "add", "click", "close", "copy", "delete", "drag", "draw", "drop", "extend", "finish", "give", "keep", "make", "move", "open", "pick",
  "press", "put", "round", "select", "set", "shift-click", "split", "start", "trim", "type", "use",
]);

/** R1: true when the reason's last sentence tells the person what to do, starting with a verb such as Click or Draw. */
export function endsWithAction(text: string): boolean {
  const sentences = text
    .replace(/\$\{[^}]*\}/g, "N")
    .split(/(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const last = sentences[sentences.length - 1];
  if (!last || !/[.!?]$/.test(last)) return false;
  const first = last.split(/[\s,:]/)[0]!.toLowerCase();
  return ACTION_VERBS.has(first);
}
