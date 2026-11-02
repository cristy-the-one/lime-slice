/**
 * --- I8. A face selector says which face it picked, and a nearPoint over a pocket says so: the selector falls to the
 * floor below, and the face with material level with the point is named beside it.
 * A 40 mm square top at z = 10 with a 10 mm square pocket whose floor is at z = 7.
 */
import { GLOBAL_WORKPLANE } from "../workplane.ts";
import { expandContextFromSolid, pickSentence, type FrameFace } from "./frames.ts";

let failed = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
  if (ok) {
    console.log(`ok   ${name}`);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name} ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
}

const positions: number[] = [];
const triangles: number[] = [];
const quad = (face: number, x0: number, y0: number, x1: number, y1: number, z: number) => {
  positions.push(x0, y0, z, x1, y0, z, x1, y1, z, x0, y0, z, x1, y1, z, x0, y1, z);
  triangles.push(face, face);
};
// The top: four strips around the pocket.
quad(0, -20, -20, 20, -5, 10);
quad(0, -20, 5, 20, 20, 10);
quad(0, -20, -5, -5, 5, 10);
quad(0, 5, -5, 20, 5, 10);
// The pocket floor.
quad(1, -5, -5, 5, 5, 7);
const faces: FrameFace[] = [
  { index: 0, areaMm2: 1500, normal: [0, 0, 1], centre: [0, 0, 10] },
  { index: 1, areaMm2: 100, normal: [0, 0, 1], centre: [0, 0, 7] },
];
const ctx = expandContextFromSolid({ positions, triangles, faces }, GLOBAL_WORKPLANE, {
  matchFaces: (rows) => rows.map((row) => ({ index: row.index, areaMm2: row.areaMm2 })),
  stand: () => null,
  closeCracks: (p) => p,
});

const onTop = ctx.faceByDetail!({ normal: [0, 0, 1], nearPoint: [12, 0, 10] });
check("a point on the top picks the top", !("reason" in onTop) && onTop.index === 0 && onTop.distanceMm === 0 && onTop.level === undefined, onTop);
check("the pick names the face's normal, centre and area", !("reason" in onTop) && JSON.stringify(onTop.normal) === "[0,0,1]" && JSON.stringify(onTop.centre) === "[0,0,10]" && onTop.areaMm2 === 1500, onTop);
check("faceBy still answers the index", ctx.faceBy({ normal: [0, 0, 1], nearPoint: [12, 0, 10] }) === 0);

const overPocket = ctx.faceByDetail!({ normal: [0, 0, 1], nearPoint: [0, 0, 10] });
check("a point over the pocket falls to the floor", !("reason" in overPocket) && overPocket.index === 1 && overPocket.distanceMm === 3, overPocket);
check("and names the top, level with it, 5 mm away", !("reason" in overPocket) && overPocket.level?.index === 0 && overPocket.level.distanceMm === 5, overPocket);
const said = "reason" in overPocket ? "" : pickSentence(overPocket, [0, 0, 10]);
check("the sentence says the point is over empty space", said.includes("face 1") && said.includes("3 mm from nearPoint [0, 0, 10]") && said.includes("over empty space") && said.includes("face 0"), said);

const above = ctx.faceByDetail!({ normal: [0, 0, 1], nearPoint: [12, 0, 14] });
const aboveSaid = "reason" in above ? "" : pickSentence(above, [12, 0, 14]);
check("a point above every face is off it, with no level face", !("reason" in above) && above.index === 0 && above.level === null && aboveSaid.includes("on no matching face"), { above, aboveSaid });
check("without nearPoint the largest face is picked, and no distance", (() => {
  const pick = ctx.faceByDetail!({ normal: [0, 0, 1] });
  return !("reason" in pick) && pick.index === 0 && pick.distanceMm === undefined;
})());
check("a pick on the face reads as one plain sentence", pickSentence({ index: 0, normal: [0, 0, 1], centre: [0, 0, 10], areaMm2: 1500, distanceMm: 0 }) === "The face selector picked face 0 (normal [0, 0, 1], centre [0, 0, 10], 1500 mm²).");

if (failed > 0) {
  console.error(`face-pick: ${failed} failed`);
  process.exit(1);
}
console.log("face-pick: all passed");
