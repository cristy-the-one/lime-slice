/**
 * Face frames for composite edits. The MCP session and the app's feature tools both build an ExpandContext from this,
 * so a pocket typed in the panel expands into the same pieces as the same pocket typed over MCP.
 * Nothing here imports the session, the DOM, or Node.
 */
import { orientEuler } from "../mesh-place.ts";
import { facePlane } from "../model-plane.ts";
import { CURVED_FACE, localPoint, workplaneOnFace, type Workplane } from "../workplane.ts";
import { readVec3, type ExpandContext, type FaceExtent, type StandRegion } from "./compose.ts";

/** A flat face the way the session stores one: array index is the face index. */
export interface FrameFace {
  index: number;
  areaMm2: number;
  normal?: readonly number[];
  centre: readonly number[];
}

/** The open solid's mesh, in the frame the composite is expanded in. */
export interface FramedSolid {
  positions: ArrayLike<number>;
  triangles: ArrayLike<number>;
  faces: readonly FrameFace[];
}

/**
 * What only the caller knows: which faces a selector names, and where a raised piece can stand.
 * Injected so this module stays free of the MCP session.
 */
export interface ExpandDeps {
  matchFaces(
    faces: readonly FrameFace[],
    input: Record<string, unknown>,
  ): readonly { index: number; areaMm2: number }[] | { reason: string };
  stand(positions: ArrayLike<number>, frame: Workplane, depth: number, overlap: number): StandRegion | null;
  closeCracks(positions: ArrayLike<number>): ArrayLike<number>;
}

/**
 * A face's frame for composite ops: V runs up the face and U is level, on a wall as on a roof slope, so texture rows
 * and pocket sizes follow the slope. A face that looks straight up or down keeps the workplane's own axes.
 */
export function levelFrame(plane: { point: [number, number, number]; normal: [number, number, number] }): Workplane {
  const w = plane.normal;
  if (Math.abs(w[2]) > 0.999) return workplaneOnFace(plane);
  const up: [number, number, number] = [-w[2] * w[0], -w[2] * w[1], 1 - w[2] * w[2]];
  const len = Math.hypot(up[0], up[1], up[2]);
  const v: [number, number, number] = [up[0] / len, up[1] / len, up[2] / len];
  const u: [number, number, number] = [v[1] * w[2] - v[2] * w[1], v[2] * w[0] - v[0] * w[2], v[0] * w[1] - v[1] * w[0]];
  const turn = orientEuler([u[0], v[0], w[0], u[1], v[1], w[1], u[2], v[2], w[2]]);
  return { source: "face", origin: [...plane.point], turn: [turn.rx, turn.ry, turn.rz] };
}

/** The distance from `p` to the triangle a, b, c: to its closest point, inside or on an edge or a corner. */
export function pointTriangleDistance(p: readonly number[], a: readonly number[], b: readonly number[], c: readonly number[]): number {
  const sub = (x: readonly number[], y: readonly number[]) => [x[0]! - y[0]!, x[1]! - y[1]!, x[2]! - y[2]!];
  const dot = (x: readonly number[], y: readonly number[]) => x[0]! * y[0]! + x[1]! * y[1]! + x[2]! * y[2]!;
  const ab = sub(b, a);
  const ac = sub(c, a);
  const ap = sub(p, a);
  const d1 = dot(ab, ap);
  const d2 = dot(ac, ap);
  let q: number[];
  if (d1 <= 0 && d2 <= 0) q = [...a];
  else {
    const bp = sub(p, b);
    const d3 = dot(ab, bp);
    const d4 = dot(ac, bp);
    const cp = sub(p, c);
    const d5 = dot(ab, cp);
    const d6 = dot(ac, cp);
    const vc = d1 * d4 - d3 * d2;
    const vb = d5 * d2 - d1 * d6;
    const va = d3 * d6 - d5 * d4;
    if (d3 >= 0 && d4 <= d3) q = [...b];
    else if (d6 >= 0 && d5 <= d6) q = [...c];
    else if (vc <= 0 && d1 >= 0 && d3 <= 0) { const t = d1 / (d1 - d3); q = [a[0]! + t * ab[0]!, a[1]! + t * ab[1]!, a[2]! + t * ab[2]!]; }
    else if (vb <= 0 && d2 >= 0 && d6 <= 0) { const t = d2 / (d2 - d6); q = [a[0]! + t * ac[0]!, a[1]! + t * ac[1]!, a[2]! + t * ac[2]!]; }
    else if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { const t = (d4 - d3) / (d4 - d3 + (d5 - d6)); q = [b[0]! + t * (c[0]! - b[0]!), b[1]! + t * (c[1]! - b[1]!), b[2]! + t * (c[2]! - b[2]!)]; }
    else { const den = 1 / (va + vb + vc); const v = vb * den; const w = vc * den; q = [a[0]! + ab[0]! * v + ac[0]! * w, a[1]! + ab[1]! * v + ac[1]! * w, a[2]! + ab[2]! * v + ac[2]! * w]; }
  }
  return Math.hypot(p[0]! - q[0]!, p[1]! - q[1]!, p[2]! - q[2]!);
}

