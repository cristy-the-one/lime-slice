/**
 * The Text card's live preview (docs/plan-text-on-curves-and-fonts.md, milestone 1). The engine lays the text out (`textLayout`,
 * a few milliseconds: the same reader and layout the build uses) and answers each letter's outline as polylines in the plane's own
 * U and V. This turns them into the ghost drawn on the face, raised or cut by the depth, with the letters too thin for the nozzle
 * in the failed colour, and says which letters those are. The picker's sample line is CSS and needs none of this.
 */
import { ShapeUtils, Vector2 } from "three";
import { treeCall } from "../app/step-solids";
import { eulerOrient } from "../mesh-place";
import type { ModelGhost } from "../model-view";
import type { LetteringOp } from "../model-tree";

export interface LaidFace {
  ch: string;
  /** The outer loop, then its holes, as [u, v] points. */
  loops: [number, number][][];
  thin: boolean;
}

export interface TextLayout {
  ok: true;
  font: string;
  faces: LaidFace[];
  thin: { ch: string; lostPct: number }[];
  thinNote: string | null;
  inkMm2: number;
}

type Held = TextLayout | { error: string } | "pending";

const held = new Map<string, Held>();
const MAX_HELD = 24;

/** What the layout depends on: the same fields the engine reads, and the nozzle the thin letters are judged against. */
function keyOf(step: LetteringOp, nozzleMm: number): string {
  return JSON.stringify([step.text, step.font, step.style, step.height, step.spacing, step.lineSpacing, step.align, step.angleDeg, step.weight, step.strokeWidth, nozzleMm]);
}

/** The engine's layout of `step`, or null until it answers (`ready` is called then); an error is a sentence. */
export function layoutOf(step: LetteringOp, nozzleMm: number, ready: () => void): TextLayout | { error: string } | null {
  const key = keyOf(step, nozzleMm);
  const known = held.get(key);
  if (known && known !== "pending") {
    // Most recent last, so the oldest goes first.
    held.delete(key);
    held.set(key, known);
    return known;
  }
  if (known === "pending") return null;
  held.set(key, "pending");
  if (held.size > MAX_HELD) {
    const oldest = held.keys().next().value;
    if (oldest !== undefined) held.delete(oldest);
  }
  void treeCall({
    call: "textLayout",
    text: step.text,
    font: step.font,
    ...(step.style ? { style: step.style } : {}),
    height: step.height,
    ...(step.spacing !== undefined ? { spacing: step.spacing } : {}),
    ...(step.lineSpacing !== undefined ? { lineSpacing: step.lineSpacing } : {}),
    ...(step.align ? { align: step.align } : {}),
    ...(step.angleDeg ? { angleDeg: step.angleDeg } : {}),
    ...(step.weight !== undefined ? { weight: step.weight } : {}),
    ...(step.strokeWidth !== undefined ? { strokeWidth: step.strokeWidth } : {}),
    lineMm: nozzleMm,
    stepMm: 0.1,
  }).then((reply) => {
    held.set(key, reply.ok === true && Array.isArray(reply.faces) ? (reply as unknown as TextLayout) : { error: typeof reply.error === "string" ? reply.error : "The letters could not be laid out." });
    ready();
  });
  return null;
}

/** Forget every layout, as when the engine restarts. */
export function forgetLayouts() {
  held.clear();
  heldCurved.clear();
}

/** Triangles of a face: its outline and holes, flat on the plane at height `w`, facing +W. */
function cap(face: LaidFace, w: number, out: number[], at: (u: number, v: number, w: number) => [number, number, number]) {
  const [outer, ...holes] = face.loops;
  if (!outer || outer.length < 3) return;
  const contour = outer.map(([u, v]) => new Vector2(u, v));
  const inner = holes.map((hole) => hole.map(([u, v]) => new Vector2(u, v)));
  const points = [...contour, ...inner.flat()];
  for (const [a, b, c] of ShapeUtils.triangulateShape(contour, inner)) {
    const [p, q, r] = [points[a!]!, points[b!]!, points[c!]!];
    // Counter-clockwise from +W; the triangulator does not promise a winding.
    const flip = (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x) < 0;
    for (const point of flip ? [p, r, q] : [p, q, r]) out.push(...at(point.x, point.y, w));
  }
}

