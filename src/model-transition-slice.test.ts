/**
 * --- Print transitions, step 6b (docs/plan-belt-transitions.md, decision 7): Find's rows checked against the last slice.
 * A patch of part beads on nothing, as the engine reports it, goes back to the solid's frame through the plate pose and
 * marks the Find rows whose edges it was born at; patches at other edges are rows of their own, and patches at no edge
 * are counted. The poses and points are the ones the engine gave for a 20 mm lip coupon (`partHold`), on a flat bed and
 * on the IR3 V2's belt, at two places and two turns.
 */
import { placeMesh } from "./mesh-place.ts";
import {
  SLICE_CHECK_NONE,
  checkAgainstSlice,
  crossCheck,
  plateToSolid,
  positionsBox,
  readHoldPatches,
  seenText,
  sliceCheckSummary,
  sliceOnlyText,
  type Finding,
  type FoundRow,
  type SlicedPose,
} from "./model-transition.ts";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) return;
  failed += 1;
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}
const close = (a: readonly number[], b: readonly number[], tol = 1e-6) => a.length === b.length && a.every((value, i) => Math.abs(value - b[i]!) <= tol);

/** A post Y 0..10, Z 0..30, with a lip Y 10..20 at Z 20..30, 20 mm along X. */
function lipCoupon(): Float32Array {
  const boxes = [[[0, 0, 0], [20, 10, 30]], [[0, 10, 20], [20, 20, 30]]] as const;
  const out: number[] = [];
  for (const [lo, hi] of boxes) {
    const c = (i: number) => [i & 1 ? hi[0] : lo[0], i & 2 ? hi[1] : lo[1], i & 4 ? hi[2] : lo[2]];
    for (const f of [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]]) for (const t of [[0, 1, 2], [0, 2, 3]]) for (const k of t) out.push(...c(f[k]!));
  }
  return new Float32Array(out);
}

/** Edges along X at (Y, Z): the lip's first edge, its root, its top front edge, the post's top back edge. */
const line = (edge: number, y: number, z: number) => ({ edge, points: [0, y, z, 20, y, z] });
const EDGES = [line(1, 20, 20), line(2, 10, 20), line(3, 20, 30), line(5, 0, 30)];
const BOX = { min: [0, 0, 0], max: [20, 20, 30] };

function row(edge: number, kind: FoundRow["case"] = "lip"): FoundRow {
  return { edge, case: kind, lengthMm: 20, mid: [10, 0, 0], farDeg: 0, nearDeg: 90, curved: false, wedge: null, refused: null };
}
const FINDING: Finding = { rows: [row(1), row(2, "corner")], curvedSkipped: 0, curvedEdges: [], fix: { mode: "auto", angleDeg: 45, size: 2 } };

{
  // The reader: the engine's patches, with their first-layer points; a malformed one is left out.
  const read = readHoldPatches({ largest: [{ mm: 10, longestSpanMm: 2, layers: [3, 4], at: [1, 2, 3], first: [[1, 2, 3], [4, 5, "x"]] }, { mm: 5, layers: [1], at: [0, 0, 0] }] });
  check("patches read", read.length === 1 && read[0]!.first.length === 1 && close(read[0]!.at, [1, 2, 3]) && read[0]!.layers[1] === 4, JSON.stringify(read));
  check("no partHold, no patches", readHoldPatches(undefined).length === 0 && readHoldPatches({}).length === 0);
  // A placement and its inverse: a point of the solid placed on the plate comes back.
  const placed = placeMesh(lipCoupon(), [0, -1, 0, 1, 0, 0, 0, 0, 1], 2, 220, 220, false, { x: 40, y: 60, z: 0 });
  const toSolid = plateToSolid(placed.pose, 2, 0);
  const p = placed.positions;
  const source = lipCoupon();
  check("the plate pose undone, turned and scaled", close(toSolid([p[0]!, p[1]!, p[2]!]), [source[0]!, source[1]!, source[2]!], 1e-3), JSON.stringify(toSolid([p[0]!, p[1]!, p[2]!])));
  check("a mesh seat lifts it to the solid's frame", close(plateToSolid(placed.pose, 2, 1.5)([p[0]!, p[1]!, p[2]!]), [source[0]!, source[1]!, source[2]! + 1.5], 1e-3));
}

