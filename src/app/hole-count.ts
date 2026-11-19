/** How many open edges a plate mesh has, for the object panel's "Close holes" row. Counted once per mesh, off the draw. */

const counts = new WeakMap<Float32Array, number>();
/** Past this many triangles the count is not worked out for the panel: it would hold the window up. */
const LIMIT = 300_000 * 9;

/**
 * The edges of this mesh that only one triangle uses: 0 until it has been counted. The count runs after the panel is
 * drawn, and `counted` is called when it finds any, to draw the panel again.
 */
export function openEdgesOf(sourcePos: Float32Array, counted: () => void): number {
  const known = counts.get(sourcePos);
  if (known !== undefined) return known;
  counts.set(sourcePos, 0);
  if (sourcePos.length <= LIMIT) {
    // The counting code is loaded here, not with the window's first script.
    setTimeout(() => {
      void import("../mesh-check.ts").then(({ edgeReport }) => {
        const open = edgeReport(sourcePos, 0).open;
        counts.set(sourcePos, open);
        if (open > 0) counted();
      });
    }, 0);
  }
  return 0;
}
