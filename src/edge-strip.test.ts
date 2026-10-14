import { boundaryLoops, edgeRun, labelFaceRegions, nearestOnLoop, pointAt, regionSurface, stripSamples, type EdgeLoop } from "./edge-strip.ts";
import type { Vec3 } from "./support-paint.ts";

let failed = 0;

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) return;
  failed += 1;
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}

function soupOf(tris: number[][][]): Float32Array {
  return new Float32Array(tris.flat(2));
}

function quads(list: number[][][]): Float32Array {
  return soupOf(list.flatMap(([a, b, c, d]) => [[a!, b!, c!], [a!, c!, d!]]));
}

function cube(s: number): Float32Array {
  const p = (x: number, y: number, z: number) => [x * s, y * s, z * s];
  return quads([
    [p(0, 0, 0), p(0, 1, 0), p(1, 1, 0), p(1, 0, 0)],
    [p(0, 0, 1), p(1, 0, 1), p(1, 1, 1), p(0, 1, 1)],
    [p(0, 0, 0), p(1, 0, 0), p(1, 0, 1), p(0, 0, 1)],
    [p(0, 1, 0), p(0, 1, 1), p(1, 1, 1), p(1, 1, 0)],
    [p(0, 0, 0), p(0, 0, 1), p(0, 1, 1), p(0, 1, 0)],
    [p(1, 0, 0), p(1, 1, 0), p(1, 1, 1), p(1, 0, 1)],
  ]);
}

function cylinder(facets: number): Float32Array {
  const ring = (z: number) => Array.from({ length: facets }, (_, k) => [10 * Math.cos((2 * Math.PI * k) / facets), 10 * Math.sin((2 * Math.PI * k) / facets), z]);
  const lo = ring(0), hi = ring(20);
  const tris: number[][][] = [];
  for (let k = 0; k < facets; k++) {
    const n = (k + 1) % facets;
    tris.push([lo[k]!, lo[n]!, hi[n]!], [lo[k]!, hi[n]!, hi[k]!], [[0, 0, 0], lo[n]!, lo[k]!], [[0, 0, 20], hi[k]!, hi[n]!]);
  }
  return soupOf(tris);
}

/** A flat L in z = 0, fanned from the origin; its concave corner is (10, 10). */
const lShape = soupOf([
  [[0, 0, 0], [20, 0, 0], [20, 10, 0]],
  [[0, 0, 0], [20, 10, 0], [10, 10, 0]],
  [[0, 0, 0], [10, 10, 0], [10, 20, 0]],
  [[0, 0, 0], [10, 20, 0], [0, 20, 0]],
]);

/** A 10 mm square in z = 0 and a second square folded up from its x = 10 edge by `deg`. */
function fold(deg: number): Float32Array {
  const a = (Math.PI / 180) * deg;
  return quads([
    [[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0]],
    [[10, 10, 0], [10, 0, 0], [10 + 10 * Math.cos(a), 0, 10 * Math.sin(a)], [10 + 10 * Math.cos(a), 10, 10 * Math.sin(a)]],
  ]);
}

/** An open half-cylinder sheet of radius 10 about the y axis, y in [0, 20], wound so its normals point outward. */
function halfCylinder(facets: number): Float32Array {
  const rim = (y: number) => Array.from({ length: facets + 1 }, (_, k) => [10 * Math.cos((Math.PI * k) / facets), y, 10 * Math.sin((Math.PI * k) / facets)]);
  const lo = rim(0), hi = rim(20);
  return quads(Array.from({ length: facets }, (_, k) => [lo[k]!, hi[k]!, hi[k + 1]!, lo[k + 1]!]));
}

const near = (a: Vec3, b: Vec3, tol = 1e-6) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) <= tol;

function segmentDistance(p: Vec3, a: Vec3, b: Vec3): number {
  const d: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const t = Math.min(1, Math.max(0, ((p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1] + (p[2] - a[2]) * d[2]) / (d[0] * d[0] + d[1] * d[1] + d[2] * d[2])));
  return Math.hypot(p[0] - a[0] - d[0] * t, p[1] - a[1] - d[1] * t, p[2] - a[2] - d[2] * t);
}

