import { faceCentre, featuresOf, nearestFeature } from "./measure-snap.ts";

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

if (failed) {
  console.error(`${failed} failed`);
  throw new Error(`${failed} failed`);
}
console.log("measure-snap: corners, midpoints, face centres and the box ok");
