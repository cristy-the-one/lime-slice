/**
 * The edge under the pointer, from segments projected once, is the edge the old loop named, which projected every
 * point on every move.
 */
import * as THREE from "three";
import { type EdgeRow, nearestEdge, projectEdges, segmentDistance } from "./edge-screen.ts";

let failed = 0;
function check(name: string, ok: boolean) {
  if (ok) return;
  failed += 1;
  console.error(`FAIL ${name}`);
}

let seed = 9001;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

const EDGE_PX = 8;
const rect = { left: 37.5, top: 12.25, width: 1180, height: 760 };

function edgesOf(count: number, points: number): EdgeRow[] {
  const out: EdgeRow[] = [];
  for (let id = 0; id < count; id += 1) {
    const x0 = rnd() * 60, y0 = rnd() * 50, z0 = rnd() * 6, r = 0.3 + rnd() * 3;
    // Some edges are too short to have a segment, and one in nine has a point count that leaves numbers over.
    const n = id % 23 === 0 ? 1 : points;
    const pts = new Float32Array(n * 3 + (id % 9 === 0 ? 2 : 0));
    for (let k = 0; k < n; k += 1) {
      const a = (k / Math.max(1, n - 1)) * Math.PI * 1.5;
      pts[k * 3] = x0 + r * Math.cos(a);
      pts[k * 3 + 1] = y0 + r * Math.sin(a);
      pts[k * 3 + 2] = z0 + k * 0.05;
    }
    out.push({ id: id * 2 + 1, points: pts });
  }
  // Two edges on the same line: the first listed wins a tie.
  out.push({ id: 9000, points: new Float32Array([10, 10, 5, 20, 10, 5]) }, { id: 9001, points: new Float32Array([10, 10, 5, 20, 10, 5]) });
  return out;
}

function view(position: THREE.Vector3, target: THREE.Vector3, pose: THREE.Matrix4, near: number) {
  const camera = new THREE.PerspectiveCamera(40, rect.width / rect.height, near, 400);
  camera.position.copy(position);
  camera.up.set(0, 0, 1);
  camera.lookAt(target);
  camera.updateMatrixWorld(true);
  const body = new THREE.Object3D();
  body.matrixAutoUpdate = false;
  body.matrix.copy(pose);
  body.updateMatrixWorld(true);
  const projected = new THREE.Vector3();
  // As the view projects a point of the solid: into the world, through the camera, onto the page.
  const project = (x: number, y: number, z: number) => {
    projected.set(x, y, z);
    body.localToWorld(projected);
    projected.project(camera);
    return { x: rect.left + (projected.x * 0.5 + 0.5) * rect.width, y: rect.top + (-projected.y * 0.5 + 0.5) * rect.height, z: projected.z };
  };
  return { body, project };
}

for (const [label, position, near, section] of [
  ["from the front right", new THREE.Vector3(90, -70, 60), 0.5, false],
  ["from inside the part, edges behind the camera", new THREE.Vector3(30, 25, 3), 0.5, false],
  ["with a section", new THREE.Vector3(90, -70, 60), 0.5, true],
  ["with a near plane that cuts edges off", new THREE.Vector3(60, -20, 30), 45, true],
] as const) {
  const pose = new THREE.Matrix4().compose(new THREE.Vector3(4, -3, 1), new THREE.Quaternion().setFromEuler(new THREE.Euler(0.1, -0.2, 0.7)), new THREE.Vector3(1.2, 1.2, 1.2));
  const { body, project } = view(position, new THREE.Vector3(30, 25, 3), pose, near);
  const edges = edgesOf(900, 12);
  const seams = new Set([3, 11, 401]);
  const plane = new THREE.Plane(new THREE.Vector3(1, 0, 0).normalize(), -34);
  const probe = new THREE.Vector3();
  const cutAway = (points: ArrayLike<number>, i: number) => {
    probe.set(points[i]!, points[i + 1]!, points[i + 2]!);
    body.localToWorld(probe);
    return plane.distanceToPoint(probe) < 0;
  };

  /** The loop as it was. */
  const before = (px: number, py: number): number | null => {
    let best: { index: number; distance: number } | null = null;
    for (const edge of edges) {
      if (seams.has(edge.id)) continue;
      const points = edge.points;
      for (let i = 0; i + 5 < points.length; i += 3) {
        if (section && cutAway(points, i) && cutAway(points, i + 3)) continue;
        const a = project(points[i]!, points[i + 1]!, points[i + 2]!);
        const b = project(points[i + 3]!, points[i + 4]!, points[i + 5]!);
        if (a.z < -1 || a.z > 1 || b.z < -1 || b.z > 1) continue;
        const distance = segmentDistance(px, py, a.x, a.y, b.x, b.y);
        if (distance <= EDGE_PX && (best == null || distance < best.distance)) best = { index: edge.id, distance };
      }
    }
    return best ? best.index : null;
  };

  const held = projectEdges(
    edges,
    seams,
    (points, at, out) => {
      const p = project(points[at]!, points[at + 1]!, points[at + 2]!);
      out[0] = p.x;
      out[1] = p.y;
      out[2] = p.z;
    },
    section ? cutAway : null,
  );
  let picked = 0;
  let wrong = 0;
  for (let k = 0; k < 3000; k += 1) {
    // Over the canvas, at whole and at fractional pixels, and now and then right on a projected point.
    let px = rect.left + rnd() * rect.width;
    let py = rect.top + rnd() * rect.height;
    if (k % 3 === 0) {
      px = Math.round(px);
      py = Math.round(py);
    }
    if (k % 7 === 0 && held.count > 0) {
      const s = Math.floor(rnd() * held.count) * 4;
      px = held.xy[s]!;
      py = held.xy[s + 1]! + (k % 14 === 0 ? EDGE_PX : 0);
    }
    const old = before(px, py);
    const now = nearestEdge(held, px, py, EDGE_PX);
    if (old != null) picked += 1;
    if (old !== now) wrong += 1;
  }
  check(`${label}: ${wrong} of 3000 pointers name another edge`, wrong === 0);
  check(`${label}: enough pointers land on an edge (${picked}) and segments are held (${held.count})`, picked > 150 && held.count > 0);
  if (label === "from the front right") {
    check("the first of two edges on one line wins", nearestEdge(held, ...(() => {
      const p = project(15, 10, 5);
      return [p.x, p.y] as [number, number];
    })(), EDGE_PX) === 9000);
    // Written over, not grown, when asked again with room to spare.
    const again = projectEdges(edges.slice(0, 10), null, (_p, _a, out) => out.fill(0), null, held);
    check("the held arrays are used again", again === held && again.count === edges.slice(0, 10).reduce((n, e) => n + Math.max(0, Math.floor(e.points.length / 3) - 1), 0));
  }
}

if (failed) process.exit(1);
console.log("edge-screen tests passed");
