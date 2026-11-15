/**
 * Meshes of a Graham escapement made from horology's outlines (src/graham.ts), for tests and sample projects of the
 * hinge dynamics: an outline extruded into a closed prism, and a small pendulum clock laid out in the model's XZ plane
 * (hinges along +Y, the anchor's pivot above the wheel), with every part's triangles in model space.
 */
import { anchorOutline, outlinePoints, pivotDistance, wheelOutline, type Graham, type P2 } from "./graham.ts";

/** Ear clipping of a simple polygon: index triples, counter-clockwise. */
function triangulate(points: readonly P2[]): [number, number, number][] {
  let area = 0;
  for (let i = 0; i < points.length; i += 1) { const a = points[i]!, b = points[(i + 1) % points.length]!; area += a[0] * b[1] - b[0] * a[1]; }
  const idx = points.map((_, i) => i);
  if (area < 0) idx.reverse();
  const out: [number, number, number][] = [];
  const cross = (o: P2, a: P2, b: P2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const inside = (p: P2, a: P2, b: P2, c: P2) => cross(a, b, p) >= 0 && cross(b, c, p) >= 0 && cross(c, a, p) >= 0;
  let guard = 0;
  while (idx.length > 3 && guard < 100000) {
    guard += 1;
    let clipped = false;
    for (let i = 0; i < idx.length; i += 1) {
      const ia = idx[(i + idx.length - 1) % idx.length]!, ib = idx[i]!, ic = idx[(i + 1) % idx.length]!;
      const a = points[ia]!, b = points[ib]!, c = points[ic]!;
      if (cross(a, b, c) <= 1e-12) continue;
      let blocked = false;
      for (const j of idx) {
        if (j === ia || j === ib || j === ic) continue;
        const p = points[j]!;
        if ((p[0] === a[0] && p[1] === a[1]) || (p[0] === b[0] && p[1] === b[1]) || (p[0] === c[0] && p[1] === c[1])) continue;
        if (inside(p, a, b, c)) { blocked = true; break; }
      }
      if (blocked) continue;
      out.push([ia, ib, ic]);
      idx.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) break;
  }
  if (idx.length === 3) out.push([idx[0]!, idx[1]!, idx[2]!]);
  return out;
}

/**
 * A closed prism: the outline (plane x, y) placed by `to` (a plane point and a height to model space), from `h0` to
 * `h1`. Outward triangles.
 */
export function extrude(points: readonly P2[], h0: number, h1: number, to: (p: P2, h: number) => [number, number, number]): Float32Array {
  const tris = triangulate(points);
  const out: number[] = [];
  const put = (p: P2, h: number) => out.push(...to(p, h));
  for (const [a, b, c] of tris) {
    put(points[a]!, h1); put(points[b]!, h1); put(points[c]!, h1);
    put(points[a]!, h0); put(points[c]!, h0); put(points[b]!, h0);
  }
  // The sides, in the outline's turning sense: flipped together with the caps when it runs clockwise.
  let area = 0;
  for (let i = 0; i < points.length; i += 1) { const a = points[i]!, b = points[(i + 1) % points.length]!; area += a[0] * b[1] - b[0] * a[1]; }
  for (let i = 0; i < points.length; i += 1) {
    let p = points[i]!, q = points[(i + 1) % points.length]!;
    if (area < 0) [p, q] = [q, p];
    put(p, h0); put(q, h0); put(q, h1);
    put(p, h0); put(q, h1); put(p, h1);
  }
  // Each side's orientation follows the cap's: one sign for the whole mesh, which `mass.ts` reads either way.
  return Float32Array.from(out);
}

export interface ClockMeshes {
  /** Model space: the wheel's centre at the origin, the anchor's pivot at (0, 0, d); parts from y 0 to 4. */
  wheel: Float32Array;
  anchor: Float32Array;
  pivotDistance: number;
}

/** The wheel at `phaseDeg` (tooth 0's tip from +X in its plane) and the anchor in its middle position, in the XZ plane. */
export function clockMeshes(g: Graham, phaseDeg: number): ClockMeshes | { reason: string } {
  const d = pivotDistance(g);
  const wheel = wheelOutline(g.wheel, phaseDeg);
  if ("reason" in wheel) return wheel;
  const anchor = anchorOutline(g);
  if ("reason" in anchor) return anchor;
  return {
    wheel: extrude(outlinePoints(wheel, 2.9), 0, 4, (p, h) => [p[0], h, p[1]]),
    anchor: extrude(outlinePoints(anchor, 1), 0, 4, (p, h) => [p[0], h, p[1] + d]),
    pivotDistance: d,
  };
}
