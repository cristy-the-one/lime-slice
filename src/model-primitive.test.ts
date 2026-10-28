import {
  PRIMITIVES,
  primitiveBounds,
  primitiveLabel,
  primitiveMesh,
  primitiveName,
  primitiveSpec,
  rootSpec,
  turnCentre,
  type PrimitiveFields,
  type PrimitiveSpec,
} from "./model-primitive.ts";
import { opLabel, rootLabel } from "./model-tree.ts";

let failed = 0;
function eq(name: string, got: unknown, want: unknown) {
  const left = JSON.stringify(got);
  const right = JSON.stringify(want);
  if (left === right) return;
  failed += 1;
  console.error(`FAIL ${name}\n  got  ${left}\n  want ${right}`);
}

type V = [number, number, number];
const spec = (primitive: PrimitiveSpec["primitive"], extra: Partial<PrimitiveSpec> = {}): PrimitiveSpec => ({
  primitive,
  origin: [0, 0, 0],
  size: [0, 0, 0],
  radius: 0,
  height: 0,
  turn: [0, 0, 0],
  ...extra,
});

/** The mesh's box, min then max, to a thousandth. */
function box(mesh: Float32Array): [V, V] {
  const min: V = [Infinity, Infinity, Infinity];
  const max: V = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < mesh.length; i += 1) {
    min[i % 3] = Math.min(min[i % 3]!, mesh[i]!);
    max[i % 3] = Math.max(max[i % 3]!, mesh[i]!);
  }
  const r = (v: V): V => v.map((value) => Math.round(value * 1000) / 1000 + 0) as V;
  return [r(min), r(max)];
}

/** Six times the signed volume the soup closes: positive when every triangle is wound outward. */
function volume(mesh: Float32Array): number {
  let six = 0;
  for (let i = 0; i < mesh.length; i += 9) {
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = mesh.subarray(i, i + 9);
    six += ax! * (by! * cz! - bz! * cy!) - ay! * (bx! * cz! - bz! * cx!) + az! * (bx! * cy! - by! * cx!);
  }
  return six / 6;
}

