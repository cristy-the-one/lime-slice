import { contactAt, downInSource, hullOf, layFlatMatrix, restPose } from "./bed-rest.ts";
import { eulerOrient, matMul, placeMesh, rotX, rotY, rotZ, settle, type Mat3 } from "./mesh-place.ts";

let failed = 0;

function check(name: string, ok: boolean, detail = ""): void {
  if (ok) return;
  failed += 1;
  console.error(`FAIL ${name} ${detail}`);
}

function near(name: string, got: number, want: number, tol: number): void {
  check(name, Math.abs(got - want) <= tol, `got ${got}, want ${want} ± ${tol}`);
}

type V = [number, number, number];

/** A convex solid from a closed outline in XZ, extruded along Y. */
function prism(profile: [number, number][], depth: number): Float32Array {
  const out: number[] = [];
  const front = (p: [number, number]): V => [p[0], 0, p[1]];
  const back = (p: [number, number]): V => [p[0], depth, p[1]];
  for (let i = 1; i + 1 < profile.length; i++) {
    out.push(...front(profile[0]), ...front(profile[i]), ...front(profile[i + 1]));
    out.push(...back(profile[0]), ...back(profile[i + 1]), ...back(profile[i]));
  }
  for (let i = 0; i < profile.length; i++) {
    const a = profile[i];
    const b = profile[(i + 1) % profile.length];
    out.push(...front(a), ...back(b), ...front(b), ...front(a), ...back(a), ...back(b));
  }
  return new Float32Array(out);
}

function box(w: number, d: number, h: number): Float32Array {
  return prism([[0, 0], [w, 0], [w, h], [0, h]], d);
}

/** `source` with its bottom face on Z = 0 cut into n by n squares, each in two triangles, with a little noise as a real mesh has. */
function manyBottom(source: Float32Array, w: number, d: number, n: number, noise = 0): Float32Array {
  const kept: number[] = [];
  for (let i = 0; i < source.length; i += 9) {
    const flatBottom = source[i + 2] === 0 && source[i + 5] === 0 && source[i + 8] === 0;
    if (!flatBottom) kept.push(...source.slice(i, i + 9));
  }
  const jig = (i: number, j: number): V => {
    const edge = i === 0 || j === 0 || i === n || j === n;
    const s = edge ? 0 : noise;
    return [(w * i) / n + s * Math.sin(i * 7 + j), (d * j) / n + s * Math.cos(i + j * 5), s * Math.sin(i * j)];
  };
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const a = jig(i, j), b = jig(i + 1, j), c = jig(i + 1, j + 1), e = jig(i, j + 1);
      kept.push(...a, ...e, ...c, ...a, ...c, ...b);
    }
  }
  return new Float32Array(kept);
}

/** A block narrowing upward: the bottom is the largest flat face, and the slanted sides are the next largest. */
function frustum(n: number, noise: number): Float32Array {
  return manyBottom(prism([[0, 0], [40, 0], [30, 20], [10, 20]], 40), 40, 40, n, noise);
}

function cylinderOnX(radius: number, length: number, segments: number): Float32Array {
  const out: number[] = [];
  for (let i = 0; i < segments; i++) {
    const a = (2 * Math.PI * i) / segments;
    const b = (2 * Math.PI * (i + 1)) / segments;
    const p = (x: number, t: number): V => [x, radius * Math.cos(t), radius * Math.sin(t)];
    out.push(...p(0, a), ...p(length, a), ...p(length, b), ...p(0, a), ...p(length, b), ...p(0, b));
    out.push(0, 0, 0, ...p(0, b), ...p(0, a));
    out.push(length, 0, 0, ...p(length, a), ...p(length, b));
  }
  return new Float32Array(out);
}

/** A block whose bottom edges are rounded with a fillet, its top chamfered smaller, so the flat bottom is the largest flat. */
function filletedBase(size: number, height: number, radius: number, steps: number): Float32Array {
  const profile: [number, number][] = [];
  profile.push([radius, 0]);
  profile.push([size - radius, 0]);
  for (let i = 1; i <= steps; i++) {
    const t = ((Math.PI / 2) * i) / steps;
    profile.push([size - radius + radius * Math.sin(t), radius - radius * Math.cos(t)]);
  }
  profile.push([size, height - 6]);
  profile.push([size - 6, height]);
  profile.push([6, height]);
  profile.push([0, height - 6]);
  for (let i = steps - 1; i >= 1; i--) {
    const t = ((Math.PI / 2) * i) / steps;
    profile.push([radius - radius * Math.sin(t), radius - radius * Math.cos(t)]);
  }
  profile.push([0, radius]);
  return prism(profile, size);
}

/** Where the lowest point of the part sits under `orient` before it is seated, relative to the bed it is put on. */
function seatAfter(orient: Mat3, source: Float32Array): number {
  return placeMesh(source, orient, 1, 220, 220, true).bounds.min[2];
}

