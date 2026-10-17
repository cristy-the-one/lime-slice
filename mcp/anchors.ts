// Where a labelled step is: the box of the tool each step applied, in the part's frame, and anchors that read a point
// of it. Any [x, y, z] in an op may be {anchor: "bowl", point: "top", offset: [0, 0, 2]}, resolved when that op's turn
// comes, so it follows the step it names when that step is edited, and sees steps an earlier op of the same batch made.

import { eulerOrient } from "../src/mesh-place.ts";
import { primitiveBox } from "../src/model-feasibility.ts";
import type { ModelOp } from "../src/model-tree.ts";
import { splinePoints } from "./sweep.ts";

type V3 = [number, number, number];
export interface Box {
  min: V3;
  max: V3;
}

export const ANCHOR_POINTS = ["centre", "top", "bottom", "min", "max", "left", "right", "front", "back"] as const;

function grow(box: Box | null, p: readonly number[]): Box {
  if (!box) return { min: [p[0]!, p[1]!, p[2]!], max: [p[0]!, p[1]!, p[2]!] };
  for (let i = 0; i < 3; i += 1) {
    box.min[i] = Math.min(box.min[i]!, p[i]!);
    box.max[i] = Math.max(box.max[i]!, p[i]!);
  }
  return box;
}

export function unionBox(a: Box | null, b: Box | null): Box | null {
  if (!a) return b ? { min: [...b.min], max: [...b.max] } : null;
  if (!b) return a;
  return grow(grow({ min: [...a.min], max: [...a.max] }, b.min), b.max);
}

/** A plane's U, V, W from its turn, as columns. */
function axes(turn: readonly number[]): [V3, V3, V3] {
  const m = eulerOrient(turn[0] ?? 0, turn[1] ?? 0, turn[2] ?? 0);
  return [[m[0]!, m[3]!, m[6]!], [m[1]!, m[4]!, m[7]!], [m[2]!, m[5]!, m[8]!]];
}

const along = (o: readonly number[], d: readonly (readonly [V3, number])[]): V3 => {
  const p: V3 = [o[0]!, o[1]!, o[2]!];
  for (const [axis, k] of d) for (let i = 0; i < 3; i += 1) p[i] += axis[i]! * k;
  return p;
};

/** A circle's box: its centre, and its radius along each axis the circle's plane spans. */
function circleBox(box: Box | null, centre: readonly number[], normal: V3, radius: number): Box {
  const len = Math.hypot(normal[0], normal[1], normal[2]) || 1;
  const reach = normal.map((n) => radius * Math.sqrt(Math.max(0, 1 - (n / len) ** 2)));
  return grow(grow(box, centre.map((c, i) => c - reach[i]!)), centre.map((c, i) => c + reach[i]!));
}

/**
 * A profile's outline as points: its own points, or for a smooth one points along the splines the kernel draws
 * through them (closed, or broken at its corners), so a box of them holds the curve where it bulges past its points.
 */
function reach(profile: readonly (readonly number[])[], smooth: boolean | undefined, corners: readonly number[] = []): [number, number][] {
  const points = profile.map(([u, v]) => [u!, v!, 0] as [number, number, number]);
  if (!smooth || points.length < 3) return points.map(([u, v]) => [u, v]);
  const runs: [number, number, number][][] = [];
  const sharp = [...new Set(corners)].filter((c) => c >= 0 && c < points.length).sort((a, b) => a - b);
  if (sharp.length === 0) runs.push([...points, points[0]!]);
  else {
    sharp.forEach((from, k) => {
      const to = sharp[(k + 1) % sharp.length]!;
      const run = [points[from]!];
      for (let i = from; i !== to; ) {
        i = (i + 1) % points.length;
        run.push(points[i]!);
      }
      runs.push(run);
    });
  }
  return runs.flatMap((run) => (run.length > 2 ? splinePoints(run, 12) : run)).map(([u, v]) => [u, v]);
}

