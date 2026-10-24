/**
 * The part's own triangles, split finely enough to carry a stress gradient.
 * A box face is two triangles; painted at its corners alone, a cantilever's
 * root-to-tip ramp would be one blend across the whole face. Each triangle is
 * halved across its longest edge until no edge is longer than `edgeMm`, so a
 * long thin face splits along its length only. New corners lie on the old
 * edges, so the surface keeps its shape and no gap opens.
 */

/** Corners the bridge is asked to paint, at most. A finer split stops here. */
export const PAINT_CORNER_BUDGET = 600_000;

type P = [number, number, number];

function dist(a: P, b: P): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function mid(a: P, b: P): P {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
}

/** Calls `emit` with each piece of the triangle, halved at its longest edge until every edge is under `edgeMm`. */
function halve(a: P, b: P, c: P, edgeMm: number, emit: (a: P, b: P, c: P) => void) {
  const ab = dist(a, b);
  const bc = dist(b, c);
  const ca = dist(c, a);
  const longest = Math.max(ab, bc, ca);
  if (longest <= edgeMm) {
    emit(a, b, c);
    return;
  }
  // Cut the longest edge at its midpoint, towards the opposite corner. Winding is kept.
  if (longest === ab) {
    const m = mid(a, b);
    halve(a, m, c, edgeMm, emit);
    halve(m, b, c, edgeMm, emit);
  } else if (longest === bc) halve(b, c, a, edgeMm, emit);
  else halve(c, a, b, edgeMm, emit);
}

function corner(positions: ArrayLike<number>, at: number): P {
  return [positions[at]!, positions[at + 1]!, positions[at + 2]!];
}

/**
 * Triangle corners (x y z per corner, three corners a triangle), split so no
 * edge is longer than `edgeMm`, unless that would pass `budget` corners; then
 * the target edge grows until it fits.
 */
export function paintCorners(positions: Float32Array, edgeMm: number, budget = PAINT_CORNER_BUDGET): Float32Array {
  const count = Math.floor(positions.length / 9);
  if (count === 0 || !(edgeMm > 0)) return positions.slice(0, count * 9);
  let target = edgeMm;
  for (;;) {
    let corners = 0;
    for (let tri = 0; tri < count && corners <= budget; tri += 1) {
      halve(corner(positions, tri * 9), corner(positions, tri * 9 + 3), corner(positions, tri * 9 + 6), target, () => {
        corners += 3;
      });
    }
    if (corners <= budget) break;
    target *= 1.5;
  }
  const out: number[] = [];
  for (let tri = 0; tri < count; tri += 1) {
    halve(corner(positions, tri * 9), corner(positions, tri * 9 + 3), corner(positions, tri * 9 + 6), target, (a, b, c) => {
      out.push(...a, ...b, ...c);
    });
  }
  return Float32Array.from(out);
}