/** The wall along every edge of every loop of `face`, from the plane to height `w`. */
function walls(face: LaidFace, w: number, out: number[], at: (u: number, v: number, w: number) => [number, number, number]) {
  for (const loop of face.loops) {
    for (let i = 0; i < loop.length; i += 1) {
      const [u0, v0] = loop[i]!;
      const [u1, v1] = loop[(i + 1) % loop.length]!;
      const [a, b, c, d] = [at(u0, v0, 0), at(u1, v1, 0), at(u1, v1, w), at(u0, v0, w)];
      out.push(...a, ...b, ...c, ...a, ...c, ...d);
    }
  }
}

/**
 * The preview of `step` (in the solid's own frame, the frame ghosts are drawn in): the letters as a prism raised from the face,
 * green, or cut into it, red; the letters too thin for the nozzle drawn apart in the refusal colour. Null until the engine has
 * laid the text out, or when it cannot.
 */
export function lettersGhost(step: LetteringOp, nozzleMm: number, ready: () => void): ModelGhost | null {
  const laid = layoutOf(step, nozzleMm, ready);
  if (!laid || "error" in laid) return null;
  const m = eulerOrient(step.turn[0], step.turn[1], step.turn[2]);
  const at = (u: number, v: number, w: number): [number, number, number] => [
    step.origin[0] + m[0] * u + m[1] * v + m[2] * w,
    step.origin[1] + m[3] * u + m[4] * v + m[5] * w,
    step.origin[2] + m[6] * u + m[7] * v + m[8] * w,
  ];
  const height = step.op === "cut" ? -step.depth : step.depth;
  const ok: number[] = [];
  const flagged: number[] = [];
  for (const face of laid.faces) {
    const into = face.thin ? flagged : ok;
    cap(face, height, into, at);
    walls(face, height, into, at);
  }
  if (ok.length + flagged.length < 9) return null;
  return { kind: "soup", positions: Float32Array.from(ok), tone: step.op === "cut" ? "cut" : "add", ...(flagged.length >= 9 ? { flagged: Float32Array.from(flagged) } : {}) };
}

/** The letters of `step` too thin for the nozzle, as the sentence under Apply; null when none, or not laid out yet. */
export function thinNoteOf(step: LetteringOp, nozzleMm: number, ready: () => void): string | null {
  const laid = layoutOf(step, nozzleMm, ready);
  return laid && !("error" in laid) ? laid.thinNote : null;
}

// --- Milestones 2 and 3: text on a cylinder, a cone, a sphere, a torus or a freeform face. The engine lays the letters out on the face under the anchor (`textCurved`): each
// loop's points in the layout, on the face, and on the top (or the floor), all in the solid's own frame.

export interface CurvedLoop {
  uv: [number, number][];
  base: [number, number, number][];
  top: [number, number, number][];
}

export interface CurvedLayout {
  ok: true;
  font: string;
  surface: string;
  faces: { ch: string; thin: boolean; loops: CurvedLoop[] }[];
  thin: { ch: string; lostPct: number }[];
  thinNote: string | null;
  crossesSeam: boolean;
  /** The way round along the baseline, when the walk was long enough to find it. */
  wayRoundMm: number | null;
}

/** Which solid and node the engine reads the anchor on. */
export interface Anchored {
  key: string;
  node: number;
}

type HeldCurved = CurvedLayout | { error: string } | "pending";
const heldCurved = new Map<string, HeldCurved>();

function curvedKey(step: LetteringOp, on: Anchored, nozzleMm: number): string {
  return JSON.stringify([on.key, on.node, step.origin, step.text, step.font, step.style, step.height, step.depth, step.op, step.spacing, step.lineSpacing, step.align, step.angleDeg, step.along, step.flip, step.weight, step.wrap, step.strokeWidth, nozzleMm]);
}

