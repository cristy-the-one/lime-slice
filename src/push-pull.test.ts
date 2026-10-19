import { faceTable } from "./interact/face-table.ts";
import { facePrism } from "./interact/ghosts.ts";
import { outwardFromMesh } from "./model-blend.ts";
import {
  depthBehind,
  pullLimit,
  pullRefusal,
  curvedNormal,
  cylinderDiameter,
  distanceForDiameter,
  faceTriangles,
  pullDone,
  pullDrag,
  pullFields,
  pullGhost,
  pullHint,
  pullLevels,
  pullOp,
  tabEditOpen,
  type PullFace,
} from "./push-pull.ts";

let failed = 0;
function eq(name: string, got: unknown, want: unknown) {
  const left = JSON.stringify(got);
  const right = JSON.stringify(want);
  if (left === right) return;
  failed += 1;
  console.error(`FAIL ${name}\n  got  ${left}\n  want ${right}`);
}
function check(name: string, ok: boolean, detail = "") {
  if (ok) return;
  failed += 1;
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}

const top: PullFace = { index: 1, normal: [0, 0, 1], at: [10, 10, 20], areaMm2: 400 };
const side: PullFace = { index: 5, normal: [1, 0, 0], at: [20, 10, 10], areaMm2: 400 };
const front: PullFace = { index: 2, normal: [0, -1, 0], at: [10, 0, 10] };

eq("no drag is no step", pullOp([top], 0, false), null);
eq("a pull moves the face", pullOp([top], 10, false), { kind: "moveFaces", faces: [{ face: 1, distance: 10 }] });
eq("Alt on one face adds a prism", pullOp([side], 8, true), { kind: "faceExtrude", face: 5, distance: 8 });
eq("Alt on several faces still moves each one", pullOp([top, side], 4, true), {
  kind: "moveFaces",
  faces: [
    { face: 1, distance: 4 },
    { face: 5, distance: 4 },
  ],
});
eq("a push is a negative distance", pullOp([top], -3, false)?.kind === "moveFaces" && (pullOp([top], -3, false) as { faces: { distance: number }[] }).faces[0]!.distance, -3);

eq("the hint names the last distance", pullHint(5), "Drag to push or pull · Alt: add or cut on this face only · double-click: repeat 5 mm");
eq("the hint before any pull offers no repeat", pullHint(null), "Drag to push or pull · Alt: add or cut on this face only");
eq("the readout after a pull", pullDone(10), "Pulled 10 mm · Tab to edit");
eq("the readout keeps the new volume", pullDone(10, 12000), "Pulled 10 mm · Tab to edit · Volume 12000 mm³");
eq("the readout after a push", pullDone(-3), "Pushed 3 mm · Tab to edit");
check("Tab edits for three seconds", tabEditOpen(1000, 4000) && !tabEditOpen(1000, 4001) && !tabEditOpen(1000, 999));

const bottom: PullFace = { index: 0, normal: [0, 0, -1], at: [10, 10, 0] };
const ledge: PullFace = { index: 7, normal: [0, 0, 1], at: [30, 10, 26] };
const levels = pullLevels([top, side, front, bottom, ledge], top.at, top.normal, new Set([top.index]));
eq("faces parallel to the drag offer their plane's height", levels.map((level) => [level.id, level.distance]), [
  [0, -20],
  [7, 6],
]);
eq("a side wall's middle is no level", levels.some((level) => level.id === side.index || level.id === front.index), false);
eq("the face being dragged is not a snap", levels.some((level) => level.id === top.index), false);

const ray = { origin: [10, -40, 25] as [number, number, number], direction: [0, 1, 0] as [number, number, number] };
const dragged = pullDrag(ray, [10, 10, 20], [0, 0, 1], { faces: levels, mmPerPx: 0.01 });
check("a ray above the face pulls it out", dragged != null && dragged.distance > 0, JSON.stringify(dragged));

const positions = [0, 0, 20, 20, 0, 20, 20, 20, 20, 0, 0, 20, 20, 20, 20, 0, 20, 20];
const triangles = [1, 1];
eq("the face's triangles are that face only", [...faceTriangles(positions, triangles, 1)], [...positions]);
eq("another face is empty", faceTriangles(positions, triangles, 0).length, 0);
eq("the centre is the mean of the corners", faceTable(positions, triangles).get(1)?.centre, [10, 10, 20]);
eq("the table's normal is the one read face by face", faceTable(positions, triangles).get(1)?.normal, outwardFromMesh(positions, triangles, 1));
check("the same mesh answers the same table, read once", faceTable(positions, triangles) === faceTable(positions, triangles));
eq("another face is not in the table", faceTable(positions, triangles).has(0), false);
const ghost = pullGhost(positions, triangles, [top], 10);
check("a pull draws a prism", ghost.length >= 9 && ghost.some((value, i) => i % 3 === 2 && value > 20));
eq("a zero pull draws nothing", pullGhost(positions, triangles, [top], 0).length, 0);
check("the ghost matches one face prism", ghost.length === facePrism(positions, [0, 0, 1], 10).length);

