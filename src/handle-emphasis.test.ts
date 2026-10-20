/**
 * A handle lights the edges that belong to its number, not the whole solid.
 */
import * as THREE from "three";
import { aspectFor, aspectTip, capOutline, meshPoint } from "./handle-emphasis.ts";
import { handlesFor, type DragContext, type DragHandle, type Vec3 } from "./model-drag.ts";
import { primitiveSpec, turnCentre, type PrimitiveFields, type PrimitiveKind } from "./model-primitive.ts";

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
function near(a: number, b: number, tol = 1e-4) {
  return Math.abs(a - b) < tol;
}

const numbers: PrimitiveFields = {
  size: [20, 10, 8], radius: 5, height: 12, topRadius: 2, tubeRadius: 1.5, innerRadius: 3, topX: 6, sides: 6, across: 10, flats: false,
};

function spec(kind: PrimitiveKind, turn: Vec3 = [0, 0, 0], origin: Vec3 = [0, 0, 0], over: Partial<PrimitiveFields> = {}) {
  return primitiveSpec(kind, { ...numbers, ...over }, origin, turn);
}

function context(kind: PrimitiveKind): DragContext {
  const read: Record<string, number> = {
    modelDx: 20, modelDy: 10, modelDz: 8, modelRadius: 5, modelHeight: 12, modelTopR: 2, modelTube: 1.5, modelInnerR: 3,
    modelTopX: 6, modelSides: 6, modelAcross: 10, modelBlend: 1.5, modelHoleR: 2, modelHoleD: 8, modelBoreR: 3, modelBoreD: 2,
    modelThin: 0.8, modelFactor: 2, modelPull: 4, modelPatCount: 3,
  };
  return {
    read: (field) => read[field] ?? 0,
    primitive: kind,
    center: [10, 5, 4],
    extent: 20,
    split: null,
    edge: { point: [10, 0, 8], out: [0, -1, 0] },
    pull: { at: [10, 5, 8], dir: [0, 0, 1] },
    hole: { through: false, counterbore: true },
  };
}

function segments(lines: number[]): [Vec3, Vec3][] {
  const out: [Vec3, Vec3][] = [];
  for (let i = 0; i + 5 < lines.length; i += 6) out.push([[lines[i]!, lines[i + 1]!, lines[i + 2]!], [lines[i + 3]!, lines[i + 4]!, lines[i + 5]!]]);
  return out;
}
function direction(edge: [Vec3, Vec3]): Vec3 {
  return [edge[1][0] - edge[0][0], edge[1][1] - edge[0][1], edge[1][2] - edge[0][2]];
}
function along(edge: [Vec3, Vec3], axis: 0 | 1 | 2): boolean {
  const d = direction(edge);
  const length = Math.hypot(d[0], d[1], d[2]);
  return length > 0.5 && Math.abs(d[axis]) / length > 0.98;
}

const box = spec("box");
const boxHandles = handlesFor("create", context("box"));
const sizeX = boxHandles.find((handle) => handle.id === "size-0")!;
const sizeY = boxHandles.find((handle) => handle.id === "size-1")!;
const sizeZ = boxHandles.find((handle) => handle.id === "size-2")!;

eq("width is named with its axis and its number", aspectTip(sizeX, sizeX.values), "Width (X) 20 mm");
eq("depth is named with its axis", aspectTip(sizeY, sizeY.values), "Depth (Y) 10 mm");
eq("height is named with its axis", aspectTip(sizeZ, sizeZ.values), "Height (Z) 8 mm");

const width = aspectFor(sizeX, { spec: box });
check("width is mapped", width.mapped && width.dim);
eq("width keeps the field", width.fields, ["modelDx"]);
eq("width uses the X colour", width.color, "x");
check("width has the four edges parallel to X", segments(width.lines).filter((edge) => along(edge, 0) && near(Math.abs(direction(edge)[0]), 20, 0.1)).length >= 4);
check("width does not thicken an edge parallel to Y", segments(width.lines).filter((edge) => along(edge, 1) && Math.abs(direction(edge)[1]) > 5).length === 0);
check("the dimension carries the same sentence", width.dimension?.text === "Width (X) 20 mm");
function meets(lines: number[], point: Vec3) {
  return segments(lines).filter((edge) => edge.some((end) => near(end[0], point[0], 1e-3) && near(end[1], point[1], 1e-3) && near(end[2], point[2], 1e-3))).length;
}
check("the dimension has arrowheads at both ends", width.dimension != null && meets(width.lines, width.dimension.from) >= 3 && meets(width.lines, width.dimension.to) >= 3);
const flipped = aspectFor(sizeX, { spec: box, gapSign: -1 });
check("the far side mirrors the dimension", width.dimension != null && flipped.dimension != null && near(flipped.dimension.from[1], -width.dimension.from[1]) && near(flipped.dimension.from[0], width.dimension.from[0]));

const depth = aspectFor(sizeY, { spec: box });
check("depth has the four edges parallel to Y", segments(depth.lines).filter((edge) => along(edge, 1) && near(Math.abs(direction(edge)[1]), 10, 0.1)).length >= 4);

const height = aspectFor(sizeZ, { spec: box });
check("height has the four edges parallel to Z", segments(height.lines).filter((edge) => along(edge, 2) && near(Math.abs(direction(edge)[2]), 8, 0.1)).length >= 4);

const wedge = spec("wedge");
const top = aspectFor(handlesFor("create", context("wedge")).find((handle) => handle.id === "top-x")!, { spec: wedge });
check("a wedge's top is the two top edges", top.mapped);
check("those top edges run along X", segments(top.lines).filter((edge) => along(edge, 0)).every((edge) => near(edge[0][2], 8) && near(edge[1][2], 8)));

