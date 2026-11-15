/**
 * Contact in poses (docs/plan-contact-poses.md): drive one joint from where it stands until a part it moves first
 * touches another, as a pose solve. Shared by the window (animation reads) and the MCP server; no DOM, no kernel.
 *
 * Contact is the mesh pass's (`interference`, src/interference.ts) on the triangles each part holds in its own frame.
 * The search is conservative advancement: each pose moves no point of the moving parts farther than the least distance
 * between them and the parts they may touch (`meshDistance`), with a floor of FLOOR_MM of travel, so it cannot step over
 * a part and has no step to choose. The first pose that crosses is bisected against the last that did not, to the
 * tolerance in mm of travel. Every pose is made from the assembly as given, so the same question gives the same answer.
 */
import { bodyOf, jointAt, solveAssembly, type Assembly, type PoseOf } from "./assembly.ts";
import { trainTurn, type Turned } from "./gear-train.ts";
import { interference, treeOf } from "./interference.ts";
import { boundsOf } from "./mesh-place.ts";
import { applyPose, inversePose, poseScale, thenPose, type Affine } from "./model-space.ts";

type V = [number, number, number];

/** The clearance a contact answer leaves at most, by default, mm. */
export const CONTACT_TOLERANCE_MM = 0.01;
/** Tighter than this the mesh pass's own 0.001 mm contact band decides, not the search. */
export const MIN_TOLERANCE_MM = 0.002;
export const MAX_TOLERANCE_MM = 1;
/** The least travel of one search step, mm: only a feature thinner than this across its motion can be stepped over. */
export const FLOOR_MM = 0.05;
/** A search that needs more poses than this is refused. */
export const MAX_EVALUATIONS = 5000;
/** The point speed is measured at the start of each step; a motion whose speed changes along the turn (a planet) gets this margin. */
const SPEED_MARGIN = 1.1;
/** Default range: degrees for a hinge. A slide's default is its limit. */
export const DEFAULT_MAX_DEG = 360;
export const MAX_RANGE_DEG = 3600;
export const MAX_RANGE_MM = 10000;

/** A part's triangles in its own part frame, as the animation export takes them. */
export interface ContactPart { object: string; positions: Float32Array }
export interface Placed { positions: Float32Array; pose: Affine }

// --- Distances between triangles (after Ericson, Real-Time Collision Detection, 5.1).

const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const along = (a: V, d: V, s: number): V => [a[0] + d[0] * s, a[1] + d[1] * s, a[2] + d[2] * s];
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

/** Squared distance between segments p1q1 and p2q2. */
export function segmentDistance2(p1: V, q1: V, p2: V, q2: V): number {
  const d1 = sub(q1, p1), d2 = sub(q2, p2), r = sub(p1, p2);
  const a = dot(d1, d1), e = dot(d2, d2), f = dot(d2, r);
  let s: number, t: number;
  if (a <= 1e-24 && e <= 1e-24) return dot(r, r);
  if (a <= 1e-24) { s = 0; t = clamp01(f / e); } else {
    const c = dot(d1, r);
    if (e <= 1e-24) { t = 0; s = clamp01(-c / a); } else {
      const b = dot(d1, d2), denom = a * e - b * b;
      s = denom > 1e-24 ? clamp01((b * f - c * e) / denom) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = clamp01(-c / a); } else if (t > 1) { t = 1; s = clamp01((b - c) / a); }
    }
  }
  const w = sub(along(p1, d1, s), along(p2, d2, t));
  return dot(w, w);
}

