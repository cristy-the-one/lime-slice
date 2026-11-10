/**
 * A box tree over a triangle soup, for rays. A pointer move asks which triangle is under it; testing every triangle
 * of a 216k-triangle part took 7–9 ms a move. The tree names the few triangles whose boxes the ray's line crosses,
 * and the caller tests those exactly as it tested all of them before, so the hits are the same ones.
 *
 * Built once per positions array, on the first ray, and kept with it. A mesh's positions are replaced, never written
 * in place, so the array is the key.
 */

export interface RayTree {
  /** Per node: min x y z, max x y z, grown by `pad` on every side. */
  boxes: Float64Array;
  /** Per node: its two children, or -1 for a leaf; a node's triangles are [start, end) in `order`. */
  left: Int32Array;
  right: Int32Array;
  start: Int32Array;
  end: Int32Array;
  order: Int32Array;
  nodes: number;
  depth: number;
  /** How far each box is grown, so a hit the exact test finds a hair outside its triangle is still a candidate. */
  pad: number;
}

const LEAF = 8;

const trees = new WeakMap<Float32Array, RayTree>();

/** The tree of `positions` (nine numbers a triangle), built on first use. */
export function rayTreeOf(positions: Float32Array): RayTree {
  const known = trees.get(positions);
  if (known) return known;
  const tree = buildRayTree(positions);
  trees.set(positions, tree);
  return tree;
}

export function buildRayTree(positions: Float32Array): RayTree {
  const count = Math.floor(positions.length / 9);
  const order = new Int32Array(count);
  const centre = new Float64Array(count * 3);
  let reach = 0;
  for (let t = 0; t < count; t += 1) {
    order[t] = t;
    const at = t * 9;
    for (let a = 0; a < 3; a += 1) {
      const p = positions[at + a]!, q = positions[at + 3 + a]!, r = positions[at + 6 + a]!;
      centre[t * 3 + a] = (p + q + r) / 3;
      reach = Math.max(reach, Math.abs(p), Math.abs(q), Math.abs(r));
    }
  }
  // Far above the rounding of a ray test in doubles, far below anything a pointer can tell apart.
  const pad = Number.isFinite(reach) ? reach * 1e-6 + 1e-9 : 0;
  const most = Math.max(1, 2 * count);
  const boxes = new Float64Array(most * 6);
  const left = new Int32Array(most).fill(-1);
  const right = new Int32Array(most).fill(-1);
  const start = new Int32Array(most);
  const end = new Int32Array(most);
  let nodes = 0;
  let depth = 0;
  const build = (from: number, to: number, level: number): number => {
    const node = nodes;
    nodes += 1;
    if (level > depth) depth = level;
    start[node] = from;
    end[node] = to;
    const box = node * 6;
    if (to - from <= LEAF) {
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
      boxes[box] = x0 - pad;
      boxes[box + 1] = y0 - pad;
      boxes[box + 2] = z0 - pad;
      boxes[box + 3] = x1 + pad;
      boxes[box + 4] = y1 + pad;
      boxes[box + 5] = z1 + pad;
      return node;
    }
    // Split at the middle of the centres' box along its longest side: no sort, so the build is one pass a level.
    let cx0 = Infinity, cy0 = Infinity, cz0 = Infinity, cx1 = -Infinity, cy1 = -Infinity, cz1 = -Infinity;
    for (let i = from; i < to; i += 1) {
      const c = order[i]! * 3;
      const x = centre[c]!, y = centre[c + 1]!, z = centre[c + 2]!;
      if (x < cx0) cx0 = x;
      if (y < cy0) cy0 = y;
      if (z < cz0) cz0 = z;
      if (x > cx1) cx1 = x;
      if (y > cy1) cy1 = y;
      if (z > cz1) cz1 = z;
    }
    const axis = cx1 - cx0 >= cy1 - cy0 && cx1 - cx0 >= cz1 - cz0 ? 0 : cy1 - cy0 >= cz1 - cz0 ? 1 : 2;
    const middle = axis === 0 ? (cx0 + cx1) / 2 : axis === 1 ? (cy0 + cy1) / 2 : (cz0 + cz1) / 2;
    let i = from;
    let j = to - 1;
    while (i <= j) {
      if (centre[order[i]! * 3 + axis]! < middle) i += 1;
      else {
        const held = order[i]!;
        order[i] = order[j]!;
        order[j] = held;
        j -= 1;
      }
    }
    // Centres all in one spot (or not numbers) part nowhere: halve the run so the tree still ends.
    const cut = i === from || i === to ? (from + to) >> 1 : i;
    const a = build(from, cut, level + 1);
    const b = build(cut, to, level + 1);
    left[node] = a;
    right[node] = b;
    for (let k = 0; k < 3; k += 1) {
      boxes[box + k] = Math.min(boxes[a * 6 + k]!, boxes[b * 6 + k]!);
      boxes[box + 3 + k] = Math.max(boxes[a * 6 + 3 + k]!, boxes[b * 6 + 3 + k]!);
    }
    return node;
  };
  if (count > 0) build(0, count, 1);
  return { boxes, left, right, start, end, order, nodes, depth, pad };
}