// Ghost meshes: each one's box against its literal sizes, in its own frame from origin 0.
const ghosts: [string, PrimitiveSpec, [V, V]][] = [
  ["box", spec("box", { size: [10, 20, 30] }), [[0, 0, 0], [10, 20, 30]]],
  ["cylinder", spec("cylinder", { radius: 5, height: 12 }), [[-5, -5, 0], [5, 5, 12]]],
  ["sphere", spec("sphere", { radius: 4 }), [[-4, -4, -4], [4, 4, 4]]],
  ["cone", spec("cone", { radius: 6, topRadius: 2, height: 9 }), [[-6, -6, 0], [6, 6, 9]]],
  ["upside-down cone", spec("cone", { radius: 0, topRadius: 3, height: 4 }), [[-3, -3, 0], [3, 3, 4]]],
  ["torus", spec("torus", { radius: 10, tubeRadius: 2 }), [[-12, -12, -2], [12, 12, 2]]],
  ["wedge", spec("wedge", { size: [20, 10, 8], topX: 5 }), [[0, 0, 0], [20, 10, 8]]],
  ["hexagon across flats", spec("polygon", { sides: 6, across: 10, flats: true, height: 5 }), [[-5.774, -5, 0], [5.774, 5, 5]]],
  ["hexagon across corners", spec("polygon", { sides: 6, across: 10, flats: false, height: 5 }), [[-5, -4.33, 0], [5, 4.33, 5]]],
  ["triangle", spec("polygon", { sides: 3, across: 10, flats: false, height: 2 }), [[-4.33, -2.5, 0], [4.33, 5, 2]]],
  ["tube", spec("tube", { radius: 10, innerRadius: 6, height: 5 }), [[-10, -10, 0], [10, 10, 5]]],
];
for (const [name, primitive, want] of ghosts) {
  const mesh = primitiveMesh(primitive);
  eq(`the ${name} ghost fills its sizes`, box(mesh), want);
  eq(`the ${name} ghost's box is the one worked out from the sizes`, box(primitiveMesh(primitive)), (() => {
    const b = primitiveBounds(primitive);
    const r = (v: V): V => v.map((value) => Math.round(value * 1000) / 1000 + 0) as V;
    return [r(b.min), r(b.max)];
  })());
  if (!(volume(mesh) > 0)) {
    failed += 1;
    console.error(`FAIL the ${name} ghost is wound outward: ${volume(mesh)}`);
  }
}
eq("a wedge's top runs from X 0 to its top length", Math.max(...[...primitiveMesh(spec("wedge", { size: [20, 10, 8], topX: 5 }))].filter((_, i, all) => i % 3 === 0 && all[i + 2] === 8)), 5);
eq("a box ghost is closed: its soup holds the box's volume", Math.round(volume(primitiveMesh(spec("box", { size: [10, 20, 30] })))), 6000);
const roundedBox = primitiveMesh(spec("box", { size: [20, 12, 5], cornerRadius: 3 }));
eq("a rounded box ghost keeps its box", box(roundedBox), [[0, 0, 0], [20, 12, 5]]);
eq("a rounded box ghost is the box less the corners, 32-sided: 1160 mm3, not 1200", Math.round(volume(roundedBox)), 1160);
eq("a corner radius past half the short side is held to it", box(primitiveMesh(spec("box", { size: [20, 12, 5], cornerRadius: 50 }))), [[0, 0, 0], [20, 12, 5]]);
eq("a ramp's soup holds a half box", Math.round(volume(primitiveMesh(spec("wedge", { size: [20, 10, 8], topX: 0 })))), 800);
eq("a tube's soup holds its wall, a 32-sided one", Math.round(volume(primitiveMesh(spec("tube", { radius: 10, innerRadius: 6, height: 5 })))), 999);
for (const [name, bad] of [
  ["a box with no depth", spec("box", { size: [10, 0, 10] })],
  ["a torus whose tube fills its ring", spec("torus", { radius: 2, tubeRadius: 2 })],
  ["a polygon of two sides", spec("polygon", { sides: 2, across: 10, height: 5 })],
  ["a tube with no wall", spec("tube", { radius: 5, innerRadius: 5, height: 5 })],
  ["a wedge whose top is longer than its base", spec("wedge", { size: [10, 10, 10], topX: 11 })],
] as const) {
  eq(`${name} draws no ghost`, primitiveMesh(bad).length, 0);
}

// The panel's numbers become the kind's own spec.
const fields: PrimitiveFields = { size: [1, 2, 3], radius: 4, height: 5, topRadius: 6, tubeRadius: 7, innerRadius: 8, topX: 9, sides: 10, across: 11, flats: true };
eq("a cone takes its top radius and nothing else new", primitiveSpec("cone", fields, [1, 1, 1], [0, 0, 30]), { primitive: "cone", origin: [1, 1, 1], size: [1, 2, 3], radius: 4, height: 5, turn: [0, 0, 30], topRadius: 6 });
eq("a polygon takes its sides, width, and flats", primitiveSpec("polygon", fields, [0, 0, 0], [0, 0, 0]), { primitive: "polygon", origin: [0, 0, 0], size: [1, 2, 3], radius: 4, height: 5, turn: [0, 0, 0], sides: 10, across: 11, flats: true });
eq("a sphere does not turn", primitiveSpec("sphere", fields, [0, 0, 0], [10, 20, 30]).turn, [0, 0, 0]);
eq("a box stores exactly as it did before the new kinds", Object.keys(primitiveSpec("box", fields, [0, 0, 0], [0, 0, 0])), ["primitive", "origin", "size", "radius", "height", "turn"]);

