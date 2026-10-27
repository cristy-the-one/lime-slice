import { circlesOf, faceCentre, featuresOf, fitCircle, nearestFeature } from "./measure-snap.ts";

let failed = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) return;
  failed += 1;
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}

/** A 20 x 10 x 5 box as a triangle soup; the first two triangles are its floor. */
function box(): Float32Array {
  const c = (x: number, y: number, z: number): number[] => [x * 20, y * 10, z * 5];
  const quads = [
    [c(0, 0, 0), c(0, 1, 0), c(1, 1, 0), c(1, 0, 0)],
    [c(0, 0, 1), c(1, 0, 1), c(1, 1, 1), c(0, 1, 1)],
    [c(0, 0, 0), c(1, 0, 0), c(1, 0, 1), c(0, 0, 1)],
    [c(0, 1, 0), c(0, 1, 1), c(1, 1, 1), c(1, 1, 0)],
    [c(0, 0, 0), c(0, 0, 1), c(0, 1, 1), c(0, 1, 0)],
    [c(1, 0, 0), c(1, 1, 0), c(1, 1, 1), c(1, 0, 1)],
  ];
  return Float32Array.from(quads.flatMap((q) => [...q[0]!, ...q[1]!, ...q[2]!, ...q[0]!, ...q[2]!, ...q[3]!]));
}

const mesh = box();
const set = featuresOf(mesh);

const vertex = nearestFeature(set, [19.6, 0.3, 0.2], 1);
check("a point near a corner snaps to the vertex", vertex?.kind === "vertex" && vertex.at.join() === "20,0,0", JSON.stringify(vertex));

const mid = nearestFeature(set, [10.2, 0.1, 0.2], 1);
check("a point near an edge's middle snaps to the midpoint", mid?.kind === "midpoint" && mid.at.join() === "10,0,0", JSON.stringify(mid));

check("a point away from every feature snaps to nothing", nearestFeature(set, [10, 5, 0], 1) === null);
check("a vertex beats a nearer midpoint", nearestFeature(set, [19, 0, 0], 2.5)?.kind === "vertex");

const centre = faceCentre(mesh, 0);
check("the floor's centre is the middle of the floor", centre?.join() === "10,5,0", JSON.stringify(centre));
const onFace = nearestFeature(set, [10.3, 4.8, 0.1], 1, centre);
check("a point near the face's middle snaps to it", onFace?.kind === "face" && onFace.at.join() === "10,5,0", JSON.stringify(onFace));
check("the box centre is offered", nearestFeature(set, [10, 5, 2.5], 1)?.kind === "box-centre");

const twelve = Array.from({ length: 12 }, (_, t) => faceCentre(mesh, t));
check("every face of a box has a centre", twelve.every((p) => p !== null));

const lone = Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]);
check("a lone triangle has no face centre", faceCentre(lone, 0) === null);
check("an empty mesh has no features", featuresOf(new Float32Array(0)).kinds.length === 0);

/** A ring of `n` points on the circle of radius `r` about `c`, in the plane the unit axes `u` and `v` span. */
function ring(c: number[], r: number, u: number[], v: number[], n = 48, from = 0, to = 2 * Math.PI): number[] {
  const out: number[] = [];
  for (let i = 0; i <= n; i++) {
    const a = from + ((to - from) * i) / n;
    for (let k = 0; k < 3; k++) out.push(c[k]! + r * (Math.cos(a) * u[k]! + Math.sin(a) * v[k]!));
  }
  return out;
}

const hole = ring([10, 5, 5], 2, [1, 0, 0], [0, 1, 0]);
const fitted = fitCircle(hole);
check("a closed ring of an edge fits its circle", !!fitted && Math.abs(fitted.radius - 2) < 1e-6 && fitted.centre.every((v, i) => Math.abs(v - [10, 5, 5][i]!) < 1e-6), JSON.stringify(fitted));
check("a circle in a tilted plane is found as well", !!fitCircle(ring([1, 2, 3], 7, [0, 0.6, 0.8], [1, 0, 0])));
check("a half ring still counts, as a split circle does", !!fitCircle(ring([0, 0, 0], 3, [1, 0, 0], [0, 1, 0], 24, 0, Math.PI)));
check("a quarter arc is a fillet, not a circle", fitCircle(ring([0, 0, 0], 3, [1, 0, 0], [0, 1, 0], 12, 0, Math.PI / 2)) === null);
check("a straight edge is not a circle", fitCircle([0, 0, 0, 1, 0, 0, 2, 0, 0, 3, 0, 0, 4, 0, 0, 5, 0, 0, 6, 0, 0]) === null);
const squareRing = [0, 0, 0, 2.5, 0, 0, 5, 0, 0, 5, 2.5, 0, 5, 5, 0, 2.5, 5, 0, 0, 5, 0, 0, 2.5, 0, 0, 0, 0];
check("a square outline is not a circle", fitCircle(squareRing) === null);
check("two halves of one hole make one circle", circlesOf([ring([10, 5, 5], 2, [1, 0, 0], [0, 1, 0], 24, 0, Math.PI), ring([10, 5, 5], 2, [1, 0, 0], [0, 1, 0], 24, Math.PI, 2 * Math.PI)]).length === 1);

const withHole = featuresOf(mesh, [hole]);
const rimSpot: [number, number, number] = [11.9, 5.3, 5];
const onRim = nearestFeature(withHole, rimSpot, 1);
check("a point on a hole's rim snaps to the hole's centre", onRim?.kind === "circle" && onRim.at.every((v, i) => Math.abs(v - [10, 5, 5][i]!) < 1e-9), JSON.stringify(onRim));
check("a point in the middle of the hole, well off the rim, does not", nearestFeature(withHole, [10, 5, 5], 0.5)?.kind !== "circle");
check("without edges there is no circle to offer", nearestFeature(featuresOf(mesh), rimSpot, 1) === null);
const farFrom = nearestFeature(withHole, rimSpot, 1, null, { px: 10, from: (at) => Math.hypot(at[0] - rimSpot[0], at[1] - rimSpot[1], at[2] - rimSpot[2]) * 4 });
check("the pixel limit is the rim's, not the middle's", farFrom?.kind === "circle", JSON.stringify(farFrom));

if (failed) {
  console.error(`${failed} failed`);
  throw new Error(`${failed} failed`);
}
console.log("measure-snap: corners, midpoints, face centres and the box ok");