/** The box of the tool a stored op applies, in the solid's frame, or null for an op with no tool of its own. */
export function opBox(op: ModelOp): Box | null {
  switch (op.kind) {
    case "boolean":
      return primitiveBox(op);
    case "extrude": {
      const [u, v, w] = axes(op.turn);
      const length = Math.abs(op.depth);
      const start = op.symmetric ? -length / 2 : Math.min(op.depth, 0);
      let box: Box | null = null;
      for (const [pu, pv] of reach(op.profile, op.smooth, op.corners)) for (const pw of [start, start + length]) box = grow(box, along(op.origin, [[u, pu], [v, pv], [w, pw]]));
      return box;
    }
    case "revolve": {
      const [u, v] = axes(op.turn);
      const [au, av] = op.axisOrigin ?? [0, 0];
      const [du, dv] = op.axisDir ?? [0, 1];
      const dl = Math.hypot(du, dv) || 1;
      const dir: V3 = [0, 1, 2].map((i) => (u[i]! * du + v[i]! * dv) / dl) as V3;
      const base = along(op.origin, [[u, au], [v, av]]);
      let box: Box | null = null;
      for (const [pu, pv] of reach(op.profile, op.smooth, op.corners)) {
        const p = along(op.origin, [[u, pu], [v, pv]]);
        const rel = [p[0] - base[0], p[1] - base[1], p[2] - base[2]];
        const t = rel[0]! * dir[0] + rel[1]! * dir[1] + rel[2]! * dir[2];
        const foot = [0, 1, 2].map((i) => base[i]! + dir[i]! * t);
        const r = Math.hypot(...[0, 1, 2].map((i) => p[i]! - foot[i]!));
        box = circleBox(box, foot, dir, r);
      }
      return box;
    }
    case "loft": {
      let box: Box | null = null;
      for (const section of op.sections) {
        const [u, v, w] = axes(section.turn);
        if (section.radius !== undefined) box = circleBox(box, section.origin, w, Math.max(section.radius, section.radiusV ?? 0));
        else for (const [pu, pv] of reach(section.profile ?? [], section.smooth, section.corners)) box = grow(box, along(section.origin, [[u, pu], [v, pv]]));
      }
      return box;
    }
    case "hole": {
      const len = Math.hypot(...op.axis) || 1;
      const dir = op.axis.map((n) => n / len) as V3;
      const end = op.origin.map((o, i) => o + dir[i]! * op.depth);
      const radius = Math.max(op.radius, op.counterboreRadius ?? 0);
      return circleBox(circleBox(null, op.origin, dir, radius), end, dir, radius);
    }
    default:
      return null;
  }
}

/** A box moved into another frame by `to`, as the box of its moved corners. */
export function movedBox(box: Box, to: (p: V3) => V3): Box {
  let out: Box | null = null;
  for (let corner = 0; corner < 8; corner += 1) {
    out = grow(out, to([corner & 1 ? box.max[0] : box.min[0], corner & 2 ? box.max[1] : box.min[1], corner & 4 ? box.max[2] : box.min[2]]));
  }
  return out!;
}

/** The point an anchor names on a box. */
export function boxPoint(box: Box, point: string): V3 | null {
  const c = box.min.map((v, i) => (v + box.max[i]!) / 2) as V3;
  switch (point) {
    case "centre": return c;
    case "top": return [c[0], c[1], box.max[2]];
    case "bottom": return [c[0], c[1], box.min[2]];
    case "min": return [...box.min];
    case "max": return [...box.max];
    case "left": return [box.min[0], c[1], c[2]];
    case "right": return [box.max[0], c[1], c[2]];
    case "front": return [c[0], box.min[1], c[2]];
    case "back": return [c[0], box.max[1], c[2]];
    default: return null;
  }
}

const round = (n: number) => Math.round(n * 1e6) / 1e6;

/**
 * `value` with every anchor replaced by its point: an object with `anchor` (a step label, a batch label, or "part"),
 * `point` (default centre), and `offset`. `find` gives the box a label names, or null. Nested ops are walked too.
 */
export function resolveAnchors(value: unknown, find: (label: string) => Box | null, path = "op"): unknown {
  if (Array.isArray(value)) return value.map((item, i) => resolveAnchors(item, find, `${path}[${i}]`));
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  if (typeof record.anchor === "string" && record.kind === undefined) {
    const extra = Object.keys(record).find((key) => key !== "anchor" && key !== "point" && key !== "offset");
    if (extra) throw new AnchorError(`${path}.${extra} is not an anchor field. Use anchor, point, and offset.`);
    const box = find(record.anchor);
    if (!box) throw new AnchorError(`${path}: no step is labelled "${record.anchor}" with a tool to measure. model_anchors lists the labels.`);
    const point = boxPoint(box, typeof record.point === "string" ? record.point : "centre");
    if (!point) throw new AnchorError(`${path}.point is one of ${ANCHOR_POINTS.join(", ")}.`);
    const offset = Array.isArray(record.offset) ? record.offset : [0, 0, 0];
    if (offset.length !== 3 || !offset.every((n) => typeof n === "number" && Number.isFinite(n))) throw new AnchorError(`${path}.offset is [x, y, z] in millimetres.`);
    return point.map((p, i) => round(p + (offset[i] as number)));
  }
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(record)) out[key] = resolveAnchors(child, find, `${path}.${key}`);
  return out;
}

export class AnchorError extends Error {}

/** Whether a value holds an anchor anywhere. */
export function hasAnchor(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasAnchor);
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (typeof record.anchor === "string" && record.kind === undefined) return true;
  return Object.values(record).some(hasAnchor);
}

/** A label as a box's row for model_anchors. */
export function anchorRow(label: string, box: Box): Record<string, unknown> {
  const r = (p: readonly number[]) => p.map((n) => Math.round(n * 1000) / 1000);
  return { label, min: r(box.min), max: r(box.max), centre: r(boxPoint(box, "centre")!), size: r(box.max.map((v, i) => v - box.min[i]!)) };
}
