/**
 * The open solid's ray test names the same hits three.js's own does: same triangles, same order, same numbers.
 */
import * as THREE from "three";
import { buildRayTree, rayCandidates } from "./ray-tree.ts";
import { treeRaycast } from "./solid-ray.ts";

let failed = 0;
function check(name: string, ok: boolean) {
  if (ok) return;
  failed += 1;
  console.error(`FAIL ${name}`);
}

let seed = 4242;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

/** A wavy slab: a top of `n` × `n` quads over a flat bottom and four sides, so a ray through it strikes twice or more. */
function slab(n: number): Float32Array {
  const out: number[] = [];
  const top = (x: number, y: number) => 5 + 2 * Math.sin(x / 3) * Math.cos(y / 4);
  const quad = (a: number[], b: number[], c: number[], d: number[]) => out.push(...a, ...b, ...c, ...a, ...c, ...d);
  for (let j = 0; j < n; j += 1) {
    for (let i = 0; i < n; i += 1) quad([i, j, top(i, j)], [i + 1, j, top(i + 1, j)], [i + 1, j + 1, top(i + 1, j + 1)], [i, j + 1, top(i, j + 1)]);
  }
  quad([0, 0, 0], [0, n, 0], [n, n, 0], [n, 0, 0]);
  quad([0, 0, 0], [n, 0, 0], [n, 0, 5], [0, 0, 5]);
  quad([0, n, 0], [0, n, 5], [n, n, 5], [n, n, 0]);
  quad([0, 0, 0], [0, 0, 5], [0, n, 5], [0, n, 0]);
  quad([n, 0, 0], [n, n, 0], [n, n, 5], [n, 0, 5]);
  return new Float32Array(out);
}

/** Triangles thrown about at random, some of no area, some sharing a corner. */
function scatter(count: number): Float32Array {
  const out = new Float32Array(count * 9);
  for (let t = 0; t < count; t += 1) {
    const at = [rnd() * 40 - 20, rnd() * 40 - 20, rnd() * 40 - 20];
    for (let v = 0; v < 3; v += 1) {
      for (let a = 0; a < 3; a += 1) out[t * 9 + v * 3 + a] = t % 17 === 0 && v === 2 ? out[t * 9 + a]! : at[a]! + rnd() * 6 - 3;
    }
  }
  return out;
}

function meshOf(positions: Float32Array, side: THREE.Side, normals: boolean): THREE.Mesh {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  if (normals) geometry.computeVertexNormals();
  return new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ side }));
}

function same(a: THREE.Intersection[], b: THREE.Intersection[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((hit, i) => {
    const other = b[i]!;
    return hit.faceIndex === other.faceIndex && hit.distance === other.distance && hit.point.equals(other.point) && hit.object === other.object
      && hit.face!.a === other.face!.a && hit.face!.normal.equals(other.face!.normal) && hit.barycoord!.equals(other.barycoord!)
      && (hit.normal === undefined ? other.normal === undefined : other.normal !== undefined && hit.normal.equals(other.normal));
  });
}

const raycaster = new THREE.Raycaster();
let struck = 0;
let doubles = 0;

function compare(name: string, mesh: THREE.Mesh, origin: THREE.Vector3, direction: THREE.Vector3) {
  raycaster.set(origin, direction.clone().normalize());
  mesh.raycast = THREE.Mesh.prototype.raycast;
  const old = raycaster.intersectObject(mesh, false);
  mesh.raycast = treeRaycast;
  const now = raycaster.intersectObject(mesh, false);
  if (old.length > 0) struck += 1;
  if (old.length > 1) doubles += 1;
  check(`${name}: ${old.length} hits before, ${now.length} now`, same(old, now));
}

const poses: THREE.Matrix4[] = [
  new THREE.Matrix4(),
  new THREE.Matrix4().compose(new THREE.Vector3(12, -7, 3), new THREE.Quaternion().setFromEuler(new THREE.Euler(0.4, -1.1, 2.3)), new THREE.Vector3(1, 1, 1)),
  // A scale preview grows the body about its centre.
  new THREE.Matrix4().compose(new THREE.Vector3(-30, 4, 9), new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.7, 0.2, 0.9)), new THREE.Vector3(1.7, 1.7, 1.7)),
];