/** The engine's layout of `step` on the cylinder or cone under its origin, or null until it answers (`ready` is called then). */
export function curvedLayoutOf(step: LetteringOp, on: Anchored, nozzleMm: number, ready: () => void): CurvedLayout | { error: string } | null {
  const key = curvedKey(step, on, nozzleMm);
  const known = heldCurved.get(key);
  if (known && known !== "pending") {
    heldCurved.delete(key);
    heldCurved.set(key, known);
    return known;
  }
  if (known === "pending") return null;
  heldCurved.set(key, "pending");
  if (heldCurved.size > MAX_HELD) {
    const oldest = heldCurved.keys().next().value;
    if (oldest !== undefined) heldCurved.delete(oldest);
  }
  void treeCall({
    call: "textCurved",
    key: on.key,
    node: on.node,
    point: step.origin,
    text: step.text,
    font: step.font,
    ...(step.style ? { style: step.style } : {}),
    height: step.height,
    depth: step.depth,
    cut: step.op === "cut",
    ...(step.spacing !== undefined ? { spacing: step.spacing } : {}),
    ...(step.lineSpacing !== undefined ? { lineSpacing: step.lineSpacing } : {}),
    ...(step.align ? { align: step.align } : {}),
    ...(step.angleDeg ? { angleDeg: step.angleDeg } : {}),
    ...(step.along ? { along: step.along } : {}),
    ...(step.flip ? { flip: true } : {}),
    ...(step.weight !== undefined ? { weight: step.weight } : {}),
    ...(step.strokeWidth !== undefined ? { strokeWidth: step.strokeWidth } : {}),
    ...(step.wrap ? { wrap: step.wrap } : {}),
    lineMm: nozzleMm,
    stepMm: 0.4,
  }).then((reply) => {
    heldCurved.set(key, reply.ok === true && Array.isArray(reply.faces) ? (reply as unknown as CurvedLayout) : { error: typeof reply.error === "string" ? reply.error : "The letters could not be laid out." });
    ready();
  });
  return null;
}

/** Forget every curved layout (the solid changed, or the engine restarted). */
export function forgetCurvedLayouts() {
  heldCurved.clear();
}

/** The ghost of text on a cylinder or a cone: the letters' walls and caps between the face and the top (or the floor). */
export function curvedLettersGhost(step: LetteringOp, on: Anchored, nozzleMm: number, ready: () => void): ModelGhost | null {
  const laid = curvedLayoutOf(step, on, nozzleMm, ready);
  if (!laid || "error" in laid) return null;
  const ok: number[] = [];
  const flagged: number[] = [];
  for (const face of laid.faces) {
    const out = face.thin ? flagged : ok;
    const [outer, ...holes] = face.loops;
    if (!outer || outer.uv.length < 3) continue;
    const contour = outer.uv.map(([u, v]) => new Vector2(u, v));
    const inner = holes.map((hole) => hole.uv.map(([u, v]) => new Vector2(u, v)));
    const tops = [...outer.top, ...holes.flatMap((hole) => hole.top)];
    const points = [...contour, ...inner.flat()];
    for (const [a, b, c] of ShapeUtils.triangulateShape(contour, inner)) {
      const [p, q, r] = [points[a!]!, points[b!]!, points[c!]!];
      // Counter-clockwise from outside: the layout is right-handed with the outward normal; the triangulator does not promise a winding.
      const flip = (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x) < 0;
      for (const index of flip ? [a!, c!, b!] : [a!, b!, c!]) out.push(...tops[index]!);
    }
    for (const loop of face.loops) {
      for (let i = 0; i < loop.base.length; i += 1) {
        const j = (i + 1) % loop.base.length;
        const [a, b, c, d] = [loop.base[i]!, loop.base[j]!, loop.top[j]!, loop.top[i]!];
        out.push(...a, ...b, ...c, ...a, ...c, ...d);
      }
    }
  }
  if (ok.length + flagged.length < 9) return null;
  return { kind: "soup", positions: Float32Array.from(ok), tone: step.op === "cut" ? "cut" : "add", ...(flagged.length >= 9 ? { flagged: Float32Array.from(flagged) } : {}) };
}

/** The letters of a curved `step` too thin for the nozzle, as the sentence under Apply; null when none, or not laid out yet. */
export function curvedThinNoteOf(step: LetteringOp, on: Anchored, nozzleMm: number, ready: () => void): string | null {
  const laid = curvedLayoutOf(step, on, nozzleMm, ready);
  return laid && !("error" in laid) ? laid.thinNote : null;
}