let stack = new Int32Array(128);

/**
 * The triangles whose boxes the ray from `o` along `d` crosses, lowest index first, written into `out` (emptied
 * first). Every triangle the ray strikes is among them; most others are not.
 */
export function rayCandidates(tree: RayTree, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, out: number[]): number[] {
  out.length = 0;
  if (tree.nodes === 0) return out;
  if (stack.length < tree.depth + 2) stack = new Int32Array(tree.depth * 2 + 2);
  const { boxes, left, right, start, end, order } = tree;
  const ix = 1 / dx, iy = 1 / dy, iz = 1 / dz;
  let top = 0;
  stack[top++] = 0;
  while (top > 0) {
    const node = stack[--top]!;
    const b = node * 6;
    // The slab test, from the ray's start on. An axis the ray does not move along only asks where it starts.
    let near = 0;
    let far = Infinity;
    if (dx !== 0) {
      const t1 = (boxes[b]! - ox) * ix, t2 = (boxes[b + 3]! - ox) * ix;
      if (t1 < t2) {
        if (t1 > near) near = t1;
        if (t2 < far) far = t2;
      } else {
        if (t2 > near) near = t2;
        if (t1 < far) far = t1;
      }
    } else if (ox < boxes[b]! || ox > boxes[b + 3]!) continue;
    if (dy !== 0) {
      const t1 = (boxes[b + 1]! - oy) * iy, t2 = (boxes[b + 4]! - oy) * iy;
      if (t1 < t2) {
        if (t1 > near) near = t1;
        if (t2 < far) far = t2;
      } else {
        if (t2 > near) near = t2;
        if (t1 < far) far = t1;
      }
    } else if (oy < boxes[b + 1]! || oy > boxes[b + 4]!) continue;
    if (dz !== 0) {
      const t1 = (boxes[b + 2]! - oz) * iz, t2 = (boxes[b + 5]! - oz) * iz;
      if (t1 < t2) {
        if (t1 > near) near = t1;
        if (t2 < far) far = t2;
      } else {
        if (t2 > near) near = t2;
        if (t1 < far) far = t1;
      }
    } else if (oz < boxes[b + 2]! || oz > boxes[b + 5]!) continue;
    // A box of numbers that are not numbers fails every comparison above and is walked: wrong only by being slow.
    if (near > far) continue;
    const a = left[node]!;
    if (a >= 0) {
      stack[top++] = a;
      stack[top++] = right[node]!;
      continue;
    }
    for (let i = start[node]!; i < end[node]!; i += 1) out.push(order[i]!);
  }
  return out.sort((p, q) => p - q);
}