{
  // The flat bed, as sliced (lime-220, turned 90° about Z, scale 2, placed at 40, 60): the lip's underside, born at once
  // on layer 201, marks both its first edge and its root; the top skin over infill hangs at no edge.
  const placed = placeMesh(lipCoupon(), [0, -1, 0, 1, 0, 0, 0, 0, 1], 2, 220, 220, false, { x: 40, y: 60, z: 0 });
  const toSolid = plateToSolid(placed.pose, 2, 0);
  const plate = (s: readonly number[]) => {
    // The solid point placed on the plate: R·2·(p − pivot) + t.
    const m = placed.pose.rotation;
    const d = [0, 1, 2].map((k) => 2 * (s[k]! - placed.pose.pivot[k]!));
    return [0, 1, 2].map((r) => m[3 * r]! * d[0]! + m[3 * r + 1]! * d[1]! + m[3 * r + 2]! * d[2]! + placed.pose.translation[r]!) as [number, number, number];
  };
  const under = [2, 6, 10, 14, 18].flatMap((x) => [plate([x, 11, 20.1]), plate([x, 19, 20.1])]);
  const skin = [5, 10, 15].map((x) => plate([x, 8, 28.4]));
  const patches = [
    { mm: 1798.4, longestSpanMm: 39.5, layers: [200, 200] as [number, number], at: under[0]!, first: under },
    { mm: 14.2, longestSpanMm: 4.1, layers: [290, 291] as [number, number], at: skin[0]!, first: skin },
    { mm: 7, longestSpanMm: 2, layers: [10, 10] as [number, number], at: [500, 500, 1] as [number, number, number], first: [] },
  ];
  const checked = crossCheck(FINDING, patches, toSolid, EDGES, BOX, [0, 0, 1]);
  check("the lip's first edge is seen in the slice", checked.rows[0]!.seen?.unheldMm === 1798.4 && checked.rows[0]!.seen?.longestSpanMm === 39.5, JSON.stringify(checked.rows[0]));
  check("its root too, born on the same layer", checked.rows[1]!.seen?.patches === 1 && checked.rows[1]!.seen?.layers[0] === 200);
  check("skin a layer under the top edge was not born there", checked.slice?.only.length === 0 && checked.slice?.faces === 1, JSON.stringify(checked.slice));
  check("another object's patch is left out", checked.slice?.patches === 2);
  check("the summary", sliceCheckSummary(checked) === "2 edges hang in the last slice too. 1 patch hangs away from every edge, inside a face.", sliceCheckSummary(checked) ?? "");
  check("the mark in words", seenText(checked.rows[0]!.seen!) === "Seen in the slice: 1,798.4 mm unheld, spans 39.5 mm, layer 201." || seenText(checked.rows[0]!.seen!) === "Seen in the slice: 1798.4 mm unheld, spans 39.5 mm, layer 201.", seenText(checked.rows[0]!.seen!));
  check("a check again replaces the old marks", crossCheck(checked, [], toSolid, EDGES, BOX, [0, 0, 1]).rows.every((r) => !r.seen));
  check("before a check there is no summary", sliceCheckSummary(FINDING) === null && SLICE_CHECK_NONE.startsWith("Slice this pose"));
}

{
  // The IR3 V2's belt, as sliced (turned 90° about Z, placed at 40, 60): the lip's first edge is born
  // in the air on layer 72; the last-printed top corner's gap fill hangs at the top front edge, which Find does not list.
  const placed = placeMesh(lipCoupon(), [0, -1, 0, 1, 0, 0, 0, 0, 1], 1, 250, 250, false, { x: 40, y: 60, z: 0 });
  const s = Math.SQRT1_2;
  const sliced: SlicedPose = { id: "part", pose: placed.pose, scale: 1, seatMm: 0, key: "" };
  const toPlate = (p: readonly number[]) => {
    const m = placed.pose.rotation;
    const d = [0, 1, 2].map((k) => p[k]! - placed.pose.pivot[k]!);
    const q = [0, 1, 2].map((r) => m[3 * r]! * d[0]! + m[3 * r + 1]! * d[1]! + m[3 * r + 2]! * d[2]! + placed.pose.translation[r]!);
    return [q[0]!, q[1]!, q[2]!] as [number, number, number];
  };
  const edge = [1, 5, 9, 13, 17].map((x) => toPlate([x, 19.9, 20.2]));
  const corner = [2, 4].map((x) => toPlate([x, 18.7, 29.4]));
  const hold = {
    patches: [
      { mm: 10, longestSpanMm: 10, layers: [71, 71] as [number, number], at: edge[0]!, first: edge },
      { mm: 118.9, longestSpanMm: 2.7, layers: [165, 166] as [number, number], at: corner[0]!, first: corner },
    ],
    objects: [sliced],
  };
  const checked = checkAgainstSlice({ ...FINDING, rows: [row(1)] }, hold, sliced, EDGES, positionsBox(lipCoupon()), [-s, 0, s]);
  check("on the belt the first edge is seen", checked.rows[0]!.seen?.layers[0] === 71, JSON.stringify(checked.rows[0]));
  const only = checked.slice?.only ?? [];
  check("the top front edge hangs in the slice only", only.length === 1 && only[0]!.edge === 3 && only[0]!.unheldMm === 118.9 && (only[0]!.distMm ?? 9) < 3, JSON.stringify(only));
  check("a slice-only row in words", sliceOnlyText(only[0]!) === "118.9 mm unheld at this edge, spans 2.7 mm, layers 166–167.", sliceOnlyText(only[0]!));
  check("the summary names it", sliceCheckSummary(checked) === "1 edge hangs in the last slice too. 1 other edge hangs in it that Find does not list.", sliceCheckSummary(checked) ?? "");
  check("no patch at all", sliceCheckSummary({ ...checked, slice: { patches: 0, only: [], faces: 0 } }) === "The last slice has no part bead standing on nothing on this part.");
}

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("model-transition-slice: patches, poses, marks, slice-only rows ok");