/** The point of triangle abc nearest p. */
export function closestOnTriangle(p: V, a: V, b: V, c: V): V {
  const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a);
  const d1 = dot(ab, ap), d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return a;
  const bp = sub(p, b), d3 = dot(ab, bp), d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return b;
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return along(a, ab, d1 / (d1 - d3));
  const cp = sub(p, c), d5 = dot(ab, cp), d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return c;
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return along(a, ac, d2 / (d2 - d6));
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) return along(b, sub(c, b), (d4 - d3) / (d4 - d3 + (d5 - d6)));
  const sum = va + vb + vc;
  if (!(Math.abs(sum) > 1e-30)) {
    // A degenerate triangle: its nearest edge point.
    const edges: [V, V][] = [[a, b], [b, c], [c, a]];
    let best = a, bestD = Infinity;
    for (const [u, w] of edges) {
      const d = sub(w, u), l = dot(d, d);
      const q = l > 0 ? along(u, d, clamp01(dot(sub(p, u), d) / l)) : u;
      const e = sub(p, q), dd = dot(e, e);
      if (dd < bestD) { bestD = dd; best = q; }
    }
    return best;
  }
  const v = vb / sum, w = vc / sum;
  return [a[0] + ab[0] * v + ac[0] * w, a[1] + ab[1] * v + ac[1] * w, a[2] + ab[2] * v + ac[2] * w];
}

/** Whether segment pq passes through triangle abc. */
function segmentHits(p: V, q: V, a: V, b: V, c: V): boolean {
  const dir = sub(q, p), e1 = sub(b, a), e2 = sub(c, a);
  const h = cross(dir, e2), det = dot(e1, h);
  if (Math.abs(det) < 1e-18) return false;
  const s = sub(p, a), u = dot(s, h) / det;
  if (u < 0 || u > 1) return false;
  const qv = cross(s, e1), v = dot(dir, qv) / det;
  if (v < 0 || u + v > 1) return false;
  const t = dot(e2, qv) / det;
  return t >= 0 && t <= 1;
}

/** The least distance between two triangles: 0 when they meet. */
export function triangleDistance(t: [V, V, V], u: [V, V, V]): number {
  for (let i = 0; i < 3; i += 1) {
    if (segmentHits(t[i]!, t[(i + 1) % 3]!, u[0], u[1], u[2])) return 0;
    if (segmentHits(u[i]!, u[(i + 1) % 3]!, t[0], t[1], t[2])) return 0;
  }
  let best = Infinity;
  for (let i = 0; i < 3; i += 1) {
    const p = t[i]!, onU = sub(p, closestOnTriangle(p, u[0], u[1], u[2]));
    best = Math.min(best, dot(onU, onU));
    const q = u[i]!, onT = sub(q, closestOnTriangle(q, t[0], t[1], t[2]));
    best = Math.min(best, dot(onT, onT));
    for (let j = 0; j < 3; j += 1) best = Math.min(best, segmentDistance2(t[i]!, t[(i + 1) % 3]!, u[j]!, u[(j + 1) % 3]!));
  }
  return Math.sqrt(best);
}

/**
 * The least distance between two triangle meshes at their poses, mm. A box tree over each (the tree `interference`
 * builds and keeps) is searched pair by pair, with the best distance so far as the bound. Poses are rigid, or carry one
 * uniform scale.
 */
