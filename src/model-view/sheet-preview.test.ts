/**
 * Organic fix round, item 14: a patch or blend preview is a sheet and gets the sheet's back-face mesh (the solid
 * material is front-only while a sheet is shown), and it goes with the preview.
 */
import { register } from "node:module";

import type { ViewCtx } from "./ctx.ts";
import type { ModelSolid } from "./types.ts";

register(new URL("./resolve-ts.mjs", import.meta.url).href, import.meta.url);

const THREE = await import("three");
const { installMesh } = await import("./mesh.ts");

let failed = 0;
function check(name: string, ok: boolean) {
  if (ok) {
    console.log(name);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name}`);
}

const ctx = {
  canvas: { dataset: {} as DOMStringMap } as HTMLCanvasElement,
  body: new THREE.Group(),
  datumLines: [],
  fatLines: [],
  ghosts: [],
  marks: [],
  renderer: null,
  snapLineMat: null,
  mesh: null,
  solid: null,
  preview: null,
  picks: [],
  hover: null,
  mode: "face",
  look: { shading: "normal", colourByStep: false },
  surfaceInspect: null,
  stressLoad: new Set(),
  stressHold: new Set(),
  colors: { paintEnforce: "#3366ff", danger: "#ff0000", teal: "#00ffff", amber: "#ffaa00" },
  accent: 0x22aa55,
  highlightStep: null,
  rebuildCap: () => undefined,
} as unknown as ViewCtx;
installMesh(ctx);

const quad = (naked: number[]): ModelSolid => ({
  id: 1,
  volumeMm3: 0,
  positions: new Float32Array([0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 0, 0, 10, 10, 0, 0, 10, 0]),
  triangles: new Uint32Array([0, 0]),
  edges: [{ id: 0, lengthMm: 10, points: new Float32Array([0, 0, 0, 10, 0, 0]) }],
  nakedEdges: naked,
});

ctx.showPreview(quad([0]));
const back = ctx.preview?.back ?? null;
check("a sheet preview has a back-face mesh in the sheet's back tint", !!back && back.material === ctx.sheetBackMaterial && ctx.body.children.includes(back));
ctx.clearPreview();
check("the back-face mesh goes with the preview", !!back && !ctx.body.children.includes(back));
ctx.showPreview(quad([]));
check("a closed preview has none", !ctx.preview?.back);
ctx.clearPreview();

if (failed) {
  console.error(`${failed} checks failed`);
  process.exit(1);
}
console.log("sheet preview: ok");
