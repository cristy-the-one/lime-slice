/**
 * Organic fix round, item 10: with curvature shading on, a hover repaints the face the pointer left and the one it
 * reached from the kept heatmap, as the face colours do, instead of recolouring and uploading every vertex. The
 * buffer after each hover equals a full repaint.
 */
import { register } from "node:module";

import type { ViewCtx } from "./ctx.ts";
import type { ModelSolid } from "./types.ts";

register(new URL("./resolve-ts.mjs", import.meta.url).href, import.meta.url);

const THREE = await import("three");
const { installMesh } = await import("./mesh.ts");

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(name);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}

// A strip of 3 faces x 400 triangles each.
const FACES = 3;
const PER = 400;
const triCount = FACES * PER;
const positions = new Float32Array(triCount * 9);
for (let t = 0; t < triCount; t += 1) {
  const x = t * 0.1;
  positions.set([x, 0, 0, x + 0.1, 0, 0, x, 1, 0], t * 9);
}
const triangles = new Uint32Array(triCount);
for (let t = 0; t < triCount; t += 1) triangles[t] = Math.floor(t / PER);
const solid: ModelSolid = { id: 1, volumeMm3: 1, positions, triangles, edges: [] };
// Minimum radius per vertex: a ramp, so every face has varied heatmap colours.
const minRadiusMm = new Float32Array(triCount * 3);
for (let i = 0; i < minRadiusMm.length; i += 1) minRadiusMm[i] = 0.5 + (i % 97) * 0.3;

function makeCtx(): ViewCtx {
  const canvas = { dataset: {} as DOMStringMap } as HTMLCanvasElement;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array(positions.length), 3));
  const ctx = {
    canvas,
    body: new THREE.Group(),
    datumLines: [],
    fatLines: [],
    ghosts: [],
    marks: [],
    renderer: null,
    snapLineMat: null,
    mesh: new THREE.Mesh(geometry),
    solid,
    preview: null,
    picks: [],
    hover: null,
    mode: "face",
    look: { shading: "curvature", curvatureMode: "minRadius", curvatureWarnMm: 2, colourByStep: false },
    surfaceInspect: { minRadiusMm },
    stressLoad: new Set(),
    stressHold: new Set(),
    colors: { paintEnforce: "#3366ff", danger: "#ff0000", teal: "#00ffff", amber: "#ffaa00" },
    accent: 0x22aa55,
    highlightStep: null,
    removedFaces: false,
    datumPick: false,
  } as unknown as ViewCtx;
  installMesh(ctx);
  return ctx;
}

const live = makeCtx();
const attribute = live.mesh!.geometry.getAttribute("color") as InstanceType<typeof THREE.BufferAttribute>;
live.paintFaces();
// The renderer says when the buffer is on the card; until then a repaint uploads the whole buffer.
(attribute as unknown as { onUploadCallback: () => void }).onUploadCallback();
const v0 = attribute.version;

let worst = 0;
let partial = true;
for (const face of [0, 2, 1, null, 2]) {
  (live as { hover: unknown }).hover = face == null ? null : { kind: "face", index: face };
  attribute.clearUpdateRanges();
  live.paintFaces();
  // The partial upload names only the two faces' triangles (2 x 400 x 9 floats at most), not the whole buffer.
  const ranged = attribute.updateRanges.reduce((sum, range) => sum + range.count, 0);
  if (!(ranged > 0 && ranged <= 2 * PER * 9)) partial = false;
  // A fresh view painting the same hover from scratch: the buffers must match exactly.
  const fresh = makeCtx();
  (fresh as { hover: unknown }).hover = live.hover;
  fresh.paintFaces();
  const want = (fresh.mesh!.geometry.getAttribute("color").array as Float32Array);
  const got = attribute.array as Float32Array;
  for (let i = 0; i < got.length; i += 1) worst = Math.max(worst, Math.abs(got[i]! - want[i]!));
}
console.log(`curvature hover: version ${v0} -> ${attribute.version}, worst difference from a full repaint ${worst}`);
check("each hover with curvature shading uploads only the two faces it changed", partial);
check("the buffer after each hover equals a full repaint", worst === 0, `worst=${worst}`);

if (failed) {
  console.error(`${failed} checks failed`);
  process.exit(1);
}
console.log("curvature hover repaint: ok");
