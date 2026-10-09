/** Picking tree supports from the skeleton. Pure: no three.js, no DOM. Print space is X right, Y depth, Z up. */
import type { CoverageGap, RegrowEdit, SiteSpec, SupportSkeleton } from "./support-edits.ts";
import { keepsPoint, type SectionSpec, type Vec3 } from "./section-plane.ts";

export type PickScope = "branch" | "tree";

/** Limb lookups built once per skeleton. Indices are column positions, not limb ids. */
export interface LimbIndex {
  skel: SupportSkeleton;
  /** Column index of each limb id. */
  at: Map<number, number>;
  /** Column indices of the limbs that merged into each limb. */
  guests: number[][];
}

export function indexSkeleton(skel: SupportSkeleton): LimbIndex {
  const at = new Map<number, number>();
  skel.id.forEach((id, k) => at.set(id, k));
  const guests: number[][] = skel.id.map(() => []);
  skel.into.forEach((host, k) => {
    const h = at.get(host);
    if (h !== undefined) guests[h].push(k);
  });
  return { skel, at, guests };
}

/** Limb k plus every limb whose `into` chain reaches it, ascending. */
export function branchLimbs(index: LimbIndex, k: number): number[] {
  const out: number[] = [];
  const todo = [k];
  while (todo.length) {
    const j = todo.pop()!;
    out.push(j);
    todo.push(...index.guests[j]);
  }
  return out.sort((a, b) => a - b);
}

/** Every limb with limb k's `tree`, ascending. */
export function treeLimbs(index: LimbIndex, k: number): number[] {
  const tree = index.skel.tree[k];
  const out: number[] = [];
  index.skel.tree.forEach((t, j) => {
    if (t === tree) out.push(j);
  });
  return out;
}

export function selectLimbs(index: LimbIndex, k: number, scope: PickScope): number[] {
  return scope === "tree" ? treeLimbs(index, k) : branchLimbs(index, k);
}

/** Birth sites of the live limbs in `limbs`, exactly as the skeleton reports them. */
export function sitesOf(index: LimbIndex, limbs: readonly number[]): SiteSpec[] {
  const s = index.skel;
  return limbs.filter((k) => s.live[k] === 1).map((k) => ({ xy: [s.siteX[k], s.siteY[k]], z: s.siteZ[k] }));
}

/**
 * What the user can see: the layer slider's z slab and the section cut.
 * On a belt reply (`skeleton.ls`) `zLow` and `zHigh` are the preview layer `z` of the lowest and highest
 * shown layer, and a knot is in the slab by its `ls`, not by its lab height.
 */
export interface Visible {
  zLow: number;
  zHigh: number;
  section: { center: Vec3; spec: SectionSpec } | null;
}

/** Ray in print space (X right, Y depth, Z up). `dir` need not be unit length. */
export interface Ray {
  origin: Vec3;
  dir: Vec3;
}

/** Matches the overlay's clip planes, so what draws is what picks. */
const SLAB_EPS = 1e-3;

/**
 * Nearest limb whose visible part the ray passes within `r + slop` of.
 * Each knot pair is a capsule; clip it to the z slab and to the kept side of the section first,
 * so hidden geometry can never be picked.
 */
export function pickLimb(index: LimbIndex, ray: Ray, visible: Visible, slop: number): { limb: number; distance: number } | null {
  const s = index.skel;
  const [o, d] = unitRay(ray);
  let best: { limb: number; distance: number } | null = null;
  for (let k = 0; k < s.id.length; k++) {
    const first = s.start[k];
    const end = s.start[k + 1];
    if (end <= first) continue;
    const last = Math.max(first, end - 2);
    for (let i = first; i <= last; i++) {
      const j = Math.min(i + 1, end - 1);
      const a: Vec3 = [s.xs[i], s.ys[i], s.zs[i]];
      const b: Vec3 = [s.xs[j], s.ys[j], s.zs[j]];
      const span = visibleSpan(a, b, s.ls ? s.ls[i] : a[2], s.ls ? s.ls[j] : b[2], visible);
      if (!span) continue;
      const hit = closest(o, d, a, b, span[0], span[1]);
      const r = s.rs[i] + (s.rs[j] - s.rs[i]) * hit.s;
      if (hit.gap > r + slop) continue;
      if (!best || hit.t < best.distance) best = { limb: k, distance: hit.t };
    }
  }
  return best;
}

/** Gap whose padded bounds box the ray crosses at the gap's top z (`z[1]`), if that z is visible. */
export function pickGap(gaps: readonly CoverageGap[], ray: Ray, visible: Visible, pad: number): { gap: number; distance: number } | null {
  const [o, d] = unitRay(ray);
  let best: { gap: number; distance: number } | null = null;
  gaps.forEach((gap, i) => {
    const z = gap.z[1];
    if (z < visible.zLow - SLAB_EPS || z > visible.zHigh + SLAB_EPS || Math.abs(d[2]) < 1e-9) return;
    const t = (z - o[2]) / d[2];
    if (t <= 0) return;
    const x = o[0] + d[0] * t;
    const y = o[1] + d[1] * t;
    if (x < gap.min[0] - pad || x > gap.max[0] + pad || y < gap.min[1] - pad || y > gap.max[1] + pad) return;
    if (visible.section && !keepsPoint([x, y, z], visible.section.center, visible.section.spec)) return;
    if (!best || t < best.distance) best = { gap: i, distance: t };
  });
  return best;
}

