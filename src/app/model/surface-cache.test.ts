/**
 * Organic fix round S3: a root edit rebuilds nodes under the same ids, so the surface-inspect replies of that tree are
 * dropped with its solids; another tree's stay.
 */
import { register } from "node:module";

register(new URL("../../model-view/resolve-ts.mjs", import.meta.url).href, import.meta.url);
const { cachedSurface, forgetSurfaces, keepSurface, surfaceKey } = await import("./surface-cache.ts");

let failed = 0;
const check = (name: string, ok: boolean) => {
  if (ok) console.log(name);
  else {
    failed += 1;
    console.error(`FAIL ${name}`);
  }
};
const old = { isoPoints: new Float32Array([0, 0, 0, 1, 1, 1]) } as never;
keepSurface(surfaceKey("a#1", 2, 0.05), old);
keepSurface(surfaceKey("a#10", 2, 0.05), old);
keepSurface(surfaceKey("b#1", 2, 0.05), old);
forgetSurfaces("a#1");
check("a root edit of tree a#1 drops its node 2 isoparm lines", cachedSurface(surfaceKey("a#1", 2, 0.05)) === undefined);
check("tree a#10 (same prefix) and tree b#1 keep theirs", cachedSurface(surfaceKey("a#10", 2, 0.05)) === old && cachedSurface(surfaceKey("b#1", 2, 0.05)) === old);
for (let i = 0; i < 40; i += 1) keepSurface(surfaceKey("c#1", i, 0.05), old);
check("the cache stays bounded", cachedSurface(surfaceKey("c#1", 0, 0.05)) === undefined && cachedSurface(surfaceKey("c#1", 39, 0.05)) === old);
if (failed) process.exit(1);
console.log("surface cache: ok");