export function meshDistance(a: Placed, b: Placed): number {
  const ta = treeOf(a.positions), tb = treeOf(b.positions);
  if (ta.nodes === 0 || tb.nodes === 0) return Infinity;
  const scale = poseScale(a.pose);
  // b's triangles come into a's own frame.
  const rel = thenPose(b.pose, inversePose(a.pose));
  const boxB = new Float64Array(tb.nodes * 6);
  const boxReady = new Uint8Array(tb.nodes);
  const countB = Math.floor(tb.positions.length / 9);
  const moved = new Float64Array(countB * 9);
  const movedReady = new Uint8Array(countB);
  const boxOf = (n: number): number => {
    const o = n * 6;
    if (boxReady[n]) return o;
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let k = 0; k < 8; k += 1) {
      const p = applyPose(rel, [tb.boxes[o + (k & 1 ? 3 : 0)]!, tb.boxes[o + 1 + (k & 2 ? 3 : 0)]!, tb.boxes[o + 2 + (k & 4 ? 3 : 0)]!]);
      if (p[0] < x0) x0 = p[0];
      if (p[1] < y0) y0 = p[1];
      if (p[2] < z0) z0 = p[2];
      if (p[0] > x1) x1 = p[0];
      if (p[1] > y1) y1 = p[1];
      if (p[2] > z1) z1 = p[2];
    }
    boxB.set([x0, y0, z0, x1, y1, z1], o);
    boxReady[n] = 1;
    return o;
  };
  const triA = (t: number): [V, V, V] => {
    const o = t * 9, p = ta.positions;
    return [[p[o]!, p[o + 1]!, p[o + 2]!], [p[o + 3]!, p[o + 4]!, p[o + 5]!], [p[o + 6]!, p[o + 7]!, p[o + 8]!]];
  };
  const triB = (t: number): [V, V, V] => {
    const o = t * 9;
    if (!movedReady[t]) {
      const p = tb.positions;
      for (let v = 0; v < 9; v += 3) moved.set(applyPose(rel, [p[o + v]!, p[o + v + 1]!, p[o + v + 2]!]), o + v);
      movedReady[t] = 1;
    }
    return [[moved[o]!, moved[o + 1]!, moved[o + 2]!], [moved[o + 3]!, moved[o + 4]!, moved[o + 5]!], [moved[o + 6]!, moved[o + 7]!, moved[o + 8]!]];
  };
  const gap = (na: number, nb: number): number => {
    const oa = na * 6, ob = boxOf(nb);
    let sum = 0;
    for (let k = 0; k < 3; k += 1) {
      const d = Math.max(0, ta.boxes[oa + k]! - boxB[ob + 3 + k]!, boxB[ob + k]! - ta.boxes[oa + 3 + k]!);
      sum += d * d;
    }
    return Math.sqrt(sum);
  };
  const extentA = (n: number) => { const o = n * 6; return Math.max(ta.boxes[o + 3]! - ta.boxes[o]!, ta.boxes[o + 4]! - ta.boxes[o + 1]!, ta.boxes[o + 5]! - ta.boxes[o + 2]!); };
  const extentB = (n: number) => { const o = boxOf(n); return Math.max(boxB[o + 3]! - boxB[o]!, boxB[o + 4]! - boxB[o + 1]!, boxB[o + 5]! - boxB[o + 2]!); };
  let best = Infinity;
  const visit = (na: number, nb: number, bound: number): void => {
    if (best <= 0 || bound >= best) return;
    const leafA = ta.left[na]! < 0, leafB = tb.left[nb]! < 0;
    if (leafA && leafB) {
      for (let i = ta.start[na]!; i < ta.end[na]!; i += 1) {
        const t = triA(ta.order[i]!);
        for (let j = tb.start[nb]!; j < tb.end[nb]!; j += 1) {
          const d = triangleDistance(t, triB(tb.order[j]!));
          if (d < best) best = d;
          if (best <= 0) return;
        }
      }
      return;
    }
    if (!leafA && (leafB || extentA(na) >= extentB(nb))) {
      const l = ta.left[na]!, r = ta.right[na]!, dl = gap(l, nb), dr = gap(r, nb);
      if (dl <= dr) { visit(l, nb, dl); visit(r, nb, dr); } else { visit(r, nb, dr); visit(l, nb, dl); }
    } else {
      const l = tb.left[nb]!, r = tb.right[nb]!, dl = gap(na, l), dr = gap(na, r);
      if (dl <= dr) { visit(na, l, dl); visit(na, r, dr); } else { visit(na, r, dr); visit(na, l, dl); }
    }
  };
  visit(0, 0, gap(0, 0));
  return best * scale;
}

/** Two parts at their poses: crossing by the mesh pass (distance then 0, its depth unmeasured), or their least distance. */
export function pairState(a: Placed, b: Placed): { crossing: boolean; mm: number } {
  const result = interference(a, b);
  if (result.verdict === "crossing" || result.nested) return { crossing: true, mm: 0 };
  return { crossing: false, mm: meshDistance(a, b) };
}

// --- The solve.

export interface ContactAsk {
  /** The part to drive: its body's joint moves (a hinge or a slide), with its train. */
  object: string;
  /** +1 or -1: the joint's own sense. */
  dir: number;
  /** A member that does not move with the joint, or "any". */
  against: string;
  /** Degrees for a hinge, mm for a slide. Default 360 degrees, or a slide's limit that way. */
  max?: number;
  toleranceMm?: number;
  /** Names for the sentences; the id when absent. */
  nameOf?: (object: string) => string;
}