/** The regrow that targets one gap: its bounds box as one closed loop and its z range. Same as the engine's `over_gaps`. */
export function regrowFor(gap: CoverageGap): RegrowEdit {
  const [x0, y0] = gap.min;
  const [x1, y1] = gap.max;
  return { kind: "regrow", region: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1]]], z: [gap.z[0], gap.z[1]] };
}

/**
 * Capsules of `limbs` for drawing: `[ax, ay, az, ar, bx, by, bz, br]` per knot pair. Single-knot limbs give one zero-length capsule.
 * The overlay clips a cartesian reply to the layer slab itself. A belt reply has no such plane, so `visible` cuts the capsules by `ls` here.
 */
export function capsulesOf(index: LimbIndex, limbs: readonly number[], visible?: Visible): Float32Array {
  const s = index.skel;
  const out: number[] = [];
  const at = (a: number, b: number, t: number) => (t <= 0 ? a : t >= 1 ? b : a + (b - a) * t);
  for (const k of limbs) {
    const first = s.start[k];
    const end = s.start[k + 1];
    if (end <= first) continue;
    for (let i = first; i <= Math.max(first, end - 2); i++) {
      const j = Math.min(i + 1, end - 1);
      let from = 0;
      let to = 1;
      if (s.ls && visible) {
        const span = visibleSpan([s.xs[i], s.ys[i], s.zs[i]], [s.xs[j], s.ys[j], s.zs[j]], s.ls[i], s.ls[j], { ...visible, section: null });
        if (!span) continue;
        [from, to] = span;
      }
      out.push(
        at(s.xs[i], s.xs[j], from), at(s.ys[i], s.ys[j], from), at(s.zs[i], s.zs[j], from), at(s.rs[i], s.rs[j], from),
        at(s.xs[i], s.xs[j], to), at(s.ys[i], s.ys[j], to), at(s.zs[i], s.zs[j], to), at(s.rs[i], s.rs[j], to),
      );
    }
  }
  return Float32Array.from(out);
}

function unitRay(ray: Ray): [Vec3, Vec3] {
  const len = Math.hypot(ray.dir[0], ray.dir[1], ray.dir[2]) || 1;
  return [ray.origin, [ray.dir[0] / len, ray.dir[1] / len, ray.dir[2] / len]];
}

/** The part of segment a→b, as `[s0, s1]` of its length, inside the slab and on the kept side of the section. `ha` and `hb` are the ends' slab heights: lab z, or a belt knot's `ls`. */
function visibleSpan(a: Vec3, b: Vec3, ha: number, hb: number, visible: Visible): [number, number] | null {
  let lo = 0;
  let hi = 1;
  const keep = (fa: number, fb: number) => {
    // Keeps s where fa + (fb - fa) * s >= 0.
    if (fa < 0 && fb < 0) return false;
    if (fa >= 0 && fb >= 0) return true;
    const s = fa / (fa - fb);
    if (fa < 0) lo = Math.max(lo, s);
    else hi = Math.min(hi, s);
    return true;
  };
  if (!keep(ha - visible.zLow + SLAB_EPS, hb - visible.zLow + SLAB_EPS)) return null;
  if (!keep(visible.zHigh + SLAB_EPS - ha, visible.zHigh + SLAB_EPS - hb)) return null;
  if (visible.section) {
    const { center, spec } = visible.section;
    const side = (p: Vec3) => {
      const n = spec.normal;
      return -((p[0] - center[0]) * n[0] + (p[1] - center[1]) * n[1] + (p[2] - center[2]) * n[2] - spec.offset);
    };
    if (!keep(side(a), side(b))) return null;
  }
  return lo <= hi ? [lo, hi] : null;
}

/** Closest approach of the unit ray `o + t d`, t >= 0, to `a + s (b - a)`, s in [s0, s1]. */
function closest(o: Vec3, d: Vec3, a: Vec3, b: Vec3, s0: number, s1: number) {
  const e: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const w: Vec3 = [o[0] - a[0], o[1] - a[1], o[2] - a[2]];
  const de = dot(d, e);
  const ee = dot(e, e);
  const dw = dot(d, w);
  const ew = dot(e, w);
  const clampS = (v: number) => Math.min(s1, Math.max(s0, v));
  const denom = ee - de * de;
  let s = ee < 1e-12 ? s0 : denom > 1e-12 ? clampS((ew - de * dw) / denom) : s0;
  let t = Math.max(0, de * s - dw);
  if (ee >= 1e-12) s = clampS((ew + de * t) / ee);
  t = Math.max(0, de * s - dw);
  const p: Vec3 = [a[0] + e[0] * s, a[1] + e[1] * s, a[2] + e[2] * s];
  const q: Vec3 = [o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t];
  return { s, t, gap: Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) };
}

function dot(a: Vec3, b: Vec3) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
