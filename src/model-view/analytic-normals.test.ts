/**
 * Organic surfaces S1: an OCCT mesh reaches the view with its own normals.
 * `smoothNormals` is counted. Zero calls means the JS normal weld did not run (0 ms).
 */
import { register } from "node:module";

import type { ViewCtx } from "./ctx.ts";
import type { ModelSolid } from "./types.ts";

register(new URL("./resolve-ts.mjs", import.meta.url).href, import.meta.url);

const THREE = await import("three");
const { buildApi } = await import("./api.ts");
const { resetSmoothNormalsCalls, smoothNormalsCallCount } = await import("./smooth.ts");

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) return;
  failed += 1;
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}

function view(): { api: ReturnType<typeof buildApi>; canvas: HTMLCanvasElement; ctx: ViewCtx } {
  const canvas = { dataset: {} as DOMStringMap } as HTMLCanvasElement;
  const ctx = {
    canvas,
    body: new THREE.Group(),
    center: new THREE.Vector3(),
    extent: 1,
    solidMaterial: new THREE.MeshStandardMaterial(),
    sheetBackMaterial: new THREE.MeshStandardMaterial(),
    edgeMaterial: new THREE.LineBasicMaterial(),
    nakedEdgeMaterial: new THREE.LineBasicMaterial(),
    zebraMaterial: new THREE.MeshStandardMaterial(),
    look: { shading: "normal" },
    clearBody: () => undefined,
    clearEdgeKnob: () => undefined,
    setPosedMatrix: () => undefined,
    clearGhosts: () => undefined,
    applyScale: () => undefined,
    paintFit: () => undefined,
    rebuildCap: () => undefined,
    kick: () => undefined,
    paintFaces: () => undefined,
    syncSurfaceLook: () => undefined,
    measureSolid: () => undefined,
    drawDatum: () => undefined,
    rebuildGhost: () => undefined,
    resize: () => undefined,
    seatHit: null,
    picks: [],
    hover: null,
    edgeLit: null,
    boundaries: new Map(),
    ownBox: null,
    ghost: null,
    mesh: null,
    sheetBackMesh: null,
    edgeLines: null,
    nakedEdgeLines: null,
  } as unknown as ViewCtx;
  return { api: buildApi(ctx), canvas, ctx };
}

/** One triangle. The analytic normals are not the flat weld (the third corner leans). */
function solid(withNormals: boolean): ModelSolid {
  const positions = new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 0]);
  const normals = new Float32Array([0, 0, 1, 0, 0, 1, 0.2, 0, 0.9797958971132712]);
  return {
    id: 1,
    volumeMm3: 1,
    positions,
    ...(withNormals ? { normals } : {}),
    triangles: new Uint32Array([0]),
    edges: [],
  };
}

const shown = view();
resetSmoothNormalsCalls();
const analytic = solid(true);
shown.api.setSolid(analytic, { m: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] });
const callsAfterAnalytic = smoothNormalsCallCount();
const attr = shown.ctx.mesh?.geometry.getAttribute("normal");
let copied = !!attr && !!analytic.normals && attr.count * 3 === analytic.normals.length;
if (copied && attr && analytic.normals) {
  for (let v = 0; v < attr.count; v += 1) {
    if (attr.getX(v) !== analytic.normals[v * 3] || attr.getY(v) !== analytic.normals[v * 3 + 1] || attr.getZ(v) !== analytic.normals[v * 3 + 2]) copied = false;
  }
}
check(
  "an OCCT mesh is shown with its own normals and smoothNormals is not called",
  callsAfterAnalytic === 0 && shown.canvas.dataset.normalsSource === "analytic" && copied,
  `calls=${callsAfterAnalytic} source=${shown.canvas.dataset.normalsSource} copied=${copied}`,
);
console.log(`normal-weld: OCCT mesh analytic smoothNormalsCalls=${callsAfterAnalytic} source=${shown.canvas.dataset.normalsSource}`);

resetSmoothNormalsCalls();
const plain = view();
plain.api.setSolid(solid(false), { m: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] });
const callsAfterWeld = smoothNormalsCallCount();
check(
  "a mesh without normals still goes through the weld",
  callsAfterWeld === 1 && plain.canvas.dataset.normalsSource === "smooth",
  `calls=${callsAfterWeld} source=${plain.canvas.dataset.normalsSource}`,
);
console.log(`normal-weld: mesh without normals smoothNormalsCalls=${callsAfterWeld} source=${plain.canvas.dataset.normalsSource}`);

if (failed) {
  console.error(`${failed} analytic-normal checks failed`);
  process.exit(1);
}
console.log("analytic-normals: ok");