for (const [label, positions] of [["slab", slab(24)], ["scatter", scatter(3000)]] as const) {
  for (const side of [THREE.DoubleSide, THREE.FrontSide, THREE.BackSide]) {
    for (const [p, pose] of poses.entries()) {
      const mesh = meshOf(positions, side, label === "slab");
      mesh.matrixAutoUpdate = false;
      mesh.matrix.copy(pose);
      mesh.updateMatrixWorld(true);
      const name = `${label} side ${side} pose ${p}`;
      for (let k = 0; k < 400; k += 1) {
        // Aimed at a point near the mesh, from outside it, from inside it, and from far off.
        const target = new THREE.Vector3(rnd() * 24, rnd() * 24, rnd() * 8).applyMatrix4(pose);
        const from = k % 5 === 0 ? new THREE.Vector3(rnd() * 24, rnd() * 24, 2).applyMatrix4(pose) : new THREE.Vector3(rnd() * 200 - 100, rnd() * 200 - 100, rnd() * 200 - 100);
        compare(name, mesh, from, target.clone().sub(from));
      }
      // Along the axes, where a slab test divides by nothing, and through corners and edges two triangles share.
      for (let k = 0; k < 60; k += 1) {
        const axis = new THREE.Vector3(k % 3 === 0 ? 1 : 0, k % 3 === 1 ? 1 : 0, k % 3 === 2 ? 1 : 0).multiplyScalar(k % 2 === 0 ? 1 : -1);
        const corner = Math.floor(rnd() * (positions.length / 3)) * 3;
        const through = new THREE.Vector3(positions[corner]!, positions[corner + 1]!, positions[corner + 2]!);
        const local = through.clone().addScaledVector(axis, -50);
        // In the mesh's own frame the ray is on an axis and passes through a shared corner.
        compare(`${name} axis`, mesh, local.applyMatrix4(pose), axis.clone().transformDirection(pose));
        compare(`${name} whole`, mesh, new THREE.Vector3(Math.round(rnd() * 24), Math.round(rnd() * 24), 40).applyMatrix4(pose), new THREE.Vector3(0, 0, -1).transformDirection(pose));
      }
      // A near and far limit drops hits by their distance, as before.
      raycaster.near = 20;
      raycaster.far = 90;
      for (let k = 0; k < 40; k += 1) compare(`${name} near-far`, mesh, new THREE.Vector3(rnd() * 100 - 50, rnd() * 100 - 50, 60), new THREE.Vector3(rnd() * 24, rnd() * 24, 2).applyMatrix4(pose).sub(new THREE.Vector3(0, 0, 60)));
      raycaster.near = 0;
      raycaster.far = Infinity;
    }
  }
}
check(`enough rays strike (${struck}) and strike more than once (${doubles}) for the comparison to mean something`, struck > 3000 && doubles > 1500);

// The tree alone: each triangle is in exactly one leaf, and the candidates of a ray are a small share of the mesh.
{
  const positions = slab(60);
  const tree = buildRayTree(positions);
  const seen = new Uint8Array(positions.length / 9);
  for (let i = 0; i < tree.order.length; i += 1) seen[tree.order[i]!]! += 1;
  check("every triangle is in the tree once", seen.every((n) => n === 1));
  const out: number[] = [];
  rayCandidates(tree, 30.3, 30.2, 100, 0, 0, -1, out);
  check(`a ray down through a ${positions.length / 9}-triangle slab asks about a handful (${out.length})`, out.length > 0 && out.length <= 64);
  check("candidates come lowest first", out.every((t, i) => i === 0 || out[i - 1]! < t));
  check("an empty mesh has no candidates", rayCandidates(buildRayTree(new Float32Array(0)), 0, 0, 0, 0, 0, 1, out).length === 0);
  // Triangles all in one spot still build a tree that ends.
  const pile = new Float32Array(9 * 100);
  for (let i = 0; i < pile.length; i += 9) pile.set([0, 0, 0, 1, 0, 0, 0, 1, 0], i);
  check("a pile of the same triangle is all candidates", rayCandidates(buildRayTree(pile), 0.2, 0.2, 5, 0, 0, -1, out).length === 100);
}

if (failed) process.exit(1);
console.log("solid-ray tests passed");
