/**
 * --- Organic surfaces S1: kernel surface-inspect replies (curvature buffers, isoparm lines) by `<key>#<node>@<chord>`.
 * A root edit rebuilds nodes under the same ids, so `forgetSurfaces(key)` drops a tree's entries whenever its built
 * solids are forgotten: the cache never answers for a shape that is gone.
 */
import type { DecodedSurfaceInspect } from "../../model-reply";

const MAX = 24;
const cache = new Map<string, DecodedSurfaceInspect>();

export function surfaceKey(key: string, node: number, chord: number): string {
  return `${key}#${node}@${chord}`;
}

export function cachedSurface(name: string): DecodedSurfaceInspect | undefined {
  return cache.get(name);
}

export function keepSurface(name: string, data: DecodedSurfaceInspect) {
  cache.delete(name);
  if (cache.size >= MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(name, data);
}

/** Drop every reply of tree `key`. */
export function forgetSurfaces(key: string) {
  for (const name of [...cache.keys()]) if (name.startsWith(`${key}#`)) cache.delete(name);
}
