/**
 * Interference between two parts at their assembled poses, the cheap pass (docs/plan-assemblies.md, section 6).
 *
 * Boxes first: two parts whose posed boxes do not meet are `clear`. Then triangles: a tree of boxes over each part's
 * own triangles is built once per mesh and reused for every pose. One part's triangles are taken into the other's
 * frame by the relative pose and tested against the triangles of the tree they overlap. A pair crosses only when each
 * triangle straddles the other's plane by more than a tolerance, and the two cut lines overlap by more than it too: a
 * face resting on a face, or an edge resting on one, is a `touch`, which is what a hook sitting on a rim does.
 *
 * With no crossing triangle, one part may still sit wholly inside the other; a ray from one of its corners says so,
 * and the answer is a `touch` with `nested`. The exact pass (a common volume through Open CASCADE) settles both.
 */
import { applyPose, inversePose, posedBounds, thenPose, type Affine } from "./model-space.ts";

export type Verdict = "clear" | "touch" | "crossing";

export interface PairResult {
  verdict: Verdict;
  /** One part lies wholly inside the other: they share volume, though no triangles cross. */
  nested?: boolean;
  /** A point on the first crossing found, in model space. */
  at?: [number, number, number];
}

/** Distances under this, in mm, count as contact, not as crossing: kernel meshes put coincident faces this close. */
export const CONTACT_MM = 1e-3;

/**
 * D11. A common volume under 0.01 mm³, or under a millionth of the smaller part's volume, is a touch: the kernel can
 * report a sliver where two faces coincide.
 */
export const SLIVER_MM3 = 0.01;
export const SLIVER_SHARE = 1e-6;

/** The volume a closed triangle soup encloses, mm³, by the divergence theorem. */
export function meshVolume(positions: ArrayLike<number>): number {
  let sum = 0;
  for (let i = 0; i + 8 < positions.length; i += 9) {
    const ax = positions[i]!, ay = positions[i + 1]!, az = positions[i + 2]!;
    const bx = positions[i + 3]!, by = positions[i + 4]!, bz = positions[i + 5]!;
    const cx = positions[i + 6]!, cy = positions[i + 7]!, cz = positions[i + 8]!;
    sum += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  return Math.abs(sum) / 6;
}

/** The exact pass's answer for a common volume between parts of `volumes`. */
export function exactVerdict(commonMm3: number, volumes: [number, number]): "touch" | "crossing" {
  const smaller = Math.min(Math.abs(volumes[0]), Math.abs(volumes[1]));
  return commonMm3 < SLIVER_MM3 || commonMm3 < SLIVER_SHARE * smaller ? "touch" : "crossing";
}

interface Tree {
  positions: Float32Array;
  /** Per node: min x y z, max x y z. */
  boxes: Float64Array;
  /** Per node: its two children, or -1 for a leaf; a node's triangles are [start, end) in `order`. */
  left: Int32Array;
  right: Int32Array;
  start: Int32Array;
  end: Int32Array;
  order: Int32Array;
  nodes: number;
}

const LEAF = 4;
const trees = new WeakMap<Float32Array, Tree>();

/** The box tree over a triangle soup's own triangles, built once per array. */
export function treeOf(positions: Float32Array): Tree {
  const known = trees.get(positions);
  if (known) return known;
  const count = Math.floor(positions.length / 9);
  const order = new Int32Array(count);
  const centre = new Float64Array(count * 3);
  for (let t = 0; t < count; t += 1) {
    order[t] = t;
    for (let a = 0; a < 3; a += 1) centre[t * 3 + a] = (positions[t * 9 + a]! + positions[t * 9 + 3 + a]! + positions[t * 9 + 6 + a]!) / 3;
  }
  const most = Math.max(1, 2 * count);
  const boxes = new Float64Array(most * 6);
  const left = new Int32Array(most).fill(-1);
  const right = new Int32Array(most).fill(-1);
  const start = new Int32Array(most);
  const end = new Int32Array(most);
  let nodes = 0;
  const build = (from: number, to: number): number => {
    const node = nodes;
    nodes += 1;
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let i = from; i < to; i += 1) {
      const t = order[i]! * 9;
      for (let v = 0; v < 9; v += 3) {
        const x = positions[t + v]!, y = positions[t + v + 1]!, z = positions[t + v + 2]!;
        if (x < x0) x0 = x;
        if (y < y0) y0 = y;
        if (z < z0) z0 = z;
        if (x > x1) x1 = x;
        if (y > y1) y1 = y;
        if (z > z1) z1 = z;
      }
    }
    boxes.set([x0, y0, z0, x1, y1, z1], node * 6);
    start[node] = from;
    end[node] = to;
    if (to - from <= LEAF) return node;
    const axis = x1 - x0 >= y1 - y0 && x1 - x0 >= z1 - z0 ? 0 : y1 - y0 >= z1 - z0 ? 1 : 2;
    const slice = Array.from(order.subarray(from, to)).sort((a, b) => centre[a * 3 + axis]! - centre[b * 3 + axis]!);
    order.set(slice, from);
    const mid = (from + to) >> 1;
    left[node] = build(from, mid);
    right[node] = build(mid, to);
    return node;
  };
  if (count > 0) build(0, count);
  const tree = { positions, boxes, left, right, start, end, order, nodes };
  trees.set(positions, tree);
  return tree;
}