/** The angle between the bed direction two poses hold in the part, degrees. */
function between(a: Mat3, b: Mat3): number {
  const u = downInSource(a);
  const v = downInSource(b);
  return (Math.acos(Math.max(-1, Math.min(1, u[0] * v[0] + u[1] * v[1] + u[2] * v[2]))) * 180) / Math.PI;
}

const IDENT: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

// The hull is the hull: a box has six faces and the right volume.
{
  const hull = hullOf(box(20, 30, 10))!;
  check("box hull exists", !!hull);
  check("box hull merges into six faces", hull.faces.length === 6, `${hull.faces.length}`);
  let volume = 0;
  for (let i = 0; i < hull.tris.length; i += 9) {
    const t = hull.tris;
    volume += (t[i] * (t[i + 4] * t[i + 8] - t[i + 5] * t[i + 7]) - t[i + 1] * (t[i + 3] * t[i + 8] - t[i + 5] * t[i + 6]) + t[i + 2] * (t[i + 3] * t[i + 7] - t[i + 4] * t[i + 6])) / 6;
  }
  near("box hull volume", volume, 6000, 0.01);
}

// A cloud of points: the hull holds every one of them and is convex.
{
  const cloud: number[] = [];
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 4000; i++) {
    const u = rnd() * 2 - 1;
    const phi = rnd() * Math.PI * 2;
    const r = 20 + rnd() * 3;
    cloud.push(r * Math.sqrt(1 - u * u) * Math.cos(phi), r * Math.sqrt(1 - u * u) * Math.sin(phi) * 0.7, r * u * 0.5);
  }
  const points = new Float32Array(cloud);
  const hull = hullOf(points)!;
  let worst = -Infinity;
  for (let t = 0; t < hull.tris.length / 9; t++) {
    const nx = hull.normals[t * 3], ny = hull.normals[t * 3 + 1], nz = hull.normals[t * 3 + 2];
    const d = nx * hull.tris[t * 9] + ny * hull.tris[t * 9 + 1] + nz * hull.tris[t * 9 + 2];
    for (let p = 0; p < points.length; p += 3) worst = Math.max(worst, nx * points[p] + ny * points[p + 1] + nz * points[p + 2] - d);
  }
  check("every point lies inside its hull", worst < 1e-3, `worst ${worst}`);
}

// A flat mesh has no hull and the drop leaves the pose alone.
{
  const flat = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  check("a flat mesh has no hull", hullOf(flat) === null);
  check("the drop leaves it as it is", layFlatMatrix(flat).join() === IDENT.join());
}

// A box held 8 degrees off settles flat.
{
  const source = settle(box(20, 20, 10));
  const hull = hullOf(source)!;
  const held = matMul(rotX(8), IDENT);
  const rest = restPose(hull, held, 1);
  check("a box settles", rest.snapped);
  near("a box settles flat", seatAfter(rest.orient, source), 0, 1e-6);
  near("a box settles with its face on the bed", between(rest.orient, IDENT), 0, 1e-4);
  near("a box's contact is its face", rest.areaMm2, 400, 0.5);
  const sideways = restPose(hull, matMul(rotY(8), rotZ(30)), 1);
  check("a box settles about two axes", sideways.snapped && between(sideways.orient, IDENT) < 1e-4, `${between(sideways.orient, IDENT)}`);
  const far = restPose(hull, matMul(rotX(45), IDENT), 1);
  check("a box held at 45 degrees keeps its angle", !far.snapped && far.orient.join() === matMul(rotX(45), IDENT).join());
}

// A cylinder on its side stays on its side, close to the angle it was held.
{
  const source = cylinderOnX(10, 40, 96);
  const hull = hullOf(source)!;
  const held = rotX(7);
  const rest = restPose(hull, held, 1);
  check("a cylinder on its side settles", rest.snapped);
  check("a cylinder stays close to its held angle", between(rest.orient, held) <= 2.2, `${between(rest.orient, held)}`);
  check("a cylinder does not stand on an end", Math.abs(downInSource(rest.orient)[0]) < 0.05);
  const tilted = matMul(rotY(45), IDENT);
  const free = restPose(hull, tilted, 1);
  check("a cylinder tilted half way keeps its angle", !free.snapped && free.orient.join() === tilted.join());
}

// A wedge: the larger face within reach wins, and a pose out of reach is kept.
{
  const profile: [number, number][] = [[0, 0], [10, 0], [40, 6], [40, 20], [0, 20]];
  const source = prism(profile, 20);
  const hull = hullOf(source)!;
  const ramp = (Math.atan2(6, 30) * 180) / Math.PI;
  const mid = restPose(hull, rotY(ramp / 2), 1, 12);
  const down = downInSource(mid.orient);
  check("a wedge held between two faces takes the larger", mid.snapped && down[0] > 0.15, `${down}`);
  near("the wedge's contact is the ramp", mid.areaMm2, Math.hypot(30, 6) * 20, 20);
  const base = restPose(hull, rotY(-3), 1, 12);
  check("a wedge held near its base takes the base", base.snapped && between(base.orient, IDENT) < 1e-4, `${between(base.orient, IDENT)}`);
  const out = matMul(rotY(60), IDENT);
  const kept = restPose(hull, out, 1, 12);
  check("a wedge held outside every cone keeps its angle", !kept.snapped && kept.orient.join() === out.join());
}

