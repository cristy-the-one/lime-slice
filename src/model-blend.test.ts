import { holeAxis, HOLE_DOWN, lastFace, outwardFromMesh, selectedEdges, selectedFaces } from "./model-blend.ts";

let failed = 0;
function eq(name: string, got: unknown, want: unknown) {
  const left = JSON.stringify(got);
  const right = JSON.stringify(want);
  if (left === right) return;
  failed += 1;
  console.error(`FAIL ${name}\n  got  ${left}\n  want ${right}`);
}
function check(name: string, ok: boolean) {
  if (ok) return;
  failed += 1;
  console.error(`FAIL ${name}`);
}

const face = (index: number) => ({ kind: "face" as const, index });
const edge = (index: number) => ({ kind: "edge" as const, index });

eq("edges stay in pick order", selectedEdges([edge(2), face(0), edge(4), edge(2)]), [2, 4]);
eq("faces stay in pick order", selectedFaces([face(3), edge(1), face(5), face(3)]), [3, 5]);
eq("a face is not an edge", selectedEdges([face(1)]), []);
eq("the last face wins", lastFace([face(1), edge(3), face(6)]), 6);
eq("no face", lastFace([edge(1)]), null);

eq("no face drills down", holeAxis(null), HOLE_DOWN);
eq("a zero normal drills down", holeAxis([0, 0, 0]), HOLE_DOWN);
eq("the top face drills down", holeAxis([0, 0, 1]), [0, 0, -1]);
eq("the right face drills inward", holeAxis([1, 0, 0]), [-1, 0, 0]);
check("a long normal is shortened", Math.hypot(...holeAxis([0, 4, 0])) - 1 < 1e-9 && holeAxis([0, 4, 0])[1] === -1);

const positions = [0, 0, 0, 2, 0, 0, 2, 2, 0];
eq("a triangle in the XY plane points up", outwardFromMesh(positions, [3], 3), [0, 0, 1]);
eq("another face has no triangles", outwardFromMesh(positions, [3], 1), null);

if (failed) {
  console.error(`${failed} failed`);
  throw new Error(`${failed} failed`);
}
console.log("model-blend: edges, face, and drill axis ok");