type V = [number, number, number];

const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** Signed distances of `p`, `q`, `r` to the plane of `a`, `b`, `c`. Null for a degenerate triangle. */
function distances(a: V, b: V, c: V, p: V, q: V, r: V): [number, number, number] | null {
  const n = cross(sub(b, a), sub(c, a));
  const length = Math.hypot(n[0], n[1], n[2]);
  if (length < 1e-12) return null;
  const k = dot(n, a);
  return [(dot(n, p) - k) / length, (dot(n, q) - k) / length, (dot(n, r) - k) / length];
}

const straddles = (d: [number, number, number]) => Math.min(d[0], d[1], d[2]) < -CONTACT_MM && Math.max(d[0], d[1], d[2]) > CONTACT_MM;

/** Where triangle `t`, with distances `d` to the other plane, crosses that plane, as an interval along `dir`. */
function span(t: [V, V, V], d: [number, number, number], dir: V): [number, number] {
  const values: number[] = [];
  for (let i = 0; i < 3; i += 1) {
    const j = (i + 1) % 3;
    const di = d[i]!, dj = d[j]!;
    if ((di < 0 && dj > 0) || (di > 0 && dj < 0)) {
      const s = di / (di - dj);
      const p: V = [t[i]![0] + (t[j]![0] - t[i]![0]) * s, t[i]![1] + (t[j]![1] - t[i]![1]) * s, t[i]![2] + (t[j]![2] - t[i]![2]) * s];
      values.push(dot(p, dir));
    } else if (di === 0) values.push(dot(t[i]!, dir));
  }
  return [Math.min(...values), Math.max(...values)];
}

/** Whether two triangles cross each other properly: each straddles the other's plane and the cut lines overlap. */
export function trianglesCross(t: [V, V, V], u: [V, V, V]): V | null {
  const du = distances(u[0], u[1], u[2], t[0], t[1], t[2]);
  if (!du || !straddles(du)) return null;
  const dt = distances(t[0], t[1], t[2], u[0], u[1], u[2]);
  if (!dt || !straddles(dt)) return null;
  const dir = cross(cross(sub(t[1], t[0]), sub(t[2], t[0])), cross(sub(u[1], u[0]), sub(u[2], u[0])));
  const length = Math.hypot(dir[0], dir[1], dir[2]);
  if (length < 1e-12) return null;
  const unit: V = [dir[0] / length, dir[1] / length, dir[2] / length];
  const a = span(t, du, unit);
  const b = span(u, dt, unit);
  const lo = Math.max(a[0], b[0]);
  const hi = Math.min(a[1], b[1]);
  if (hi - lo <= CONTACT_MM) return null;
  const mid = (lo + hi) / 2;
  // A point on the cut line, near the middle of the overlap: the first triangle's crossing, slid along the line.
  const base = t[0]!;
  return [base[0] + unit[0] * (mid - dot(base, unit)), base[1] + unit[1] * (mid - dot(base, unit)), base[2] + unit[2] * (mid - dot(base, unit))];
}