const boss: PullFace = { ...side, surface: "cylinder", radiusMm: 10, axisPoint: [0, 0, 10], axis: [0, 0, 1], at: [10, 0, 10], normal: [1, 0, 0] };
const hole: PullFace = { ...boss, normal: [-1, 0, 0], at: [10, 0, 10] };
eq("a boss grows", cylinderDiameter(boss, 2), 24);
eq("a hole shrinks when the wall moves out of the material", cylinderDiameter(hole, 2), 16);
eq("a flat face has no diameter", cylinderDiameter(top, 5), null);
eq("the hud shows the diameter of one cylinder", pullFields(2, [boss]).map((field) => [field.id, field.value]), [
  ["distance", 2],
  ["diameter", 24],
]);
eq("several faces show the distance alone", pullFields(2, [boss, { ...boss, index: 3 }]).map((field) => field.id), ["distance"]);
eq("a typed diameter is the distance that reaches it", distanceForDiameter([boss], 24), 2);
eq("a hole's diameter types the other way", distanceForDiameter([hole], 16), 2);

// A cylinder r10 on the Z axis. The mean of its triangle normals is nothing; the normal is read where the pointer is.
const cylinder = { surface: "cylinder" as const, axisPoint: [0, 0, 0] as [number, number, number], axis: [0, 0, 1] as [number, number, number] };
eq("on a boss the normal points away from the axis", curvedNormal(cylinder, [0, 10, 7], [0, 1, 0]), [0, 1, 0]);
eq("on a hole wall the mesh faces the axis, and so does the normal", curvedNormal(cylinder, [0, 10, 7], [0, -0.9, 0.1]), [-0, -1, -0]);
eq("a point on the axis has no radial normal", curvedNormal(cylinder, [0, 0, 7], [0, 1, 0]), null);
eq("a sphere's normal points away from its centre", curvedNormal({ surface: "sphere", axisPoint: [1, 1, 1] }, [1, 1, 6], null), [0, 0, 1]);
eq("a planar face is not curved", curvedNormal({}, [0, 0, 0], [0, 0, 1]), null);
const r10 = { ...boss, axisPoint: [0, 0, 0] as [number, number, number], at: [10, 0, 7] as [number, number, number] };
eq("the r10 boss pushed 4.7 mm reads 10.6 mm across, as the kernel builds it", pullFields(-4.7, [r10]).map((field) => [field.id, Math.round(field.value * 10) / 10]), [
  ["distance", -4.7],
  ["diameter", 10.6],
]);
// One wall triangle at radius 10, from x = 10 to y = 10. A push of 2 mm moves every corner to radius 8.
const wall = [10, 0, 0, 0, 10, 0, 0, 10, 5];
const shifted = pullGhost(wall, [7], [{ ...r10, index: 7 }], -2);
const radii = [0, 3, 6].map((i) => Math.round(Math.hypot(shifted[i]!, shifted[i + 1]!) * 1000) / 1000);
eq("a cylinder's ghost moves along its radius, not along one normal", radii, [8, 8, 8]);
eq("its heights stay", [shifted[2], shifted[5], shifted[8]], [0, 0, 5]);

// A distance bound, and a push through the part, are refused before the kernel is asked.
eq("the bound is ten bed or part diagonals", pullLimit(30, 300), 3000);
eq("a huge pull is refused", pullRefusal("move", 1e6, [20], 3000), "1000000 mm is farther than any printer reaches. A push or pull goes up to 3000 mm here.");
eq("an ordinary pull is not", pullRefusal("move", 10, [20], 3000), null);
eq("a push as deep as the part goes through it", pullRefusal("move", -20, [20], 3000), "That push goes through the part: it is 20 mm deep there. Push less, or hold Alt to cut through.");
eq("a shallower push is kept", pullRefusal("move", -19.5, [20], 3000), null);
eq("a prism may cut through", pullRefusal("extrude", -25, [20], 3000), null);
eq("a curved face's depth is not known", pullRefusal("move", -25, [null], 3000), null);
const cube = [0, 0, 0, 20, 0, 0, 20, 20, 0, 0, 0, 20, 20, 20, 20, 0, 20, 20];
eq("the depth behind the top is the part's height", depthBehind(cube, [10, 10, 20], [0, 0, 1]), 20);
eq("the depth behind a side is its width", depthBehind(cube, [20, 10, 10], [1, 0, 0]), 20);

if (failed) {
  console.error(`${failed} failed`);
  throw new Error(`${failed} failed`);
}
console.log("push-pull: op, snap, ghost, diameter ok");