function boundaryDistance(p: Vec3, loop: EdgeLoop): number {
  const n = loop.points.length;
  return Math.min(...loop.points.map((a, i) => segmentDistance(p, a, loop.points[(i + 1) % n]!)));
}

/** The region of the triangle whose first corner is `corner`. */
function regionAt(positions: Float32Array, region: Int32Array, corner: Vec3): number {
  for (let t = 0; t < region.length; t++) if (near([positions[t * 9]!, positions[t * 9 + 1]!, positions[t * 9 + 2]!], corner)) return region[t]!;
  throw new Error(`no triangle starts at ${corner}`);
}

{
  const soup = cube(20);
  const regions = labelFaceRegions(soup);
  check("a cube has 6 regions", regions.count === 6, `${regions.count}`);
  const top = regionAt(soup, regions.region, [0, 0, 20]);
  const loops = boundaryLoops(soup, regions, top);
  check("the top face has one loop", loops.length === 1, `${loops.length}`);
  const loop = loops[0]!;
  check("the top loop has 4 corners", loop.corners.join() === "0,1,2,3", loop.corners.join());
  const samples = stripSamples(loop, { kind: "loop" }, 1, 1);
  check("a whole-loop strip on the top face has 128 samples", samples.length === 128, `${samples.length}`);
  check("every top sample lies on z = 20 with normal +Z", samples.every((s) => Math.abs(s.point[2] - 20) <= 1e-6 && near(s.normal, [0, 0, 1])));
  const worst = Math.max(...samples.map((s) => Math.abs(boundaryDistance(s.point, loop) - 2)));
  check("every top sample is 2 mm inside the nearest edge", worst <= 1e-6, `off by ${worst}`);
  check("the corner disk sits inside the face at (2, 2, 20)", samples.some((s) => near(s.point, [2, 2, 20])));

  const seg = loop.points.findIndex((p, i) => near(p, [0, 0, 20]) && near(loop.points[(i + 1) % 4]!, [20, 0, 20]));
  check("the y = 0 edge is a loop segment", seg !== -1);
  const arc = stripSamples(loop, { kind: "arc", from: { seg, t: 0.25 }, to: { seg, t: 0.75 } }, 1, 1);
  check("a 10 mm arc on one edge has 21 samples", arc.length === 21, `${arc.length}`);
  check("the arc samples run along the edge's inset line", arc.every((s, k) => near(s.point, [5 + 0.5 * k, 2, 20]) && near(s.normal, [0, 0, 1])));
  const back = stripSamples(loop, { kind: "arc", from: { seg, t: 0.75 }, to: { seg, t: 0.25 } }, 1, 1);
  check("the same arc backwards is the direct piece, from its own start", back.length === 21 && near(back[0]!.point, [15, 2, 20]) && near(back[20]!.point, [5, 2, 20]));
  const next = (seg + 1) % 4;
  const turn = stripSamples(loop, { kind: "arc", from: { seg, t: 0.5 }, to: { seg: next, t: 0.5 } }, 1, 1);
  check("an arc around a corner mitres at (18, 2, 20) and has 33 samples", turn.length === 33 && turn.some((s) => near(s.point, [18, 2, 20])), `${turn.length}`);
  const far = stripSamples(loop, { kind: "arc", from: { seg, t: 0.5 }, to: { seg: (seg + 3) % 4, t: 0.5 } }, 1, 1);
  check("an arc takes the shorter way round, from its own start", far.length === 33 && near(far[0]!.point, [10, 2, 20]) && far.some((s) => near(s.point, [2, 2, 20])) && near(far[32]!.point, [2, 10, 20]), `${far.length}`);

  const nearest = nearestOnLoop(loop, [5, -1, 25]);
  check("the nearest loop place to (5, -1, 25)", nearest.pos.seg === seg && Math.abs(nearest.pos.t - 0.25) <= 1e-9 && near(nearest.point, [5, 0, 20]) && Math.abs(nearest.dist - Math.sqrt(26)) <= 1e-9);
  check("pointAt walks a segment", near(pointAt(loop, { seg, t: 0.1 }), [2, 0, 20]));
  const run = edgeRun(loop, { seg, t: 0.5 });
  check("an edge run on the cube is the one edge, open", !run.closed && run.points.length === 2 && near(run.points[0]!, [0, 0, 20]) && near(run.points[1]!, [20, 0, 20]));
  check("a flat face has no surface", regionSurface(soup, regions, top) === null);
}

