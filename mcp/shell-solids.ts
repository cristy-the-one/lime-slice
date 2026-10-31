/**
 * Which solid of a committed shape a split shell is.
 * The plate mesh is the whole shape, lowered onto the bed by `seatMm`. Each shell's box, lifted back by that seat,
 * is the solid's own box when the shell is that solid. Two solids that sit in the same box are told apart by volume.
 */
import { boundsOf } from "../src/mesh-place.ts";

export interface SolidBounds {
  volumeMm3: number;
  bounds: { min: readonly number[]; max: readonly number[] };
}

/** A shell mesh matches a solid when every side of the two boxes agrees within this many millimetres. */
const BOX_TOLERANCE_MM = 0.75;

function liftedBox(shell: Float32Array, seatMm: number): { min: number[]; max: number[] } {
  const box = boundsOf(shell);
  return {
    min: [box.min[0], box.min[1], box.min[2] + seatMm],
    max: [box.max[0], box.max[1], box.max[2] + seatMm],
  };
}

/** The closed volume of a triangle soup, translation invariant, so a settled shell has the solid's volume. */
function meshVolume(pos: Float32Array): number {
  let sum = 0;
  for (let i = 0; i + 8 < pos.length; i += 9) {
    const ax = pos[i] ?? 0;
    const ay = pos[i + 1] ?? 0;
    const az = pos[i + 2] ?? 0;
    const bx = pos[i + 3] ?? 0;
    const by = pos[i + 4] ?? 0;
    const bz = pos[i + 5] ?? 0;
    const cx = pos[i + 6] ?? 0;
    const cy = pos[i + 7] ?? 0;
    const cz = pos[i + 8] ?? 0;
    sum += ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx);
  }
  return Math.abs(sum) / 6;
}

function boxGap(shell: { min: readonly number[]; max: readonly number[] }, solid: { min: readonly number[]; max: readonly number[] }): number {
  let gap = 0;
  for (let axis = 0; axis < 3; axis += 1) {
    gap = Math.max(gap, Math.abs((shell.min[axis] ?? 0) - (solid.min[axis] ?? 0)), Math.abs((shell.max[axis] ?? 0) - (solid.max[axis] ?? 0)));
  }
  return gap;
}

/**
 * One solid per shell, or null when no solid's box is that shell.
 * `shells` are in the plate mesh's frame. `solids` are in the shape's own frame.
 */
export function matchShellSolids<T extends SolidBounds>(shells: readonly Float32Array[], seatMm: number, solids: readonly T[], toleranceMm = BOX_TOLERANCE_MM): (T | null)[] {
  const boxes = shells.map((shell) => liftedBox(shell, seatMm));
  const volumes = shells.map((shell) => meshVolume(shell));
  const pairs: { shell: number; solid: number; gap: number; volume: number }[] = [];
  for (let shell = 0; shell < boxes.length; shell += 1) {
    const box = boxes[shell]!;
    const volume = volumes[shell] ?? 0;
    for (let solid = 0; solid < solids.length; solid += 1) {
      const shape = solids[solid]!;
      const gap = boxGap(box, shape.bounds);
      if (gap > toleranceMm) continue;
      pairs.push({ shell, solid, gap, volume: Math.abs(volume - shape.volumeMm3) / Math.max(Math.abs(shape.volumeMm3), 1) });
    }
  }
  pairs.sort((a, b) => a.gap - b.gap || a.volume - b.volume || a.solid - b.solid);
  const taken = new Set<number>();
  const out: (T | null)[] = shells.map(() => null);
  for (const pair of pairs) {
    if (out[pair.shell] !== null || taken.has(pair.solid)) continue;
    out[pair.shell] = solids[pair.solid]!;
    taken.add(pair.solid);
  }
  return out;
}
