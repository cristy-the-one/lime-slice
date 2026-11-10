/**
 * `closeCracks` of a solid's mesh, worked out ahead of the moment the plate takes it. Leaving Model closed the cracks
 * of the open solid on the tab switch: 145 ms for 108k triangles, 352 ms for 216k. A worker now does it once the
 * solid is on screen and leaves the result here, under the positions array it was worked out from (a solid's
 * positions are replaced, never written in place). The commit takes that result when it is there and works it out
 * itself when it is not, so what the plate gets, and when, is as before.
 */
import { closeCracks } from "./mesh-check.ts";

const ready = new WeakMap<Float32Array, Float32Array>();

/** `closed` is `closeCracks(positions)`, worked out elsewhere. */
export function keepClosed(positions: Float32Array, closed: Float32Array): void {
  ready.set(positions, closed);
}

export function closedReady(positions: Float32Array): boolean {
  return ready.has(positions);
}

/**
 * `closeCracks(positions)`: the result kept ahead, handed over once (each caller owns the array it gets, as it did
 * when each call made a new one), or worked out now.
 */
export function takeClosed(positions: Float32Array): Float32Array {
  const held = ready.get(positions);
  if (!held) return closeCracks(positions);
  ready.delete(positions);
  return held;
}