// A new solid's root stands centred over the origin on Z 0, untilted.
const rooted = (primitive: PrimitiveSpec) => primitiveBounds(rootSpec(primitive));
eq("a root box stands centred on Z 0", rooted(spec("box", { size: [20, 10, 4], origin: [7, 7, 7], turn: [0, 0, 45] })), { min: [-10, -5, 0], max: [10, 5, 4] });
eq("a root sphere sits on Z 0", rooted(spec("sphere", { radius: 3 })), { min: [-3, -3, 0], max: [3, 3, 6] });
eq("a root torus lies on Z 0", rooted(spec("torus", { radius: 10, tubeRadius: 2 })), { min: [-12, -12, 0], max: [12, 12, 4] });
eq("a root cone stands on its base", rooted(spec("cone", { radius: 5, topRadius: 1, height: 8, origin: [3, 3, 3] })), { min: [-5, -5, 0], max: [5, 5, 8] });
eq("a root keeps only the fields its kind reads", rootSpec(spec("cone", { size: [10, 10, 10], radius: 5, height: 8, topRadius: 1 })), spec("cone", { radius: 5, height: 8, topRadius: 1 }));
eq("a root box keeps its size and nothing round", rootSpec(spec("box", { size: [2, 4, 6], radius: 5, height: 10 })), spec("box", { origin: [-1, -2, 0], size: [2, 4, 6] }));
eq("a root is untilted", rootSpec(spec("cylinder", { radius: 1, height: 1, turn: [90, 0, 0] })).turn, [0, 0, 0]);

eq("turn centres", [spec("box", { size: [2, 4, 6] }), spec("wedge", { size: [2, 4, 6] }), spec("torus", { radius: 5 }), spec("tube", { height: 8 })].map(turnCentre), [[1, 2, 3], [1, 2, 3], [0, 0, 0], [0, 0, 4]]);

// Labels.
const labels: [PrimitiveSpec, string][] = [
  [spec("box", { size: [10, 10, 10] }), "box 10×10×10"],
  [spec("cylinder", { radius: 2.5, height: 8 }), "cylinder ⌀5 h 8"],
  [spec("sphere", { radius: 4 }), "sphere ⌀8"],
  [spec("cone", { radius: 5, topRadius: 0, height: 10 }), "cone ⌀10 to ⌀0 h 10"],
  [spec("torus", { radius: 10, tubeRadius: 1.5 }), "torus ⌀20 tube ⌀3"],
  [spec("wedge", { size: [20, 10, 8], topX: 0 }), "wedge 20×10×8 top 0"],
  [spec("polygon", { sides: 6, across: 5.5, flats: true, height: 2.4 }), "hexagon 5.5 across flats h 2.4"],
  [spec("polygon", { sides: 12, across: 30, flats: false, height: 3 }), "12-gon 30 across corners h 3"],
  [spec("tube", { radius: 10, innerRadius: 6, height: 5 }), "tube ⌀20 inside ⌀12 h 5"],
];
for (const [primitive, want] of labels) eq(`label of ${want}`, primitiveLabel(primitive), want);
eq("a boolean with a new primitive names it", opLabel({ kind: "boolean", op: "cut", ...spec("polygon", { sides: 6, across: 5.5, flats: true, height: 2.4 }) }), "Cut hexagon 5.5 across flats h 2.4");
eq("a boolean box reads as before", opLabel({ kind: "boolean", op: "cut", ...spec("box", { size: [10, 10, 10] }) }), "Cut box 10×10×10");
eq("a primitive root reads as its primitive", rootLabel({ kind: "primitive", solid: spec("cone", { radius: 5, topRadius: 2, height: 10 }) }, "Cone 1"), "Cone ⌀10 to ⌀4 h 10");
eq("a STEP root reads as its file", rootLabel({ kind: "step", name: "a.step", bytes: new ArrayBuffer(0) }, "bracket.step"), "bracket.step");

// Names: the first number no object of that kind has.
eq("the first box is Box 1", primitiveName([], "box"), "Box 1");
eq("the next box is Box 2", primitiveName(["Box 1", "Cone 1", "bracket.step"], "box"), "Box 2");
eq("a gap is filled first", primitiveName(["Cone 1", "Cone 3"], "cone"), "Cone 2");
eq("each kind counts its own", primitiveName(["Box 1", "Box 2"], "torus"), "Torus 1");
eq("every kind has a name", PRIMITIVES.map((entry) => primitiveName([], entry.kind)), ["Box 1", "Cylinder 1", "Sphere 1", "Ellipsoid 1", "Cone 1", "Torus 1", "Wedge 1", "Polygon 1", "Tube 1"]);

if (failed) {
  console.error(`model-primitive: ${failed} failed`);
  throw new Error(`model-primitive: ${failed} failed`);
}
console.log("model-primitive: ghosts, specs, roots, labels, and names ok");