const cylinder = spec("cylinder");
const radius = aspectFor(handlesFor("create", context("cylinder")).find((handle) => handle.id === "radius")!, { spec: cylinder });
check("a radius draws a rim", radius.mapped && radius.lines.length > 40);
check("the radius line is 5 mm", segments(radius.lines).some((edge) => along(edge, 0) && near(Math.abs(direction(edge)[0]), 5, 0.05)));
const cylHeight = aspectFor(handlesFor("create", context("cylinder")).find((handle) => handle.id === "height")!, { spec: cylinder });
check("a cylinder's height draws the side edges", segments(cylHeight.lines).filter((edge) => along(edge, 2) && near(Math.abs(direction(edge)[2]), 12, 0.1)).length >= 4);

const cone = spec("cone");
const topR = aspectFor(handlesFor("create", context("cone")).find((handle) => handle.id === "top-radius")!, { spec: cone });
check("a cone's top radius sits at the top", topR.mapped && segments(topR.lines).some((edge) => near(edge[0][2], 12) && near(edge[1][2], 12)));

const sphere = aspectFor(handlesFor("create", context("sphere")).find((handle) => handle.id === "radius")!, { spec: spec("sphere") });
check("a sphere draws a great circle and a radius", sphere.mapped && sphere.lines.length > 20);

const torus = spec("torus");
const ring = aspectFor(handlesFor("create", context("torus")).find((handle) => handle.id === "radius")!, { spec: torus });
const tube = aspectFor(handlesFor("create", context("torus")).find((handle) => handle.id === "tube-radius")!, { spec: torus });
const maxReach = (lines: number[]) => {
  let best = 0;
  for (let i = 0; i + 2 < lines.length; i += 3) best = Math.max(best, Math.hypot(lines[i]!, lines[i + 1]!, lines[i + 2]!));
  return best;
};
check("a torus ring stays on the ring radius", ring.mapped && maxReach(ring.lines) < 6);
check("a torus tube reaches outside the ring", tube.mapped && maxReach(tube.lines) > 6);

const polygon = spec("polygon");
const sides = aspectFor(handlesFor("create", context("polygon")).find((handle) => handle.id === "sides")!, { spec: polygon });
check("a side count draws the outline", sides.mapped && sides.tip === "Sides 6");
check("six sides means at least six bottom edges", segments(sides.lines).filter((edge) => near(edge[0][2], 0) && near(edge[1][2], 0) && Math.hypot(...direction(edge)) > 0.5).length >= 6);

const holeHandle = handlesFor("hole", context("box")).find((handle) => handle.id === "hole-radius")!;
const hole = aspectFor(holeHandle, { hole: { x: 4, y: 5, z: 10, radius: 2, depth: 8, dir: [0, 0, -1], bore: { radius: 3, depth: 2 } } });
eq("a hole knob reads as the diameter", hole.tip, "Diameter 4 mm");
check("the diameter is a circle at the hole", hole.mapped && hole.space === "world");
const depthHole = aspectFor(handlesFor("hole", context("box")).find((handle) => handle.id === "hole-depth")!, { hole: { x: 4, y: 5, z: 10, radius: 2, depth: 8, dir: [0, 0, -1] } });
check("depth runs 8 mm into the part", depthHole.mapped && depthHole.dimension != null && near(Math.hypot(...direction([depthHole.dimension.from, depthHole.dimension.to])), 8, 0.2));

const blend = handlesFor("fillet", context("box"))[0]!;
const edged = aspectFor(blend, { edgePoints: [0, 0, 8, 20, 0, 8] });
check("a fillet thickens the picked edge", edged.mapped && segments(edged.lines).some((edge) => near(edge[0][0], 0) && near(edge[1][0], 20)));
eq("the fillet sentence names the radius", edged.tip, "Fillet 1.5 mm");

const pull = handlesFor("pushpull", context("box"))[0]!;
const soup = new Float32Array([
  0, 0, 10, 20, 0, 10, 20, 10, 10,
  0, 0, 10, 20, 10, 10, 0, 10, 10,
]);
const pulled = aspectFor(pull, { soup, values: [4] });
check("a pull outlines the moved face", pulled.mapped && pulled.lines.length >= 6);
const cap = capOutline(soup, [0, 0, 1], 10, 0.5);
eq("the cap outline is the four edges of that face", cap.length, 24);

const revolve: DragHandle = {
  id: "revolve", kind: "ring", look: "ring", fields: ["angle"], seat: { at: "feature", origin: [1, 2, 3] },
  dir: [0, 0, 1], rate: 1, step: 15, color: "accent", label: "Angle", unit: "°", values: [90],
};
const arc = aspectFor(revolve, { extent: 20 });
check("a revolve draws the arc", arc.mapped && arc.tip === "Angle 90°");

const thin = handlesFor("check", context("box"))[0]!;
const unmapped = aspectFor(thin, {});
check("a thin-wall threshold has no edge", !unmapped.mapped && unmapped.lines.length === 0 && unmapped.tip.startsWith("Thin wall"));

const turned = spec("box", [0, 0, 90], [1, 2, 3]);
const centre = turnCentre(turned);
const quaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, 90 * Math.PI / 180, "ZYX"));
const spun = new THREE.Vector3(-centre[0], -centre[1], -centre[2]).applyQuaternion(quaternion);
const want: Vec3 = [spun.x + 1 + centre[0], spun.y + 2 + centre[1], spun.z + 3 + centre[2]];
const got = meshPoint(turned, [0, 0, 0]);
check("a turned box corner matches the view", near(got[0], want[0]) && near(got[1], want[1]) && near(got[2], want[2]));

if (failed > 0) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("handle-emphasis: ok");