export interface ContactPair { moving: string; other: string }

export interface ContactAnswer {
  /** The member whose joint was driven, and its kind. */
  body: string;
  kind: "hinge" | "slide";
  /** The joint where it stood. */
  from: number;
  contact: boolean;
  /** The joint at contact, or at the end of the range when there is none. */
  value: number;
  /** The first value found crossing, within tolerance of travel past `value`. */
  past?: number;
  pair?: ContactPair;
  /** The least distance between the pair at `value`, mm. */
  clearanceMm?: number;
  searched: { from: number; to: number; limit: boolean };
  toleranceMm: number;
  evaluations: number;
  /** Pairs left out because they already crossed where the joint stood. */
  ignored: ContactPair[];
  /** The assembly posed at `value`, and the train's joints there. */
  assembly: Assembly;
  angles: Turned["angles"];
}

const sameAffine = (p: Affine | undefined, q: Affine | undefined) => !!p && !!q && p.m.every((v, k) => Math.abs(v - q.m[k]!) <= 1e-9) && p.t.every((v, k) => Math.abs(v - q.t[k]!) <= 1e-9);

/**
 * Drive `ask.object`'s joint from where it stands, in `ask.dir`, until a part it moves first touches `ask.against` (or
 * any member that stays), to `ask.toleranceMm`. Nothing is changed: the answer holds the posed assembly for a caller
 * that applies it. A question that has no answer is refused with one sentence.
 */