{
  const regions = labelFaceRegions(lShape);
  check("a flat L is one region", regions.count === 1, `${regions.count}`);
  const loops = boundaryLoops(lShape, regions, 0);
  check("the L has one loop of 6 points with 6 corners", loops.length === 1 && loops[0]!.points.length === 6 && loops[0]!.corners.length === 6);
  const loop = loops[0]!;
  const samples = stripSamples(loop, { kind: "loop" }, 1, 1);
  check("the L strip has 128 samples", samples.length === 128, `${samples.length}`);
  const closest = Math.min(...samples.map((s) => boundaryDistance(s.point, loop)));
  check("no L sample is closer than 2 mm to any boundary segment", closest >= 2 - 1e-6, `${closest}`);
  check("the concave corner disk sits at (8, 8, 0)", samples.some((s) => near(s.point, [8, 8, 0])));
}

{
  const soup = cylinder(64);
  const regions = labelFaceRegions(soup);
  check("a 64-facet cylinder has 3 regions", regions.count === 3, `${regions.count}`);
  const side = regionAt(soup, regions.region, [10, 0, 0]);
  check("the side is one region of 128 triangles", regions.region.filter((r) => r === side).length === 128);
  const top = regionAt(soup, regions.region, [0, 0, 20]);
  const loops = boundaryLoops(soup, regions, top);
  check("the top cap has one loop of 64 points and no corners", loops.length === 1 && loops[0]!.points.length === 64 && loops[0]!.corners.length === 0);
  const run = edgeRun(loops[0]!, { seg: 7, t: 0.3 });
  check("an edge run on the cap is the whole loop, closed", run.closed && run.points.length === 64);
}

check("two quads at a 90° fold are 2 regions", labelFaceRegions(fold(90)).count === 2);
check("two quads at a 10° bend are 1 region", labelFaceRegions(fold(10)).count === 1);

{
  const soup = halfCylinder(32);
  const regions = labelFaceRegions(soup);
  check("a half-cylinder sheet is one region", regions.count === 1, `${regions.count}`);
  const loop = boundaryLoops(soup, regions, 0)[0]!;
  check("the sheet's loop has 66 points and 4 corners", loop.points.length === 66 && loop.corners.length === 4, `${loop.points.length} points, ${loop.corners.length} corners`);
  const surface = regionSurface(soup, regions, 0);
  check("a curved region has a surface", surface !== null);
  const sag = 10 * (1 - Math.cos(Math.PI / 64));
  const offRadius = (s: { point: Vec3 }) => Math.abs(Math.hypot(s.point[0], s.point[2]) - 10);
  const offRadial = (s: { point: Vec3; normal: Vec3 }) => (s.normal[0] * s.point[0] + s.normal[2] * s.point[2]) / Math.hypot(s.point[0], s.point[2]);
  const snapped = stripSamples(loop, { kind: "loop" }, 1, 1, surface);
  const planar = stripSamples(loop, { kind: "loop" }, 1, 1);
  check("the snapped and planar strips have the same count", snapped.length === planar.length && snapped.length > 0);
  check("every snapped sample lies within the facet sag of the cylinder", snapped.every((s) => offRadius(s) <= sag + 1e-9), `worst ${Math.max(...snapped.map(offRadius))} vs ${sag}`);
  check("every snapped normal is radial within 3°", snapped.every((s) => offRadial(s) >= Math.cos((Math.PI / 180) * 3)));
  check("every snapped sample stays between the rims", snapped.every((s) => s.point[1] >= 2 - 1e-6 && s.point[1] <= 18 + 1e-6));
  check("the planar strip leaves the cylinder by more than the sag", planar.some((s) => offRadius(s) > 0.09), `worst ${Math.max(...planar.map(offRadius))}`);
  check("the planar strip has non-radial normals", planar.some((s) => offRadial(s) < Math.cos((Math.PI / 180) * 5)));
}