/**
 * The ExpandContext a solid's reply gives composite ops. `plane` is the workplane an op with no face is typed in.
 * With no solid, a face cannot be read. This is the session's context, moved here so the app builds the same one.
 */
export function expandContextFromSolid(solid: FramedSolid | null, plane: Workplane, deps: ExpandDeps): ExpandContext {
  if (!solid) {
    return {
      plane,
      face: () => ({ reason: "That face is not on this solid." }),
      faceBy: () => ({ reason: "This solid could not be read." }),
    };
  }
  return {
    plane,
    face: (index: number, coplanar = false) => {
      const face = solid.faces[index];
      if (!face) return { reason: "That face is not on this solid." };
      if (!face.normal) return { reason: CURVED_FACE };
      const normal = [face.normal[0]!, face.normal[1]!, face.normal[2]!] as [number, number, number];
      const flat = facePlane(solid.positions, solid.triangles, index, normal);
      if (!flat) return { reason: CURVED_FACE };
      const frame = levelFrame(flat);
      // With coplanar, every flat face in the same plane joins: a floor that earlier ribs split into strips is one floor.
      const members = new Set([index]);
      if (coplanar) {
        solid.faces.forEach((other, i) => {
          if (i === index || !other.normal) return;
          const n = other.normal;
          const len = Math.hypot(n[0]!, n[1]!, n[2]!) || 1;
          const same = (n[0]! * flat.normal[0] + n[1]! * flat.normal[1] + n[2]! * flat.normal[2]) / len > 0.9999;
          const offset = (other.centre[0]! - flat.point[0]) * flat.normal[0] + (other.centre[1]! - flat.point[1]) * flat.normal[1] + (other.centre[2]! - flat.point[2]) * flat.normal[2];
          if (same && Math.abs(offset) < 0.01) members.add(i);
        });
      }
      const outline: number[] = [];
      const extent: FaceExtent = {
        u: [Infinity, -Infinity],
        v: [Infinity, -Infinity],
        outline,
        // Read from the mesh with its cracks closed, so a line meets each wall once.
        ...(coplanar ? { stand: (depth: number, overlap: number) => deps.stand(deps.closeCracks(solid.positions), frame, depth, overlap) } : {}),
      };
      const { positions, triangles } = solid;
      for (let tri = 0; tri < triangles.length; tri += 1) {
        if (!members.has(triangles[tri]!)) continue;
        for (let corner = 0; corner < 3; corner += 1) {
          const at = tri * 9 + corner * 3;
          const [u, v] = localPoint(frame, [positions[at]!, positions[at + 1]!, positions[at + 2]!]);
          outline.push(u, v);
          extent.u = [Math.min(extent.u[0], u), Math.max(extent.u[1], u)];
          extent.v = [Math.min(extent.v[0], v), Math.max(extent.v[1], v)];
        }
      }
      return { plane: frame, extent };
    },
    faceBy: (selector: Record<string, unknown>) => {
      const unknown = Object.keys(selector).find((key) => key !== "normal" && key !== "withinDeg" && key !== "nearPoint");
      if (unknown) return { reason: `face.${unknown} is not a selector field. Use normal, withinDeg, and nearPoint.` };
      const matched = deps.matchFaces(solid.faces, { kind: "plane", ...(selector.normal !== undefined ? { normal: selector.normal } : {}), ...(selector.withinDeg !== undefined ? { withinDeg: selector.withinDeg } : {}) });
      if ("reason" in matched) return matched;
      if (matched.length === 0) return { reason: "No flat face matches that selector." };
      const near = readVec3(selector.nearPoint, [NaN, NaN, NaN]);
      if (Number.isNaN(near[0])) return [...matched].sort((x, y) => y.areaMm2 - x.areaMm2)[0]!.index;
      // Nearest by the face itself, not its centre: a long thin rib top's centre can sit nearer than the floor beside it.
      const { positions, triangles } = solid;
      const gap = new Map<number, number>();
      for (let tri = 0; tri < triangles.length; tri += 1) {
        const index = triangles[tri]!;
        if (!matched.some((row) => row.index === index)) continue;
        const at = tri * 9;
        const d = pointTriangleDistance(near, [positions[at]!, positions[at + 1]!, positions[at + 2]!], [positions[at + 3]!, positions[at + 4]!, positions[at + 5]!], [positions[at + 6]!, positions[at + 7]!, positions[at + 8]!]);
        gap.set(index, Math.min(gap.get(index) ?? Infinity, d));
      }
      return [...matched].sort((x, y) => (gap.get(x.index) ?? Infinity) - (gap.get(y.index) ?? Infinity) || y.areaMm2 - x.areaMm2)[0]!.index;
    },
  };
}
