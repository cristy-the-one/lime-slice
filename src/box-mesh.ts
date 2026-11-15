/** Box meshes for the dynamics tests and sample assemblies. */
/** A box's twelve triangles, outward, about `c`. */
export function box(dx: number, dy: number, dz: number, c: [number, number, number] = [0, 0, 0]): Float32Array {
  const p = (i: number, j: number, k: number) => [c[0] + (i - 0.5) * dx, c[1] + (j - 0.5) * dy, c[2] + (k - 0.5) * dz];
  const quad = (a: number[], b: number[], cc: number[], d: number[]) => [...a, ...b, ...cc, ...a, ...cc, ...d];
  return Float32Array.from([
    ...quad(p(0, 0, 0), p(0, 1, 0), p(1, 1, 0), p(1, 0, 0)), ...quad(p(0, 0, 1), p(1, 0, 1), p(1, 1, 1), p(0, 1, 1)),
    ...quad(p(0, 0, 0), p(1, 0, 0), p(1, 0, 1), p(0, 0, 1)), ...quad(p(0, 1, 0), p(0, 1, 1), p(1, 1, 1), p(1, 1, 0)),
    ...quad(p(0, 0, 0), p(0, 0, 1), p(0, 1, 1), p(0, 1, 0)), ...quad(p(1, 0, 0), p(1, 1, 0), p(1, 1, 1), p(1, 0, 1)),
  ]);
}

