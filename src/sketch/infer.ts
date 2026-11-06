/**
 * --- K1 (sketch for people, milestone 7): constraints while drawing ---
 * While the Line tool has a point down, the rule the next click would keep is worked out here, shown by the view as a
 * small mark beside the pointer, and stored with the line when the click lands. The rules are the ones SolidWorks,
 * Onshape and Fusion infer: horizontal and vertical near an axis, square to the line before, the same length as the
 * line before, and a point put on a curve. Pure: points and ids in, rules and a point out.
 *
 * Tolerances, all in screen pixels so a rule feels the same at any zoom:
 * - H, V and square (⊥) reach 8 px from the pointer: the existing snap (`interact/snap.ts`, `SNAP_PX`) places the
 *   point on the ray and this module reads the rule off the exact result;
 * - the same length reaches 8 px along the line, the same distance as the snaps, and only beats the grid and a free
 *   point, never an endpoint, midpoint, intersection or curve snap;
 * - what is stored is read off the final geometry with 1e-6 mm of slack, so a rule is kept only when it is true.
 * Ctrl while moving or clicking skips every inference, and the snap's H, V and square with it. A typed length and
 * angle are the person's own numbers and infer nothing.
 */
import { SNAP_PX, type SnapHit } from "../interact/snap.ts";
import { addInferred } from "./constrain.ts";
import { curveOf, curveProject, dist, dot, samePt, sub, unit } from "./geom.ts";
import { pointNear, sketchEntity, sketchPoint, type Pt, type SketchData } from "./model.ts";
import { parseConstraints, type SketchConstraint } from "./solve.ts";

/** What a click keeps. `onEdge` is shown but stored as nothing: a reference edge belongs to the part, not the sketch. */
export type InferRule =
  | { kind: "horizontal" | "vertical" }
  | { kind: "perpendicular" | "equal"; line: number }
  | { kind: "onCurve"; entity: number }
  | { kind: "onEdge" };

export interface Inference {
  /** Where the point goes: the snap's, moved along its ray to the length of the line before when that is close. */
  at: Pt;
  rules: InferRule[];
}

export interface InferMark {
  /** The glyph the view draws, the same one the kept constraint shows afterwards. */
  text: string;
  /** What it says when read, and when hovered. */
  title: string;
  kind: InferRule["kind"];
}

/** The reach of the same-length rule, and of every direction rule, in screen pixels. */
export const INFER_PX = SNAP_PX;

/** A rule must hold this closely, in millimetres, to be kept. */
const EXACT_MM = 1e-6;
/** And two directions are square when their dot product is this small. */
const SQUARE = 1e-9;

/** The snaps that leave the point free along its ray or open, so the same-length rule may move it. */
const FREE: ReadonlySet<string> = new Set(["none", "grid", "horizontal", "vertical", "parallel", "perpendicular"]);

interface Before {
  id: number;
  dir: Pt;
  length: number;
}

/** The line the chain's last segment drew, which the next one is measured against. */
function lineBefore(sketch: SketchData, chain: readonly number[]): Before | null {
  if (chain.length < 2) return null;
  const a = chain[chain.length - 2]!;
  const b = chain[chain.length - 1]!;
  const line = sketch.entities.find((entity) => entity.kind === "line" && ((entity.a === a && entity.b === b) || (entity.a === b && entity.b === a)));
  const from = sketchPoint(sketch, a)?.at;
  const to = sketchPoint(sketch, b)?.at;
  if (!line || !from || !to) return null;
  const dir = unit(sub(to, from));
  return dir ? { id: line.id, dir, length: dist(from, to) } : null;
}

/** The marks a rule list shows, in the order they are read. */
export function inferMarks(rules: readonly InferRule[]): InferMark[] {
  return rules.map((rule) => {
    switch (rule.kind) {
      case "horizontal":
        return { kind: rule.kind, text: "H", title: "Horizontal. The click keeps it level." };
      case "vertical":
        return { kind: rule.kind, text: "V", title: "Vertical. The click keeps it upright." };
      case "perpendicular":
        return { kind: rule.kind, text: "⊥", title: "Square to the line before. The click keeps it." };
      case "equal":
        return { kind: rule.kind, text: "=", title: "Same length as the line before. The click keeps it." };
      case "onCurve":
        return { kind: rule.kind, text: "○", title: "On the line or curve. The click keeps it there." };
      default:
        return { kind: rule.kind, text: "●", title: "On the part's edge. The point lands on it exactly." };
    }
  });
}

