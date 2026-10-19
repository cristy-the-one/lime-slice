/**
 * The edge drag's geometry and wording, without WebGL: which faces an edge belongs to, which way
 * the knob points, which edges move together, and how a probe's largest size clamps the radius.
 */
import { blendDirection, blendRadius, edgeAppliedNote, edgeDragEdges, edgeDragKind, edgeDragNote, edgeDragOp, edgeDragRefusal, edgeFrame, edgeHoverHint, edgeIsSmooth, edgeSides, edgeSizeRefusal, facesOnEdge, knobAt, tabStillOpen, EDGE_EDIT_MS } from "./edge-drag.ts";
import type { Vec3 } from "../model-drag.ts";

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
function near(a: number, b: number, tol = 1e-6) {
  return Math.abs(a - b) < tol;
}
function nearPt(a: readonly number[], b: readonly number[], tol = 1e-6) {
  return a.length === b.length && a.every((value, i) => near(value, b[i]!, tol));
}

eq("Alt chamfers and a plain drag fillets", [edgeDragKind(false), edgeDragKind(true)], ["fillet", "chamfer"]);

eq("a hovered edge that is not selected moves alone", edgeDragEdges(4, [1, 3]), [4]);
eq("a hovered edge that is selected moves every selected edge, in pick order", edgeDragEdges(1, [5, 1, 3, 1]), [5, 1, 3]);
eq("one selected edge stays one edge", edgeDragEdges(3, [3]), [3]);

const s = Math.SQRT1_2;
check("two square outward normals bisect", nearPt(blendDirection([[0, 0, 1], [0, -1, 0]])!, [0, -s, s]));
eq("one normal is itself", blendDirection([[0, 0, 2]]), [0, 0, 1]);
eq("opposite normals cancel", blendDirection([[0, 0, 1], [0, 0, -1]]), null);
eq("a zero normal is skipped", blendDirection([[0, 0, 0], [1, 0, 0]]), [1, 0, 0]);

// A bottom face (outward −Z) and a front face (outward −Y) share the edge along X.
const positions = [0, 0, 0, 0, 10, 0, 10, 0, 0, 0, 0, 0, 10, 0, 0, 0, 0, 10];
const triangles = [0, 1];
const edge = [0, 0, 0, 10, 0, 0];
eq("the shared edge names its two faces", facesOnEdge(positions, triangles, edge), [0, 1]);
eq("a segment that misses both faces names no face", facesOnEdge(positions, triangles, [0, 5, 5, 1, 5, 5]), []);

const frame = edgeFrame(positions, triangles, edge, [5, 5, 0]);
check("the knob's point is the edge's midpoint", !!frame && nearPt(frame.point, [5, 0, 0]));
check("the knob points out along the bisector of the two outward normals", !!frame && nearPt(frame.dir, [0, -s, -s]));

const lost = edgeFrame(positions, triangles, [0, 5, 5, 10, 5, 5], [5, 5, 0]);
check("an edge with no faces still has a unit direction", !!lost && near(Math.hypot(...lost.dir), 1));
check("that direction is square to the edge", !!lost && near(lost.dir[0], 0));

eq("the knob sits on the midpoint at size 0", knobAt([5, 0, 0], [0, -s, -s], 0), [5, 0, 0]);
check("the knob moves out along the bisector by the radius", nearPt(knobAt([5, 0, 0], [0, -1, 0], 2), [5, -2, 0]));

const ray = { origin: [3, 5, 0] as Vec3, direction: [0, -1, 0] as Vec3 };
eq("the radius is the distance along the line from the edge", blendRadius(ray, [0, 0, 0], [1, 0, 0]), 3);
eq("Ctrl snaps that distance to the blend step", blendRadius(ray, [0, 0, 0], [1, 0, 0], { round: true }), 3);
eq("a size past the largest that fits is clamped", blendRadius({ origin: [4, 5, 0], direction: [0, -1, 0] }, [0, 0, 0], [1, 0, 0], { max: 1 }), 1);
eq("the far side of the edge is no radius", blendRadius({ origin: [-2, 5, 0], direction: [0, -1, 0] }, [0, 0, 0], [1, 0, 0]), 0);
eq("a ray along the bisector has no radius", blendRadius({ origin: [0, 0, 5], direction: [1, 0, 0] }, [0, 0, 0], [1, 0, 0]), null);


