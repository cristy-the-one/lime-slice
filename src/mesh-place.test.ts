import { fnv1aHex } from "./slice-action.ts";
import { boundsOf, encodeStl, layFlatMatrix, matMul, placeMesh, poseAffine, settle, rotX, rotY, rotZ, scaledCanonical, transformPositions, type Mat3, type MeshShift } from "./mesh-place.ts";

let failed = 0;

function eq<T>(name: string, actual: T, expected: T): void {
  if (JSON.stringify(actual) === JSON.stringify(expected)) return;
  failed += 1;
  console.error(`FAIL ${name}: got ${JSON.stringify(actual)}`);
}

const hash = (bytes: ArrayBuffer | Float32Array | Uint8Array) =>
  fnv1aHex(bytes instanceof Uint8Array ? bytes : bytes instanceof Float32Array ? new Uint8Array(bytes.buffer) : new Uint8Array(bytes));

/** A closed, lumpy, off-center blob: no symmetry for a pose bug to hide behind. */
function lumpyMesh(rings = 18, segments = 28): Float32Array {
  const at = (i: number, j: number): [number, number, number] => {
    const theta = (Math.PI * i) / rings;
    const phi = (2 * Math.PI * j) / segments;
    const r = 12 + 3 * Math.sin(3 * theta) * Math.cos(2 * phi) + 1.5 * Math.cos(5 * phi + theta);
    return [7 + 1.4 * r * Math.sin(theta) * Math.cos(phi), -4 + r * Math.sin(theta) * Math.sin(phi), 3 + 0.8 * r * Math.cos(theta)];
  };
  const out: number[] = [];
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < segments; j++) {
      const a = at(i, j), b = at(i + 1, j), c = at(i + 1, j + 1), d = at(i, j + 1);
      out.push(...a, ...b, ...c, ...a, ...c, ...d);
    }
  }
  return settle(new Float32Array(out));
}

const source = lumpyMesh();

interface Case {
  name: string;
  orient: Mat3;
  scale: number;
  centered: boolean;
  shift?: MeshShift;
}

const cases: Case[] = [
  { name: "rotated, centered", orient: matMul(rotZ(37), rotX(90)), scale: 1.5, centered: true },
  { name: "gizmo turn, moved off center", orient: matMul(rotY(-23.5), rotX(12.25)), scale: 2.5, centered: false, shift: { x: 41.5, y: 97, z: 3 } },
  { name: "gizmo turn, moved again", orient: matMul(rotY(-23.5), rotX(12.25)), scale: 2.5, centered: false, shift: { x: -7.25, y: 13, z: 0 } },
  { name: "lay flat, centered", orient: layFlatMatrix(source), scale: 1, centered: true },
  { name: "rotated, centered again", orient: matMul(rotZ(37), rotX(90)), scale: 1.5, centered: true },
];

// Captured from the request path before the Prepare view moved placement onto the GPU.
// The slice request carries the scaled mesh bytes and the pose; neither may change.
const expected: Record<string, { mesh: string; pose: string; placed: string }> = {
  "rotated, centered": { mesh: "62ebef914590fe3b", pose: "ef86f79e06d5f8d8", placed: "178177dec39e25f5" },
  "gizmo turn, moved off center": { mesh: "eae01a4b3b0946bf", pose: "6a94caccd6ab8dff", placed: "59973c107fb18b8b" },
  "gizmo turn, moved again": { mesh: "eae01a4b3b0946bf", pose: "fb5716d0ac81ae45", placed: "c57e76606f34bb9d" },
  "lay flat, centered": { mesh: "c976d71f284991b4", pose: "2e595b43c2400aaf", placed: "ebcce71d0bdfbc2b" },
  "rotated, centered again": { mesh: "62ebef914590fe3b", pose: "ef86f79e06d5f8d8", placed: "178177dec39e25f5" },
};

for (const c of cases) {
  const mesh = hash(encodeStl(scaledCanonical(source, c.scale), "blob.stl"));
  const placement = placeMesh(source, c.orient, c.scale, 220, 200, c.centered, c.shift);
  eq(`${c.name}: request mesh bytes`, mesh, expected[c.name].mesh);
  eq(`${c.name}: request pose`, hash(new TextEncoder().encode(JSON.stringify(placement.pose))), expected[c.name].pose);
  eq(`${c.name}: placed vertices`, hash(placement.positions), expected[c.name].placed);
  eq(`${c.name}: placed bounds`, placement.bounds, boundsOf(transformPositions(source, c.orient, c.scale, 220, 200, c.centered, c.shift)));

  const a = poseAffine(placement.pose);
  const canonical = scaledCanonical(source, c.scale);
  let worst = 0;
  for (let i = 0; i < canonical.length; i += 3) {
    const [x, y, z] = [canonical[i], canonical[i + 1], canonical[i + 2]];
    for (let row = 0; row < 3; row++) {
      const drawn = a[row * 4] * x + a[row * 4 + 1] * y + a[row * 4 + 2] * z + a[row * 4 + 3];
      worst = Math.max(worst, Math.abs(drawn - placement.positions[i + row]));
    }
  }
  eq(`${c.name}: the Prepare view's pose matrix draws the placed mesh within 1 µm`, worst < 1e-3, true);
}

if (failed) throw new Error(`${failed} mesh-place check(s) failed`);
console.log("mesh-place: ok");
