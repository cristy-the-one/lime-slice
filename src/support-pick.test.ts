import { branchLimbs, capsulesOf, indexSkeleton, pickGap, pickLimb, regrowFor, selectLimbs, sitesOf, treeLimbs, type Visible } from "./support-pick.ts";
import type { CoverageGap, SupportSkeleton } from "./support-edits.ts";

let failed = 0;

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) return;
  failed += 1;
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}

function eq<T>(name: string, actual: T, expected: T): void {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  check(name, same, same ? "" : `got ${JSON.stringify(actual)}`);
}

// Tree 1: limb 4 merges into 3, 3 into 2, 2 into 1. Limb 3 is trimmed, limb 5 prints no knots.
// Tree 6: a trunk and a single-knot limb 7 merged into it.
const skel: SupportSkeleton = {
  id: [1, 2, 3, 4, 5, 6, 7],
  tree: [1, 1, 1, 1, 1, 6, 6],
  into: [0, 1, 2, 3, 1, 0, 6],
  live: [1, 1, 0, 1, 1, 1, 1],
  siteX: [10.001, 13, 16, 18, 11, 30, 33],
  siteY: [10, 10, 10, 10, 12.5, 10, 10],
  siteZ: [6, 5, 5, 4.123456789, 5.5, 6, 3],
  start: [0, 2, 4, 6, 8, 8, 10, 11],
  xs: [10, 10, 13, 10.5, 16, 13.5, 18, 16.25, 30, 30, 33],
  ys: [10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10],
  zs: [6, 0, 5, 3, 5, 4.5, 6, 5.25, 6, 0, 3],
  rs: [1, 1, 0.5, 0.75, 0.5, 0.5, 0.5, 0.5, 1, 1, 0.5],
};
const index = indexSkeleton(skel);
const all: Visible = { zLow: -1, zHigh: 100, section: null };
const along = (x: number, z: number) => ({ origin: [x, -50, z] as [number, number, number], dir: [0, 2, 0] as [number, number, number] });

eq("guests of each limb", index.guests, [[1, 4], [2], [3], [], [], [6], []]);
eq("branch of the root is the whole tree", branchLimbs(index, 0), [0, 1, 2, 3, 4]);
eq("branch follows a three-level into chain", branchLimbs(index, 1), [1, 2, 3]);
eq("branch of a tip is the tip", branchLimbs(index, 3), [3]);
eq("tree of a tip", treeLimbs(index, 3), [0, 1, 2, 3, 4]);
eq("second tree", selectLimbs(index, 6, "tree"), [5, 6]);
eq("branch scope", selectLimbs(index, 1, "branch"), [1, 2, 3]);
eq(
  "branch sites skip the trimmed limb and keep exact values",
  sitesOf(index, branchLimbs(index, 1)),
  [{ xy: [13, 10], z: 5 }, { xy: [18, 10], z: 4.123456789 }],
);
eq(
  "tree sites include the zero-knot limb",
  sitesOf(index, treeLimbs(index, 2)),
  [{ xy: [10.001, 10], z: 6 }, { xy: [13, 10], z: 5 }, { xy: [18, 10], z: 4.123456789 }, { xy: [11, 12.5], z: 5.5 }],
);

eq("ray through the first trunk", pickLimb(index, along(10, 3), all, 0.3), { limb: 0, distance: 60 });
eq("ray through the second trunk skips the zero-knot limb before it", pickLimb(index, along(30, 3), all, 0.3), { limb: 5, distance: 60 });
eq("ray through a single-knot limb", pickLimb(index, along(33, 3), all, 0.3), { limb: 6, distance: 60 });
eq("ray just outside the radius plus slop misses", pickLimb(index, along(11.4, 1), all, 0.3), null);
eq("ray just inside the radius plus slop hits", pickLimb(index, along(11.2, 1), all, 0.3)?.limb, 0);
eq("trunk above the layer slab is hidden", pickLimb(index, along(10, 5.5), { zLow: -1, zHigh: 4, section: null }, 0.3), null);
eq("same ray with the slab raised", pickLimb(index, along(10, 5.5), { zLow: -1, zHigh: 10, section: null }, 0.3)?.limb, 0);
const cut: Visible = { zLow: -1, zHigh: 100, section: { center: [20, 10, 3], spec: { normal: [-1, 0, 0], offset: 5 } } };
eq("trunk on the hidden side of the section", pickLimb(index, along(10, 3), cut, 0.3), null);
eq("trunk on the kept side of the section", pickLimb(index, along(30, 3), cut, 0.3), { limb: 5, distance: 60 });
eq(
  "nearest limb along the ray wins",
  pickLimb(index, { origin: [50, 10, 3], dir: [-1, 0, 0] }, all, 0.3),
  { limb: 6, distance: 17 },
);

const gap: CoverageGap = { z: [4, 6.5], areaMm2: 59.9, min: [1, 2], max: [3, 4], outline: [[[1, 2], [3, 2], [3, 4], [1, 4]]] };
const down = { origin: [2, 3, 20] as [number, number, number], dir: [0, 0, -4] as [number, number, number] };
eq("ray down through a gap box", pickGap([gap], down, all, 0.5), { gap: 0, distance: 13.5 });
eq("gap above the slab is hidden", pickGap([gap], down, { zLow: -1, zHigh: 5, section: null }, 0.5), null);
eq("ray beside the padded box misses", pickGap([gap], { origin: [3.6, 3, 20], dir: [0, 0, -1] }, all, 0.5), null);
eq("ray inside the pad hits", pickGap([gap], { origin: [3.4, 3, 20], dir: [0, 0, -1] }, all, 0.5)?.gap, 0);

eq("regrow over a gap box", regrowFor(gap), { kind: "regrow", region: [[[1, 2], [3, 2], [3, 4], [1, 4]]], z: [4, 6.5] });

eq(
  "capsules skip zero-knot limbs and give single knots one capsule",
  [...capsulesOf(index, [0, 4, 6])],
  [10, 10, 6, 1, 10, 10, 0, 1, 33, 10, 3, 0.5, 33, 10, 3, 0.5],
);
eq("one capsule per two-knot limb", capsulesOf(index, [1, 2]).length, 16);

if (failed) {
  console.error(`${failed} failed`);
  throw new Error(`${failed} failed`);
}
console.log("support-pick: picking and selection ok");
