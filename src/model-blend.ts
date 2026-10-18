/** Which edges a fillet or chamfer applies, and which way a hole drills. Pure, so the gestures can be tested without the kernel. */

import type { ModelPickRef } from "./model-select.ts";

export type Vec3 = [number, number, number];

/** Straight down. An unpicked hole, and a zero direction, both use this. */
export const HOLE_DOWN: Vec3 = [0, 0, -1];

/** Every selected edge, once, in the order it was picked. */
export function selectedEdges(picks: readonly ModelPickRef[]): number[] {
  const edges: number[] = [];
  for (const pick of picks) {
    if (pick.kind === "edge" && !edges.includes(pick.index)) edges.push(pick.index);
  }
  return edges;
}

/** Every selected face, once, in the order it was picked. A shell opens these. */
export function selectedFaces(picks: readonly ModelPickRef[]): number[] {
  const faces: number[] = [];
  for (const pick of picks) {
    if (pick.kind === "face" && !faces.includes(pick.index)) faces.push(pick.index);
  }
  return faces;
}

/** The first selected face. A shell's thickness knob sits on this one; Apply still uses every face. */
export function firstFace(picks: readonly ModelPickRef[]): number | null {
  for (const pick of picks) {
    if (pick.kind === "face") return pick.index;
  }
  return null;
}

/** The last selected face, when the drill should follow that face. */
export function lastFace(picks: readonly ModelPickRef[]): number | null {
  for (let i = picks.length - 1; i >= 0; i -= 1) {
    const pick = picks[i];
    if (pick?.kind === "face") return pick.index;
  }
  return null;
}

/**
 * Unit direction into the material. `outward` is the face normal; the drill is its opposite.
 * A missing or zero normal stays straight down.
 */
export function holeAxis(outward: readonly number[] | null | undefined): Vec3 {
  if (!outward || outward.length < 3) return HOLE_DOWN;
  const inward: Vec3 = [-(outward[0] ?? 0), -(outward[1] ?? 0), -(outward[2] ?? 0)];
  const length = Math.hypot(inward[0], inward[1], inward[2]);
  if (!(length > 1e-9)) return HOLE_DOWN;
  return [inward[0] / length, inward[1] / length, inward[2] / length];
}

/**
 * Outward normal of one tessellated face. Triangles are stored in order, and `triangles[i]` is the face of triangle `i`.
 * The kernel already winds each triangle so this points out of the solid.
 */
export function outwardFromMesh(
  positions: ArrayLike<number>,
  triangles: ArrayLike<number>,
  face: number,
): Vec3 | null {
  let x = 0;
  let y = 0;
  let z = 0;
  for (let tri = 0; tri < triangles.length; tri += 1) {
    if (triangles[tri] !== face) continue;
    const base = tri * 9;
    const ax = positions[base] ?? 0;
    const ay = positions[base + 1] ?? 0;
    const az = positions[base + 2] ?? 0;
    const bx = positions[base + 3] ?? 0;
    const by = positions[base + 4] ?? 0;
    const bz = positions[base + 5] ?? 0;
    const cx = positions[base + 6] ?? 0;
    const cy = positions[base + 7] ?? 0;
    const cz = positions[base + 8] ?? 0;
    const ux = bx - ax;
    const uy = by - ay;
    const uz = bz - az;
    const vx = cx - ax;
    const vy = cy - ay;
    const vz = cz - az;
    x += uy * vz - uz * vy;
    y += uz * vx - ux * vz;
    z += ux * vy - uy * vx;
  }
  const length = Math.hypot(x, y, z);
  if (!(length > 1e-9)) return null;
  return [x / length, y / length, z / length];
}
