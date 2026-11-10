/**
 * The solid's edges as segments on the screen, kept while the view stands still. An idle pointer move asked which
 * edge is under it by projecting every point of every edge, each one twice: 3.9 ms for 3,000 edges of 12 points and
 * 13.8 ms for 8,000 of 16. The projection only changes with the camera, the pose, the canvas and the section, so it
 * is done once for those and a move is left with the distance test alone.
 */

export interface EdgeRow {
  id: number;
  points: ArrayLike<number>;
}

export interface ScreenEdges {
  /** Segments held. */
  count: number;
  /** Per segment: ax, ay, bx, by, in the pixels the pointer is given in. */
  xy: Float64Array;
  /** Per segment: the edge it is part of. */
  edge: Int32Array;
}

export function segmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const abx = bx - ax;
  const aby = by - ay;
  const length2 = abx * abx + aby * aby;
  const t = length2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * abx + (py - ay) * aby) / length2));
  return Math.hypot(px - (ax + abx * t), py - (ay + aby * t));
}

/**
 * Every segment a pointer could pick, in the order the edges list them. `project` writes a point's screen x, y and
 * depth; a segment with an end outside the depth range -1..1 is left out, and so is one whose two ends `hidden`
 * both names (the section hides it whole), and every segment of a seam. `into` is written over when it is given.
 */
export function projectEdges(
  edges: readonly EdgeRow[],
  seams: ReadonlySet<number> | null,
  project: (points: ArrayLike<number>, at: number, out: Float64Array) => void,
  hidden: ((points: ArrayLike<number>, at: number) => boolean) | null,
  into?: ScreenEdges,
): ScreenEdges {
  let most = 0;
  for (const edge of edges) most += Math.max(0, Math.floor(edge.points.length / 3) - 1);
  const held = into && into.edge.length >= most ? into : { count: 0, xy: new Float64Array(most * 4), edge: new Int32Array(most) };
  const { xy, edge: owner } = held;
  const a = new Float64Array(3);
  const b = new Float64Array(3);
  let count = 0;
  for (const edge of edges) {
    if (seams?.has(edge.id)) continue;
    const points = edge.points;
    if (points.length < 6) continue;
    project(points, 0, a);
    let aHidden = hidden ? hidden(points, 0) : false;
    for (let i = 0; i + 5 < points.length; i += 3) {
      // Each point is the end of one segment and the start of the next: projected once, used twice.
      project(points, i + 3, b);
      const bHidden = hidden ? hidden(points, i + 3) : false;
      if (!(aHidden && bHidden) && !(a[2]! < -1 || a[2]! > 1 || b[2]! < -1 || b[2]! > 1)) {
        const at = count * 4;
        xy[at] = a[0]!;
        xy[at + 1] = a[1]!;
        xy[at + 2] = b[0]!;
        xy[at + 3] = b[1]!;
        owner[count] = edge.id;
        count += 1;
      }
      a[0] = b[0]!;
      a[1] = b[1]!;
      a[2] = b[2]!;
      aHidden = bHidden;
    }
  }
  held.count = count;
  return held;
}

/** The edge of the segment nearest the pointer within `reach` pixels, the first listed of equals; null when none is. */
export function nearestEdge(held: ScreenEdges, px: number, py: number, reach: number): number | null {
  const { xy, edge, count } = held;
  // A segment whose box is over a pixel further than `reach` cannot be within it: most are, and skip the distance.
  const far = reach + 1;
  let best = -1;
  let bestDistance = Infinity;
  for (let s = 0; s < count; s += 1) {
    const at = s * 4;
    const ax = xy[at]!, ay = xy[at + 1]!, bx = xy[at + 2]!, by = xy[at + 3]!;
    if (ax < bx ? px < ax - far || px > bx + far : px < bx - far || px > ax + far) continue;
    if (ay < by ? py < ay - far || py > by + far : py < by - far || py > ay + far) continue;
    const distance = segmentDistance(px, py, ax, ay, bx, by);
    if (distance <= reach && distance < bestDistance) {
      best = s;
      bestDistance = distance;
    }
  }
  return best < 0 ? null : edge[best]!;
}