// An L-part rests on its long leg when held near it.
{
  const profile: [number, number][] = [[0, 0], [40, 0], [40, 6], [6, 6], [6, 30], [0, 30]];
  const source = prism(profile, 20);
  const hull = hullOf(source)!;
  const rest = restPose(hull, rotY(9), 1);
  check("an L-part settles on its long leg", rest.snapped && between(rest.orient, IDENT) < 1e-4);
  near("an L-part's contact is the leg", rest.areaMm2, 40 * 20, 1);
}

// The drop picks the largest merged flat region: a face of many triangles, and noise on its vertices.
{
  const source = frustum(24, 3e-5);
  const turned = matMul(rotX(37), matMul(rotZ(19), IDENT));
  const lay = layFlatMatrix(source, turned);
  const contact = contactAt(hullOf(source)!, downInSource(lay), 1).areaMm2;
  check("the drop lands the big face of many triangles", contact > 1500, `contact ${contact}`);
  near("the drop leaves the part on the bed", seatAfter(lay, source), 0, 1e-4);
}

// The drop prefers the face with the most contact over a facet of equal total normal.
{
  const stem = box(10, 10, 10);
  const cap = box(40, 40, 4);
  const mushroom = new Float32Array(stem.length + cap.length);
  mushroom.set(stem);
  for (let i = 0; i < cap.length; i += 3) {
    mushroom[stem.length + i] = cap[i] - 15;
    mushroom[stem.length + i + 1] = cap[i + 1] - 15;
    mushroom[stem.length + i + 2] = cap[i + 2] + 10;
  }
  const lay = layFlatMatrix(mushroom);
  const contact = contactAt(hullOf(mushroom)!, downInSource(lay), 1).areaMm2;
  check("the drop stands a mushroom on its cap, not its stem", contact > 1000, `contact ${contact}`);
}

// A filleted base: the drop finds the flat bottom, and a pose held near it settles onto it.
{
  const source = filletedBase(40, 15, 4, 24);
  const hull = hullOf(source)!;
  const lay = layFlatMatrix(source, matMul(rotX(70), IDENT));
  const flat = contactAt(hull, downInSource(lay), 1);
  check("the drop finds the flat bottom of a filleted base", flat.areaMm2 > 1000, `contact ${flat.areaMm2}`);
  const rest = restPose(hull, matMul(rotY(5), IDENT), 1);
  check("a filleted base settles on its flat bottom", rest.snapped && rest.areaMm2 > 1000, `contact ${rest.areaMm2}`);
}

// A scale changes the contact by its square, and the band by its own measure.
{
  const hull = hullOf(box(20, 20, 10))!;
  near("contact grows with the square of the scale", contactAt(hull, [0, 0, -1], 2).areaMm2, 1600, 1);
}

// The patch is the surface within the band, nine numbers a triangle.
{
  const hull = hullOf(box(20, 20, 10))!;
  const { patch } = contactAt(hull, [0, 0, -1], 1, true);
  check("a patch comes back when asked", !!patch && patch.length >= 18 && patch.length % 9 === 0);
}

// A drag frame on a large mesh reads the cached hull. Printed for the PR; the bound is loose.
{
  const rings = 400;
  const segments = 600;
  const out: number[] = [];
  const at = (i: number, j: number): V => {
    const theta = (Math.PI * i) / rings;
    const phi = (2 * Math.PI * j) / segments;
    const r = 30 + 2 * Math.sin(9 * theta) * Math.cos(7 * phi);
    return [r * Math.sin(theta) * Math.cos(phi), r * Math.sin(theta) * Math.sin(phi) * 0.8, r * Math.cos(theta) * 0.6];
  };
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < segments; j++) {
      const a = at(i, j), b = at(i + 1, j), c = at(i + 1, j + 1), d = at(i, j + 1);
      out.push(...a, ...b, ...c, ...a, ...c, ...d);
    }
  }
  const big = new Float32Array(out);
  const t0 = performance.now();
  const hull = hullOf(big)!;
  const built = performance.now() - t0;
  const frames: number[] = [];
  for (let k = 0; k < 30; k++) {
    const t1 = performance.now();
    restPose(hull, matMul(rotX(k * 0.7), matMul(rotY(3), IDENT)), 1);
    frames.push(performance.now() - t1);
  }
  frames.sort((p, q) => p - q);
  console.log(`large mesh: ${big.length / 9} triangles, hull ${hull.tris.length / 9} faces in ${built.toFixed(0)} ms, drag frame median ${frames[15].toFixed(2)} ms, worst ${frames[29].toFixed(2)} ms`);
  check("a drag frame stays interactive", frames[15] < 16, `${frames[15]}`);
}

check("euler round trip stays out of the way", eulerOrient(0, 0, 0).join() === IDENT.join());

if (failed > 0) process.exit(1);