function triangle(positions: Float32Array, t: number, pose?: Affine): [V, V, V] {
  const o = t * 9;
  const v = (k: number): V => {
    const p: V = [positions[o + k]!, positions[o + k + 1]!, positions[o + k + 2]!];
    return pose ? applyPose(pose, p) : p;
  };
  return [v(0), v(3), v(6)];
}

const boxesMeet = (b: Float64Array, n: number, lo: V, hi: V) =>
  b[n * 6]! <= hi[0] + CONTACT_MM && b[n * 6 + 3]! >= lo[0] - CONTACT_MM && b[n * 6 + 1]! <= hi[1] + CONTACT_MM && b[n * 6 + 4]! >= lo[1] - CONTACT_MM && b[n * 6 + 2]! <= hi[2] + CONTACT_MM && b[n * 6 + 5]! >= lo[2] - CONTACT_MM;

/** Whether `point` (in the tree's frame) is inside the closed mesh, by the parity of a ray's hits. */
function inside(tree: Tree, point: V): boolean {
  // A slanted ray, so it does not run along the edges and faces of a part drawn on the axes.
  const dir: V = [0.5773, 0.5774, 0.5775];
  let hits = 0;
  const visit = (n: number) => {
    const b = tree.boxes;
    // Slab test of the ray against the node's box.
    let t0 = 0, t1 = Infinity;
    for (let a = 0; a < 3; a += 1) {
      const inv = 1 / dir[a]!;
      let near = (b[n * 6 + a]! - point[a]!) * inv;
      let far = (b[n * 6 + 3 + a]! - point[a]!) * inv;
      if (near > far) [near, far] = [far, near];
      t0 = Math.max(t0, near);
      t1 = Math.min(t1, far);
      if (t0 > t1) return;
    }
    if (tree.left[n]! >= 0) {
      visit(tree.left[n]!);
      visit(tree.right[n]!);
      return;
    }
    for (let i = tree.start[n]!; i < tree.end[n]!; i += 1) {
      const [p, q, r] = triangle(tree.positions, tree.order[i]!);
      const e1 = sub(q, p);
      const e2 = sub(r, p);
      const h = cross(dir, e2);
      const det = dot(e1, h);
      if (Math.abs(det) < 1e-12) continue;
      const s = sub(point, p);
      const u = dot(s, h) / det;
      if (u < 0 || u > 1) continue;
      const qv = cross(s, e1);
      const v = dot(dir, qv) / det;
      if (v < 0 || u + v > 1) continue;
      if (dot(e2, qv) / det > 1e-9) hits += 1;
    }
  };
  if (tree.nodes > 0) visit(0);
  return hits % 2 === 1;
}

/** How far inside its own face a sample point sits, in mm: past contact, short of any wall a print could hold. */
const SAMPLE_DEPTH_MM = 0.01;
const SAMPLES = 96;

/**
 * Up to 96 points of `part`, each just inside one of its faces, and how many of them lie inside `host`, with the first
 * such point in model space. A face whose two sides both test outside its own part (an open mesh) gives no point.
 */
function sharedPoints(part: { positions: Float32Array; pose: Affine }, host: { positions: Float32Array; pose: Affine }): { tested: number; hits: number; at?: V } {
  const own = treeOf(part.positions);
  const other = treeOf(host.positions);
  const toHost = thenPose(part.pose, inversePose(host.pose));
  const triangles = Math.floor(part.positions.length / 9);
  const step = Math.max(1, Math.floor(triangles / SAMPLES));
  let tested = 0;
  let hits = 0;
  let at: V | undefined;
  for (let t = 0; t < triangles; t += step) {
    const [p, q, r] = triangle(part.positions, t);
    const n = cross(sub(q, p), sub(r, p));
    const length = Math.hypot(n[0], n[1], n[2]);
    if (length < 1e-12) continue;
    const c: V = [(p[0] + q[0] + r[0]) / 3, (p[1] + q[1] + r[1]) / 3, (p[2] + q[2] + r[2]) / 3];
    const k = SAMPLE_DEPTH_MM / length;
    const back: V = [c[0] - n[0] * k, c[1] - n[1] * k, c[2] - n[2] * k];
    const front: V = [c[0] + n[0] * k, c[1] + n[1] * k, c[2] + n[2] * k];
    const within = inside(own, back) ? back : inside(own, front) ? front : null;
    if (!within) continue;
    tested += 1;
    const there = applyPose(toHost, within);
    if (!inside(other, there)) continue;
    hits += 1;
    at ??= applyPose(host.pose, there);
  }
  return { tested, hits, ...(at ? { at } : {}) };
}