export function firstContact(assembly: Assembly, poseOf: PoseOf, parts: readonly ContactPart[], ask: ContactAsk): ContactAnswer | { reason: string } {
  const name = ask.nameOf ?? ((id: string) => id);
  if (ask.dir !== 1 && ask.dir !== -1) return { reason: "dir is 1 or -1: the joint's own sense, or against it." };
  const tolerance = ask.toleranceMm ?? CONTACT_TOLERANCE_MM;
  if (typeof tolerance !== "number" || !Number.isFinite(tolerance) || tolerance < MIN_TOLERANCE_MM || tolerance > MAX_TOLERANCE_MM) return { reason: `tolerance is mm, from ${MIN_TOLERANCE_MM} to ${MAX_TOLERANCE_MM}.` };
  if (!assembly.members.some((row) => row.object === ask.object)) return { reason: "This part is not in the assembly." };
  const body = bodyOf(assembly, ask.object);
  if (!body) return { reason: "This part is not in the assembly." };
  if ("reason" in body) return { reason: `${name(ask.object)} turns on a ball joint: only a hinge or a slide can be driven to contact.` };
  if (body.fixed) return { reason: `${name(ask.object)} does not move: it is the fixed root, or seated without a joint on a part that is.` };
  const member = assembly.members.find((row) => row.object === body.body)!;
  const joint = member.joint;
  if (joint?.kind !== "hinge" && joint?.kind !== "slide") return { reason: `${name(ask.object)} has no hinge or slide to drive.` };
  const kind = joint.kind;
  const from = jointAt(joint);
  let max = ask.max;
  if (max === undefined) {
    if (kind === "hinge") max = DEFAULT_MAX_DEG;
    else {
      const limit = ask.dir > 0 ? joint.max : joint.min;
      if (limit === undefined) return { reason: "Give max: this slide has no limit that way, so the search has no end." };
      max = Math.abs(limit - from);
    }
  }
  if (typeof max !== "number" || !Number.isFinite(max) || max < 0 || max > (kind === "hinge" ? MAX_RANGE_DEG : MAX_RANGE_MM)) return { reason: kind === "hinge" ? `max is degrees, from 0 to ${MAX_RANGE_DEG}.` : `max is mm, from 0 to ${MAX_RANGE_MM}.` };

  const at = (value: number): { turned: Turned; poses: Map<string, Affine> } | { reason: string } => {
    const turned = trainTurn(assembly, body.body, value - from);
    if ("reason" in turned) return { reason: turned.reason };
    return { turned, poses: solveAssembly(turned.assembly, poseOf).poses };
  };
  const valueOf = (turned: Turned) => jointAt(turned.assembly.members.find((row) => row.object === body.body)!.joint);
  const ending = at(from + ask.dir * max);
  if ("reason" in ending) return ending;
  const end = valueOf(ending.turned);
  const limit = ending.turned.clamped;
  const start = at(from);
  if ("reason" in start) return start;
  const answer = (value: number, posed: { turned: Turned }, extra: Partial<ContactAnswer>, evaluations: number, ignored: ContactPair[]): ContactAnswer => ({
    body: body.body, kind, from, contact: false, value, searched: { from, to: end, limit }, toleranceMm: tolerance, evaluations, ignored,
    assembly: posed.turned.assembly, angles: posed.turned.angles, ...extra,
  });
  if (Math.abs(end - from) <= 1e-12) return answer(from, start, {}, 0, []);

  // The parts that move: those whose pose changes when the joint turns, as trainTurn makes it.
  const moving = new Set<string>();
  for (const fraction of [0.0123, 0.37, 1]) {
    const there = fraction === 1 ? ending : at(from + (end - from) * fraction);
    if ("reason" in there) return there;
    for (const row of assembly.members) if (!sameAffine(start.poses.get(row.object), there.poses.get(row.object))) moving.add(row.object);
  }
  if (moving.size === 0) return { reason: `Nothing moves when ${name(body.body)}'s joint turns.` };
  const meshOf = new Map(parts.filter((part) => part.positions.length >= 9).map((part) => [part.object, part.positions]));
  const movers = [...moving].filter((id) => meshOf.has(id));
  if (movers.length === 0) return { reason: "The parts this joint moves have no mesh to touch with." };
  let watched: string[];
  if (ask.against === "any") {
    watched = assembly.members.map((row) => row.object).filter((id) => !moving.has(id) && meshOf.has(id));
    if (watched.length === 0) return { reason: "No part of the assembly stays still for the moving parts to touch." };
  } else {
    if (!assembly.members.some((row) => row.object === ask.against)) return { reason: `${name(ask.against)} is not in this assembly.` };
    if (moving.has(ask.against)) return { reason: `${name(ask.against)} moves with ${name(body.body)}'s joint, so the joint cannot bring them together.` };
    if (!meshOf.has(ask.against)) return { reason: `${name(ask.against)} has no mesh to touch.` };
    watched = [ask.against];
  }
  const placed = (id: string, poses: Map<string, Affine>): Placed => ({ positions: meshOf.get(id)!, pose: poses.get(id)! });
  const ignored: ContactPair[] = [];
  const pairs: ContactPair[] = [];
  for (const m of movers) {
    for (const o of watched) {
      if (!start.poses.get(m) || !start.poses.get(o)) continue;
      const result = interference(placed(m, start.poses), placed(o, start.poses));
      if (result.verdict === "crossing" || result.nested) ignored.push({ moving: m, other: o });
      else pairs.push({ moving: m, other: o });
    }
  }
  if (ask.against !== "any" && ignored.length > 0) return { reason: `${name(ignored[0]!.moving)} already crosses ${name(ask.against)} where it stands: start from a clear pose.` };
  if (pairs.length === 0) return { reason: "Every part this joint could touch already crosses a moving part where it stands: start from a clear pose." };

  // Each moving part's box corners bound how far any of its points travels.
  const corners = new Map<string, V[]>();
  for (const m of new Set(pairs.map((pair) => pair.moving))) {
    const box = boundsOf(meshOf.get(m)!);
    corners.set(m, Array.from({ length: 8 }, (_, k) => [box.min[0] + (k & 1 ? box.max[0] - box.min[0] : 0), box.min[1] + (k & 2 ? box.max[1] - box.min[1] : 0), box.min[2] + (k & 4 ? box.max[2] - box.min[2] : 0)] as V));
  }
  const lo = Math.min(from, end), hi = Math.max(from, end);
  const inRange = (value: number) => Math.max(lo, Math.min(hi, value));
  let evaluations = 0;
  type State = { crossing: ContactPair | null; d: number; poses: Map<string, Affine>; posed: { turned: Turned } };
  const evaluate = (value: number): State | { reason: string } => {
    evaluations += 1;
    const posed = at(value);
    if ("reason" in posed) return posed;
    for (const pair of pairs) {
      const result = interference(placed(pair.moving, posed.poses), placed(pair.other, posed.poses));
      if (result.verdict === "crossing" || result.nested) return { crossing: pair, d: 0, poses: posed.poses, posed };
    }
    let d = Infinity;
    for (const pair of pairs) d = Math.min(d, meshDistance(placed(pair.moving, posed.poses), placed(pair.other, posed.poses)));
    return { crossing: null, d, poses: posed.poses, posed };
  };
  /** How far, mm, a point of a watched moving part goes per unit of the joint near `value`, with the margin. */
  const speed = (value: number, poses: Map<string, Affine>): number | { reason: string } => {
    const h = kind === "hinge" ? 1e-3 : 1e-3;
    const step = inRange(value + ask.dir * h) !== value ? value + ask.dir * h : value - ask.dir * h;
    const there = at(step);
    if ("reason" in there) return there;
    let v = 0;
    for (const [m, points] of corners) {
      const p = poses.get(m), q = there.poses.get(m);
      if (!p || !q) continue;
      for (const c of points) {
        const a = applyPose(p, c), b = applyPose(q, c);
        v = Math.max(v, Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]));
      }
    }
    return (v / Math.abs(step - value)) * SPEED_MARGIN;
  };
  const tooLong = { reason: `The search stopped after ${MAX_EVALUATIONS} poses short of contact: give a larger tolerance or a smaller max.` };

  let clear = evaluate(from);
  if ("reason" in clear) return clear;
  if (clear.crossing) return { reason: "The parts cross where the joint stands." };
  let clearAt = from;
  let hit: State | null = null;
  let hitAt = from;
  let v = 0;
  while (clearAt !== end) {
    const measured = speed(clearAt, clear.poses);
    if (typeof measured !== "number") return measured;
    v = measured;
    if (!(v > 1e-12)) return { reason: `The parts ${name(body.body)}'s joint moves do not move: nothing can touch.` };
    const next = inRange(clearAt + (ask.dir * Math.max(clear.d, FLOOR_MM)) / v);
    const state = evaluate(next);
    if ("reason" in state) return state;
    if (state.crossing) { hit = state; hitAt = next; break; }
    clear = state;
    clearAt = next;
    if (evaluations > MAX_EVALUATIONS) return tooLong;
  }
  if (!hit) return answer(end, clear.posed, {}, evaluations, ignored);
  // Bisect the bracket until no point of the moving parts travels more than the tolerance across it.
  while (Math.abs(hitAt - clearAt) * v > tolerance && Math.abs(hitAt - clearAt) > 1e-12 * Math.max(1, Math.abs(clearAt))) {
    const mid = (clearAt + hitAt) / 2;
    const state = evaluate(mid);
    if ("reason" in state) return state;
    if (state.crossing) { hit = state; hitAt = mid; } else { clear = state; clearAt = mid; }
    if (evaluations > MAX_EVALUATIONS) return tooLong;
  }
  const pair = hit.crossing!;
  const clearance = meshDistance(placed(pair.moving, clear.poses), placed(pair.other, clear.poses));
  return answer(clearAt, clear.posed, { contact: true, past: hitAt, pair, clearanceMm: clearance }, evaluations, ignored);
}

/** Two members at the assembly's present pose: whether they cross by the mesh pass, and their least distance. */
export function pairClearance(assembly: Assembly, poseOf: PoseOf, parts: readonly ContactPart[], a: string, b: string): { crossing: boolean; mm: number } | { reason: string } {
  const poses = solveAssembly(assembly, poseOf).poses;
  const meshA = parts.find((part) => part.object === a)?.positions, meshB = parts.find((part) => part.object === b)?.positions;
  const pa = poses.get(a), pb = poses.get(b);
  if (!meshA || meshA.length < 9 || !meshB || meshB.length < 9 || !pa || !pb) return { reason: "Both parts need a mesh and a pose in the assembly." };
  return pairState({ positions: meshA, pose: pa }, { positions: meshB, pose: pb });
}