eq("the op names the edges and the size", edgeDragOp("chamfer", [1, 4], 0.5), { kind: "chamfer", edges: [1, 4], size: 0.5 });
eq("the hover hint names one edge", edgeHoverHint(1), "Drag to fillet · Alt: chamfer · type a size");
eq("the hover hint counts several edges", edgeHoverHint(3), "Drag to fillet 3 edges · Alt: chamfer · type a size");
eq("the live note is the size", edgeDragNote("fillet", 2, null), "Fillet 2 mm.");
eq("the live note says why a drag stopped", edgeDragNote("fillet", 2.5, 2.5), "Fillet 2.5 mm. The largest that fits is 2.5 mm.");
eq("a chamfer is named as one", edgeDragNote("chamfer", 1, null), "Chamfer 1 mm.");
eq("a refusal keeps the probe's sentence and its largest size", edgeDragRefusal("The fillet did not fit this edge", 2.5), "The fillet did not fit this edge. The largest that fits is 2.5 mm.");
eq("the applied note offers Tab", edgeAppliedNote("fillet", 2), "Fillet 2 mm · Tab to edit");
check("Tab still reaches a step inside the window", tabStillOpen(1000, 1000 + EDGE_EDIT_MS));
check("Tab misses a step once the window has passed", !tabStillOpen(1000, 1000 + EDGE_EDIT_MS + 1));

// A tangent edge offers no knob: the faces either side of it face the same way.
const edgeLine = [0, 0, 0, 10, 0, 0];
const square = [0, 0, 0, 10, 0, 0, 0, 10, 0, /* the other face, at 90° */ 0, 0, 0, 0, 0, 10, 10, 0, 0];
eq("a square corner is not smooth", edgeIsSmooth(square, [0, 1], edgeLine), false);
const flat = [0, 0, 0, 10, 0, 0, 0, 10, 0, /* the other face, on in the same plane */ 0, 0, 0, 10, -10, 0, 10, 0, 0];
eq("faces that carry on flat across the edge are smooth", edgeIsSmooth(flat, [0, 1], edgeLine), true);
const tangent = [0, 0, 0, 10, 0, 0, 0, 10, 0, /* 2° off flat, as a fillet meets its face */ 0, 0, 0, 10, -10, -Math.tan((2 * Math.PI) / 180) * 10, 10, 0, 0];
eq("faces 2° off flat are smooth", edgeIsSmooth(tangent, [0, 1], edgeLine), true);
const bent = [0, 0, 0, 10, 0, 0, 0, 10, 0, /* 10° off flat */ 0, 0, 0, 10, -10, -Math.tan((10 * Math.PI) / 180) * 10, 10, 0, 0];
eq("faces 10° off flat are a corner", edgeIsSmooth(bent, [0, 1], edgeLine), false);
eq("one face alone is not judged smooth", edgeIsSmooth(square.slice(0, 9), [0], edgeLine), false);

eq("a typed 0 is refused", edgeSizeRefusal("fillet", 0), "A fillet needs a radius of at least 0.05 mm.");
eq("a typed negative chamfer is refused", edgeSizeRefusal("chamfer", -2), "A chamfer needs a distance of at least 0.05 mm.");
eq("a typed 2 is taken", edgeSizeRefusal("fillet", 2), null);

// C20. The blend ghost reads each edge point's two faces from the mesh: on a cube's top front edge, the top and the front.
{
  const q = (a: Vec3, b: Vec3, c: Vec3, d: Vec3) => [...a, ...b, ...c, ...a, ...c, ...d];
  const cube = [
    ...q([0, 0, 0], [0, 10, 0], [10, 10, 0], [10, 0, 0]),
    ...q([0, 0, 10], [10, 0, 10], [10, 10, 10], [0, 10, 10]),
    ...q([0, 0, 0], [10, 0, 0], [10, 0, 10], [0, 0, 10]),
    ...q([0, 10, 0], [0, 10, 10], [10, 10, 10], [10, 10, 0]),
    ...q([0, 0, 0], [0, 0, 10], [0, 10, 10], [0, 10, 0]),
    ...q([10, 0, 0], [10, 10, 0], [10, 10, 10], [10, 0, 10]),
  ];
  const faces = [0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5];
  const sides = edgeSides(cube, faces, [0, 0, 10, 5, 0, 10, 10, 0, 10]);
  const round = (v: readonly number[]) => v.map((n) => Math.round(n * 1e6) / 1e6 + 0);
  eq("three edge points, each with its two faces", sides.length, 3);
  eq("the faces are the top and the front, not the end face at a corner", sides.map((side) => [round(side.n1), round(side.n2)].sort().join(" ")), Array(3).fill("0,-1,0 0,0,1"));
  eq("a cube's edge is convex", sides.map((side) => side.convex), [true, true, true]);
  eq("into the top is +Y, into the front is −Z", round(sides[1]!.n1[2] === 1 ? sides[1]!.w1 : sides[1]!.w2), [0, 1, 0]);
}

if (failed > 0) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("edge drag: bisector, edges, clamp, and notes ok");
