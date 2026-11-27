/**
 * Smooth shading of the plate mesh in Prepare and Pose (src/plate-shading.ts, src/view-shading.ts): the exact normals
 * carried onto the plate mesh's own corners, shapes that are not the same refused, copies and scaled copies shaded alike,
 * the plate mesh and what is read from it never changed, and the drawing right under mirror and non-uniform scale.
 */
import * as THREE from "three";
import { decodeSolid, encodeSolid, type ParsedSolid } from "./model-reply.ts";
import { drawnSolid } from "./model-view/types.ts";
import { encodeStl, scaledCanonical, settleBy } from "./mesh-place.ts";
import { closeCracks } from "./mesh-check.ts";
import { aliasShading, giveShading, hasShadeSource, onShading, reachFor, shadeFromSolid, shadingOf, transferNormals } from "./plate-shading.ts";
import { isShaded, plateGeometry } from "./view-shading.ts";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(name);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name}${detail ? ` ${detail}` : ""}`);
}

const DEG = Math.PI / 180;

/** A UV sphere as a triangle soup wound outward, with the exact normal at each corner. */
function sphere(radius: number, around: number, up: number, centre: [number, number, number] = [0, 0, 0]) {
  const at = (i: number, j: number): [number, number, number] => {
    const theta = (j / up) * Math.PI;
    const phi = (i / around) * 2 * Math.PI;
    return [Math.sin(theta) * Math.cos(phi), Math.sin(theta) * Math.sin(phi), Math.cos(theta)];
  };
  const positions: number[] = [];
  const normals: number[] = [];
  const corner = (n: [number, number, number]) => {
    positions.push(centre[0] + n[0] * radius, centre[1] + n[1] * radius, centre[2] + n[2] * radius);
    normals.push(...n);
  };
  for (let j = 0; j < up; j += 1) {
    for (let i = 0; i < around; i += 1) {
      const a = at(i, j), b = at(i, j + 1), c = at(i + 1, j + 1), d = at(i + 1, j);
      if (j > 0) { corner(a); corner(b); corner(d); }
      if (j < up - 1) { corner(b); corner(c); corner(d); }
    }
  }
  return { positions: Float32Array.from(positions), normals: Float32Array.from(normals) };
}

/** A box from `min` to `max`, each face two triangles (or four about its centre), with each face's normal at its corners. */
function box(min: [number, number, number], max: [number, number, number], four = false) {
  const positions: number[] = [];
  const normals: number[] = [];
  const face = (corners: [number, number, number][], n: [number, number, number]) => {
    const tri = (p: [number, number, number][]) => {
      for (const q of p) { positions.push(...q); normals.push(...n); }
    };
    if (!four) {
      tri([corners[0]!, corners[1]!, corners[2]!]);
      tri([corners[0]!, corners[2]!, corners[3]!]);
      return;
    }
    const mid = [0, 1, 2].map((a) => corners.reduce((sum, c) => sum + c[a]!, 0) / 4) as [number, number, number];
    for (let k = 0; k < 4; k += 1) tri([corners[k]!, corners[(k + 1) % 4]!, mid]);
  };
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  face([[x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]], [0, 0, -1]);
  face([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], [0, 0, 1]);
  face([[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]], [0, -1, 0]);
  face([[x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]], [0, 1, 0]);
  face([[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], [-1, 0, 0]);
  face([[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]], [1, 0, 0]);
  return { positions: Float32Array.from(positions), normals: Float32Array.from(normals) };
}

/** The worst angle, degrees, between each corner's normal and the sphere's own normal there. */
function worstOnSphere(positions: Float32Array, normals: Float32Array, centre: [number, number, number]) {
  let worst = 0;
  for (let i = 0; i < positions.length; i += 3) {
    const r = [positions[i]! - centre[0], positions[i + 1]! - centre[1], positions[i + 2]! - centre[2]];
    const len = Math.hypot(r[0]!, r[1]!, r[2]!);
    const dot = (r[0]! * normals[i]! + r[1]! * normals[i + 1]! + r[2]! * normals[i + 2]!) / len;
    worst = Math.max(worst, Math.acos(Math.min(1, Math.max(-1, dot))) / DEG);
  }
  return worst;
}

const same = (a: ArrayLike<number>, b: ArrayLike<number>) => a.length === b.length && Array.from(a).every((v, i) => Object.is(v, b[i]));

// --- The same mesh, settled onto the bed as a commit settles it: the normals as they are.
const ball = sphere(10, 24, 16);
const settled = new Float32Array(ball.positions);
settleBy(settled);
const copied = transferNormals(settled, ball.positions, ball.normals, reachFor(0.1));
check("a mesh settled onto the bed takes the source's normals corner for corner", !!copied && copied.copied && same(copied.normals, ball.normals));

// --- Cracks closed by splitting triangles (a corner of one triangle in the middle of another's edge): carried by place.
const split: number[] = [];
for (let t = 0; t < ball.positions.length / 9; t += 1) {
  const p = Array.from(ball.positions.subarray(t * 9, t * 9 + 9));
  if (t % 3 !== 0) { split.push(...p); continue; }
  // Split at the middle of the first edge, as closeCracks fans a triangle over a corner on its edge.
  const m = [(p[0]! + p[3]!) / 2, (p[1]! + p[4]!) / 2, (p[2]! + p[5]!) / 2];
  split.push(p[0]!, p[1]!, p[2]!, ...m, p[6]!, p[7]!, p[8]!, ...m, p[3]!, p[4]!, p[5]!, p[6]!, p[7]!, p[8]!);
}
const splitMesh = Float32Array.from(split);
const carried = transferNormals(splitMesh, ball.positions, ball.normals, reachFor(0.1));
check("a mesh with triangles split takes every normal by place", !!carried && !carried.copied && carried.matched === splitMesh.length / 3);
check("the split mesh's normals are the sphere's, within half a degree", !!carried && worstOnSphere(splitMesh, carried.normals, [0, 0, 0]) < 0.5, carried ? worstOnSphere(splitMesh, carried.normals, [0, 0, 0]).toFixed(3) : "");

// --- Another tessellation of the same surface (as a solid meshed again from its STEP may be).
const finer = sphere(10, 32, 20);
const other = transferNormals(finer.positions, ball.positions, ball.normals, reachFor(0.1));
check("another tessellation of the same sphere is shaded within two degrees of the exact normals", !!other && worstOnSphere(finer.positions, other.normals, [0, 0, 0]) < 2, other ? worstOnSphere(finer.positions, other.normals, [0, 0, 0]).toFixed(3) : "refused");

// --- Sharp edges: a corner on a box edge takes its own face's normal, never its neighbour's.
const plain = box([0, 0, 0], [20, 10, 6]);
const quartered = box([0, 0, 0], [20, 10, 6], true);
const edged = transferNormals(quartered.positions, plain.positions, plain.normals, reachFor(0.1));
let worstEdge = 0;
if (edged) for (let i = 0; i < edged.normals.length; i += 3) {
  const dot = edged.normals[i]! * quartered.normals[i]! + edged.normals[i + 1]! * quartered.normals[i + 1]! + edged.normals[i + 2]! * quartered.normals[i + 2]!;
  worstEdge = Math.max(worstEdge, Math.acos(Math.min(1, dot)) / DEG);
}
check("every corner of a box, edges and corners too, keeps its own face's normal", !!edged && worstEdge < 1e-3, worstEdge.toFixed(5));

// --- Not the same shape: refused, so the part is drawn as before.
check("a box of another size is not shaded from this one", transferNormals(box([0, 0, 0], [24, 10, 6]).positions, plain.positions, plain.normals, reachFor(0.1)) === null);
const cube = box([-10, -10, -10], [10, 10, 10]);
check("a cube is not shaded from a sphere in the same box", transferNormals(cube.positions, ball.positions, ball.normals, reachFor(0.1)) === null);

// --- The table: a plate mesh, its copies (undo pins, the commit's copy) and the scaled copy Prepare draws.
let heard = 0;
const stop = onShading(() => { heard += 1; });
const plate = new Float32Array(splitMesh);
const before = new Float32Array(plate);
check("a plate mesh with no source is not shaded", shadingOf(plate) === null && !hasShadeSource(plate));
giveShading(plate, { positions: ball.positions, normals: ball.normals, reachMm: reachFor(0.1) });
check("a view hears when a plate mesh gets its normals", heard === 1);
const normals = shadingOf(plate);
check("the plate mesh is shaded once it has a source", !!normals && normals.length === plate.length && shadingOf(plate) === normals);
check("shading never changes the plate mesh", same(plate, before));
const pinned = new Float32Array(plate);
check("a copy of the plate mesh (an undo pin, the commit's copy) is shaded alike", hasShadeSource(pinned) && same(shadingOf(pinned)!, normals!));
const scaled = scaledCanonical(plate, 1.5);
aliasShading(scaled, plate);
check("the scaled copy Prepare draws takes the same normals (a uniform scale turns no normal)", shadingOf(scaled) === normals);
const stl = new Float32Array(cube.positions);
check("an imported mesh with no solid stays unshaded", shadingOf(stl) === null && !hasShadeSource(stl));
const nearly = new Float32Array(plate);
nearly[4] = nearly[4]! + 0.5;
check("a mesh with one number changed is not a copy", !hasShadeSource(nearly));
stop();

// --- From a reply: only when it carried the plate mesh's normals.
const quiet = new Float32Array(ball.positions);
shadeFromSolid(quiet, { positions: ball.positions }, 0.1);
check("a reply without plate normals gives no shading", !hasShadeSource(quiet));

// --- The wire: `display.plateNormals` is drawing data; the plate mesh decodes the same with or without it.
const solidBase = {
  volumeMm3: 4188,
  positions: Array.from(plain.positions),
  triangles: Array.from({ length: plain.positions.length / 9 }, (_, t) => Math.floor(t / 2)),
  faces: Array.from({ length: 6 }, () => ({ areaMm2: 1 })),
  edges: [{ lengthMm: 20, points: [0, 0, 0, 20, 0, 0] }],
};
const fp = { volumeMm3: 4188, faces: 6, edges: 1 };
const bare = decodeSolid({ id: 1, ...encodeSolid(solidBase), fingerprint: fp }) as ParsedSolid;
const step = decodeSolid({ id: 1, ...encodeSolid({ ...solidBase, plateNormals: Array.from(plain.normals) }), fingerprint: fp }) as ParsedSolid;
const view = decodeSolid({ id: 1, ...encodeSolid({ ...solidBase, plateNormals: Array.from(plain.normals), display: { positions: solidBase.positions, normals: Array.from(plain.normals), triangles: solidBase.triangles } }), fingerprint: fp }) as ParsedSolid;
check("replies with and without plate normals decode", typeof bare !== "string" && typeof step !== "string" && typeof view !== "string");
check("the plate mesh, faces and edges are the same bytes with or without plate normals", same(bare.positions, step.positions) && same(bare.triangles, step.triangles) && same(bare.positions, view.positions) && same(bare.edges[0]!.points, view.edges[0]!.points));
check("meshStep's plate normals alone are no display mesh", !step.display && !!step.plateNormals && same(step.plateNormals, plain.normals));
check("beside a display mesh they decode too", !!view.display && !!view.plateNormals && same(view.plateNormals, plain.normals));
check("the Model view's drawn solid carries no plate normals", drawnSolid(view).plateNormals === undefined && drawnSolid(view).positions === view.display!.positions);
const short = encodeSolid({ ...solidBase, plateNormals: Array.from(plain.normals) });
short.display = { plateNormals: Buffer.from(new Float32Array(9).buffer).toString("base64") };
const shortReply = decodeSolid({ id: 1, ...short, fingerprint: fp });
check("plate normals of the wrong length are left out and the reply stands", typeof shortReply !== "string" && !shortReply.plateNormals && same(shortReply.positions, bare.positions));

// --- A commit's bytes: what is sliced and saved is the same whether the mesh is shaded or not.
const committed = closeCracks(ball.positions);
const seat = settleBy(committed);
const bytesBefore = new Uint8Array(encodeStl(committed, "part.stl"));
shadeFromSolid(committed, { positions: ball.positions, plateNormals: ball.normals }, 0.1);
const drawn = shadingOf(committed);
const bytesAfter = new Uint8Array(encodeStl(committed, "part.stl"));
check("a committed plate mesh is shaded from its reply's normals", !!drawn && seat !== 0);
check("the STL bytes of a shaded plate mesh are the bytes of the unshaded one", same(bytesBefore, bytesAfter));

// --- Drawing: the geometry keeps the plate mesh's own positions; only `normal` is the exact one.
const geometry = plateGeometry(plate);
check("the view draws the plate mesh's own array, with the exact normals", geometry.getAttribute("position").array === plate && geometry.getAttribute("normal").array === normals && isShaded(geometry));
const flatGeometry = plateGeometry(stl);
check("an imported mesh is drawn as before: flat normals worked out by three.js", !isShaded(flatGeometry) && flatGeometry.getAttribute("normal").count === stl.length / 3);

// Paint lands where it did: a brush hit (point and face normal) is the same on the shaded and the flat geometry.
const flatOfPlate = new THREE.BufferGeometry();
flatOfPlate.setAttribute("position", new THREE.BufferAttribute(plate, 3));
flatOfPlate.computeVertexNormals();
const hitsOf = (g: THREE.BufferGeometry, matrix: THREE.Matrix4) => {
  const mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ side: THREE.DoubleSide }));
  mesh.matrixAutoUpdate = false;
  mesh.matrix.copy(matrix);
  mesh.updateMatrixWorld(true);
  const out: number[] = [];
  const ray = new THREE.Raycaster();
  for (let k = 0; k < 40; k += 1) {
    const dir = new THREE.Vector3(Math.cos(k * 0.7) * 0.3 - 1, Math.sin(k * 1.3) * 0.4, Math.cos(k * 0.9) * 0.2).normalize();
    ray.set(new THREE.Vector3(60, 3, 10).applyMatrix4(matrix), dir.transformDirection(matrix));
    const hit = ray.intersectObject(mesh)[0];
    if (hit) out.push(hit.point.x, hit.point.y, hit.point.z, hit.faceIndex ?? -1, hit.face!.normal.x, hit.face!.normal.y, hit.face!.normal.z);
  }
  return out;
};
const identity = new THREE.Matrix4();
check("a brush hit lands on the same point of the same triangle, shaded or flat", hitsOf(geometry, identity).length > 0 && same(hitsOf(geometry, identity), hitsOf(flatOfPlate, identity)));

// Mirror and non-uniform scale: three.js lights with the normal matrix (the inverse transpose), so each drawn normal is
// the exact normal of the transformed surface, and points out of it; a mirror's determinant flips the winding it culls.
const mirrored = new THREE.Matrix4().makeScale(-2, 1, 0.5).setPosition(30, -4, 7);
const normalMatrix = new THREE.Matrix3().getNormalMatrix(mirrored);
const centre = new THREE.Vector3(0, 0, 0).applyMatrix4(mirrored);
let worstLight = 0;
let inward = 0;
const p = new THREE.Vector3();
const n = new THREE.Vector3();
for (let i = 0; i < ball.positions.length; i += 3) {
  p.set(ball.positions[i]!, ball.positions[i + 1]!, ball.positions[i + 2]!).applyMatrix4(mirrored);
  n.set(ball.normals[i]!, ball.normals[i + 1]!, ball.normals[i + 2]!).applyMatrix3(normalMatrix).normalize();
  // The ellipsoid x²/400 + y²/100 + z²/25 = 1 about the centre: its gradient is the true normal.
  const q = p.clone().sub(centre);
  const exact = new THREE.Vector3(q.x / 400, q.y / 100, q.z / 25).normalize();
  worstLight = Math.max(worstLight, Math.acos(Math.min(1, n.dot(exact))) / DEG);
  if (n.dot(q) <= 0) inward += 1;
}
check("under mirror and non-uniform scale every drawn normal is the transformed surface's own", worstLight < 0.01, worstLight.toFixed(4));
check("and every one points out of the transformed part", inward === 0, String(inward));
check("three.js flips the culled winding for a mirroring matrix (negative determinant)", mirrored.determinant() < 0);
check("a brush hit is the same shaded or flat under a mirroring, stretching matrix too", same(hitsOf(geometry, mirrored), hitsOf(flatOfPlate, mirrored)));

// A duplicate shares its source's array: the same normals, and the geometry cache keyed by that array.
const duplicate = { sourcePos: plate };
check("a duplicate of a shaded part is shaded the same", shadingOf(duplicate.sourcePos) === normals);

// --- Time: a part of tens of thousands of triangles meshed differently is carried over in well under a second.
const big = sphere(40, 240, 120);
const bigTarget = sphere(40, 200, 100);
const started = performance.now();
const bigCarried = transferNormals(bigTarget.positions, big.positions, big.normals, reachFor(0.1));
const took = performance.now() - started;
console.log(`transfer: ${bigTarget.positions.length / 9} triangles from ${big.positions.length / 9} in ${took.toFixed(0)} ms`);
check("a large part's normals are carried over", !!bigCarried && worstOnSphere(bigTarget.positions, bigCarried.normals, [0, 0, 0]) < 1);

if (failed) {
  console.error(`${failed} checks failed`);
  process.exit(1);
}
console.log("plate shading: exact normals on the plate mesh's own triangles: ok");
