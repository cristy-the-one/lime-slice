/**
 * The colour buffer of a solid, a face at a time. A hover changes two faces' colours (the one it left and the one it
 * reached); repainting every triangle of a 216k-triangle part for that, and uploading the whole 7.8 MB buffer again,
 * ran each time the pointer crossed a face's border. These write one face's triangles and say which runs of the
 * buffer they were, so only those are uploaded.
 */

/** One colour for all three corners of each of `tris`, nine numbers a triangle in `into`. */
export function fillFace(into: Float32Array, tris: ArrayLike<number>, hex: number): void {
  const r = ((hex >> 16) & 255) / 255;
  const g = ((hex >> 8) & 255) / 255;
  const b = (hex & 255) / 255;
  for (let i = 0; i < tris.length; i += 1) {
    const at = tris[i]! * 9;
    for (let v = 0; v < 9; v += 3) {
      into[at + v] = r;
      into[at + v + 1] = g;
      into[at + v + 2] = b;
    }
  }
}

/** Every triangle's colour from its face's. `hexOf` is asked once a triangle, so it keeps its own answers. */
export function fillFaces(into: Float32Array, triangles: ArrayLike<number>, hexOf: (face: number) => number): void {
  for (let triangle = 0; triangle < triangles.length; triangle += 1) {
    const hex = hexOf(triangles[triangle]!);
    const r = ((hex >> 16) & 255) / 255;
    const g = ((hex >> 8) & 255) / 255;
    const b = (hex & 255) / 255;
    const at = triangle * 9;
    for (let v = 0; v < 9; v += 3) {
      into[at + v] = r;
      into[at + v + 1] = g;
      into[at + v + 2] = b;
    }
  }
}

/** The runs of the colour array that hold `tris` (lowest first), as `start, count` pairs counted in array elements. */
export function colourRuns(tris: ArrayLike<number>): number[] {
  const runs: number[] = [];
  let from = -1;
  let last = -2;
  for (let i = 0; i < tris.length; i += 1) {
    const t = tris[i]!;
    if (t === last + 1) {
      last = t;
      continue;
    }
    if (from >= 0) runs.push(from * 9, (last - from + 1) * 9);
    from = t;
    last = t;
  }
  if (from >= 0) runs.push(from * 9, (last - from + 1) * 9);
  return runs;
}