{
  const lone = soupOf([[[0, 0, 0], [1, 0, 0], [0, 1, 0]]]);
  const loops = boundaryLoops(lone, labelFaceRegions(lone), 0);
  check("a lone triangle has one loop of 3 points", loops.length === 1 && loops[0]!.points.length === 3);
  const tiny = stripSamples(loops[0]!, { kind: "loop" }, 0.02, 0.02);
  check("a lone triangle's strip keeps 0.04 mm inside", tiny.every((s) => boundaryDistance(s.point, loops[0]!) >= 0.04 - 1e-6));

  const spike = soupOf([[[0, 0, 0], [20, 0, 0], [0, 1, 0]]]);
  const spikeLoop = boundaryLoops(spike, labelFaceRegions(spike), 0)[0]!;
  const spiked = stripSamples(spikeLoop, { kind: "loop" }, 0.05, 0.05);
  const tip = Math.max(...spiked.map((s) => s.point[0]));
  check("a 177° turn mitres no further than 4 x (offset + r) from its vertex", Math.abs(tip - 19.6) <= 0.0125, `tip at x = ${tip}`);

  const three = soupOf([[[0, 0, 0], [1, 0, 0], [0, 1, 0]], [[1, 0, 0], [0, 0, 0], [0, -1, 0]], [[1, 0, 0], [0, 0, 0], [0, 0, 1]]]);
  const regions = labelFaceRegions(three);
  check("an edge three faces share leaves the third face its own region", regions.count === 2, `${regions.count}`);
  const first = boundaryLoops(three, regions, 0);
  const second = boundaryLoops(three, regions, 1);
  check("the paired faces bound one loop of 4 points, the third one of 3", first.length === 1 && first[0]!.points.length === 4 && second.length === 1 && second[0]!.points.length === 3);

  const sliver = soupOf([[[0, 0, 0], [1, 0, 0], [0.00001, 0, 0]], [[0, 0, 0], [1, 0, 0], [0, 1, 0]]]);
  const slivers = labelFaceRegions(sliver);
  check("a sliver triangle gets region -1", slivers.region[0] === -1 && slivers.region[1] === 0 && slivers.count === 1);

  const flat = soupOf([[[0, 0, 0], [1, 0, 0], [2, 0, 0]], [[0, 0, 0], [2, 0, 0], [0, 1, 0]]]);
  const flats = labelFaceRegions(flat, 179);
  check("a collinear triangle with distinct corners gets region -1", flats.region[0] === -1 && flats.region[1] === 0 && flats.count === 1, `${flats.region.join()}`);
  const flatLoops = boundaryLoops(flat, flats, 0);
  const flatSamples = flatLoops.flatMap((loop) => stripSamples(loop, { kind: "loop" }, 0.05, 0.05));
  check("its neighbour's strip has only unit normals", flatSamples.length > 0 && flatSamples.every((s) => Math.abs(Math.hypot(...s.normal) - 1) <= 1e-6));
}

{
  const ring = Array.from({ length: 12 }, (_, k) => [10 * Math.cos((Math.PI * k) / 6), 10 * Math.sin((Math.PI * k) / 6), 0]);
  const tris: number[][][] = [];
  for (let k = 0; k < 12; k++) {
    const n = (k + 1) % 12;
    if (k > 0) tris.push([ring[k]!, ring[n]!, [0, 0, 10]]);
    tris.push([ring[n]!, ring[k]!, [0, 0, -10]]);
  }
  const soup = soupOf(tris);
  const regions = labelFaceRegions(soup, 179);
  check("a bipyramid missing one top face is one region of 23 triangles", regions.count === 1 && regions.region.length === 23);
  const loops = boundaryLoops(soup, regions, 0);
  check("the hole at the apex is one loop of 3 points", loops.length === 1 && loops[0]!.points.length === 3, loops.map((l) => l.points.length).join());
}

if (failed) throw new Error(`${failed} edge-strip checks failed`);
console.log("edge-strip: ok");