/**
 * Two parts, each a triangle soup in its own frame and a pose into model space. Clear, touch (nested or not), or
 * crossing, with a point on the first crossing.
 */
export function interference(a: { positions: Float32Array; pose: Affine }, b: { positions: Float32Array; pose: Affine }): PairResult {
  const boxA = posedBounds(a.positions, a.pose);
  const boxB = posedBounds(b.positions, b.pose);
  if (!boxA || !boxB) return { verdict: "clear" };
  for (let k = 0; k < 3; k += 1) {
    if (boxA.min[k]! > boxB.max[k]! + CONTACT_MM || boxB.min[k]! > boxA.max[k]! + CONTACT_MM) return { verdict: "clear" };
  }
  // The tree is over the part with more triangles; the other's triangles come into its frame.
  const [small, large] = a.positions.length <= b.positions.length ? [a, b] : [b, a];
  const tree = treeOf(large.positions);
  const into = thenPose(small.pose, inversePose(large.pose));
  const meet: { lo: V; hi: V } = {
    lo: [Math.max(boxA.min[0]!, boxB.min[0]!), Math.max(boxA.min[1]!, boxB.min[1]!), Math.max(boxA.min[2]!, boxB.min[2]!)],
    hi: [Math.min(boxA.max[0]!, boxB.max[0]!), Math.min(boxA.max[1]!, boxB.max[1]!), Math.min(boxA.max[2]!, boxB.max[2]!)],
  };
  const count = Math.floor(small.positions.length / 9);
  for (let s = 0; s < count; s += 1) {
    const world = triangle(small.positions, s, small.pose);
    // Only the triangles inside the boxes' common part can cross.
    if (world.every((p) => p[0] < meet.lo[0] - CONTACT_MM) || world.every((p) => p[0] > meet.hi[0] + CONTACT_MM)) continue;
    if (world.every((p) => p[1] < meet.lo[1] - CONTACT_MM) || world.every((p) => p[1] > meet.hi[1] + CONTACT_MM)) continue;
    if (world.every((p) => p[2] < meet.lo[2] - CONTACT_MM) || world.every((p) => p[2] > meet.hi[2] + CONTACT_MM)) continue;
    const t = triangle(small.positions, s, into);
    const lo: V = [Math.min(t[0][0], t[1][0], t[2][0]), Math.min(t[0][1], t[1][1], t[2][1]), Math.min(t[0][2], t[1][2], t[2][2])];
    const hi: V = [Math.max(t[0][0], t[1][0], t[2][0]), Math.max(t[0][1], t[1][1], t[2][1]), Math.max(t[0][2], t[1][2], t[2][2])];
    const stack = [0];
    while (stack.length > 0) {
      const n = stack.pop()!;
      if (!boxesMeet(tree.boxes, n, lo, hi)) continue;
      if (tree.left[n]! >= 0) {
        stack.push(tree.left[n]!, tree.right[n]!);
        continue;
      }
      for (let i = tree.start[n]!; i < tree.end[n]!; i += 1) {
        const hit = trianglesCross(t, triangle(tree.positions, tree.order[i]!));
        if (hit) return { verdict: "crossing", at: applyPose(large.pose, hit) };
      }
    }
  }
  // No surface crosses another, yet the parts may still share volume: one wholly inside the other, or a pin wider than
  // its hole whose ends sit flush with the faces around it. Points just inside each part, beside its own faces, say so.
  const smallIn = sharedPoints(small, large);
  if (smallIn.tested > 0 && smallIn.hits === smallIn.tested) return { verdict: "touch", nested: true };
  const largeIn = sharedPoints(large, small);
  if (largeIn.tested > 0 && largeIn.hits === largeIn.tested) return { verdict: "touch", nested: true };
  const at = smallIn.at ?? largeIn.at;
  return at ? { verdict: "crossing", at } : { verdict: "touch" };
}