/** The rules in words for the status line: "horizontal and the same length as the line before". */
export function inferWords(rules: readonly InferRule[]): string {
  const words = rules
    .filter((rule) => rule.kind !== "onEdge")
    .map((rule) => {
      if (rule.kind === "horizontal") return "horizontal";
      if (rule.kind === "vertical") return "vertical";
      if (rule.kind === "perpendicular") return "square to the last line";
      if (rule.kind === "equal") return "equal to the last line";
      return "on the curve";
    });
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

/** What the next point would keep. With no point down yet, only a curve under the pointer counts. */
export function inferPoint(sketch: SketchData, chain: readonly number[], snap: SnapHit, cursor: Pt, mmPerPx: number): Inference {
  const fromId = chain.length ? chain[chain.length - 1]! : null;
  const from = fromId != null ? sketchPoint(sketch, fromId)?.at : undefined;
  let at: Pt = [snap.at[0], snap.at[1]];
  if (!from || fromId == null) return { at, rules: pointRules(sketch, at, snap, null) };
  // A click on the polyline's start closes it. Two points make no shape to close, so the click keeps nothing.
  const start = sketchPoint(sketch, chain[0]!)?.at;
  if (chain.length === 2 && start && dist(start, at) <= 1e-4) return { at, rules: [] };
  const before = lineBefore(sketch, chain);
  const tol = INFER_PX * Math.max(mmPerPx, 1e-9);
  if (before && FREE.has(snap.kind)) {
    const aim = snap.kind === "none" || snap.kind === "grid" ? cursor : at;
    const bearing = unit(sub(aim, from));
    if (bearing && Math.abs(dist(aim, from) - before.length) <= tol) at = [from[0] + bearing[0] * before.length, from[1] + bearing[1] * before.length];
  }
  return { at, rules: [...segmentRules(sketch, chain, from, at), ...pointRules(sketch, at, snap, fromId)] };
}

/** The rules a line from the chain's last point to `to` holds, read off the geometry. The closing line uses this too. */
export function segmentRules(sketch: SketchData, chain: readonly number[], from: Pt, to: Pt): InferRule[] {
  const before = lineBefore(sketch, chain);
  const rules: InferRule[] = [];
  const run = sub(to, from);
  const length = Math.hypot(run[0], run[1]);
  if (!(length > EXACT_MM)) return rules;
  const level = Math.abs(run[1]) <= EXACT_MM;
  const upright = !level && Math.abs(run[0]) <= EXACT_MM;
  if (level) rules.push({ kind: "horizontal" });
  if (upright) rules.push({ kind: "vertical" });
  if (before) {
    const bearing: Pt = [run[0] / length, run[1] / length];
    // A level line after an upright one is square to it already: the second rule would only repeat the first.
    if (Math.abs(dot(bearing, before.dir)) <= SQUARE && !impliedSquare(sketch, before.id, level ? "horizontal" : upright ? "vertical" : null)) {
      rules.push({ kind: "perpendicular", line: before.id });
    }
    if (Math.abs(length - before.length) <= EXACT_MM) rules.push({ kind: "equal", line: before.id });
  }
  return rules;
}

/** True when the line before already is level (or upright) and the new one is the other way: square comes free. */
function impliedSquare(sketch: SketchData, before: number, now: "horizontal" | "vertical" | null): boolean {
  if (!now) return false;
  const other = now === "horizontal" ? "vertical" : "horizontal";
  return parseConstraints(sketch).some((item) => item.kind === other && "line" in item && item.line === before);
}

/** A point on a sketch curve, or on a reference edge of the part. */
function pointRules(sketch: SketchData, at: Pt, snap: SnapHit, fromId: number | null): InferRule[] {
  const rules: InferRule[] = [];
  for (const entity of curvesAt(sketch, at, fromId)) rules.push({ kind: "onCurve", entity });
  if (snap.kind === "on-edge" && rules.length === 0) rules.push({ kind: "onEdge" });
  return rules;
}

/** The lines, circles and arcs `at` lies on, away from their ends, at most two. A point that is already in the sketch is left alone. */
function curvesAt(sketch: SketchData, at: Pt, fromId: number | null): number[] {
  if (pointNear(sketch, at, 1e-4)) return [];
  const out: number[] = [];
  for (const entity of sketch.entities) {
    if (entity.kind === "spline") continue;
    // A line that starts where this one does would be retraced, not touched.
    if (fromId != null && (entity.kind === "line" || entity.kind === "arc") && (entity.a === fromId || entity.b === fromId)) continue;
    if (entity.kind === "circle" && entity.centre === fromId) continue;
    const curve = curveOf(sketch, entity);
    if (!curve) continue;
    const hit = curveProject(curve, at);
    if (!hit || hit.distance > EXACT_MM) continue;
    if (curve.kind === "line" && (samePt(at, curve.a) || samePt(at, curve.b))) continue;
    out.push(entity.id);
    if (out.length === 2) break;
  }
  return out;
}

/** The rules the first point of a line keeps, once the line that follows it is drawn. */
export function startCurves(rules: readonly InferRule[]): number[] {
  return rules.flatMap((rule) => (rule.kind === "onCurve" ? [rule.entity] : []));
}

/**
 * The sketch with the rules stored on the line just drawn: `line` ends at `end`, and `start` is its first point when
 * that point was put on curves. Everything lands in the one replaced sketch, so undo takes the line and its rules in
 * a single step. A rule the solver refuses or finds repeated is dropped; the line stays.
 */
export function keepRules(sketch: SketchData, line: number, end: number, rules: readonly InferRule[], start?: { point: number; entities: readonly number[] } | null): SketchData {
  const drafts: SketchConstraint[] = [];
  for (const entity of start?.entities ?? []) if (sketchEntity(sketch, entity)) drafts.push({ id: 0, kind: "coincident", point: start!.point, entity });
  for (const rule of rules) {
    if (rule.kind === "horizontal" || rule.kind === "vertical") drafts.push({ id: 0, kind: rule.kind, line });
    else if (rule.kind === "perpendicular" || rule.kind === "equal") drafts.push({ id: 0, kind: rule.kind, a: rule.line, b: line });
    else if (rule.kind === "onCurve") drafts.push({ id: 0, kind: "coincident", point: end, entity: rule.entity });
  }
  return drafts.length ? addInferred(sketch, drafts) : sketch;
}
