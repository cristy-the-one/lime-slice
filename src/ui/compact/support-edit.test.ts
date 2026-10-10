import { appendEdit, clearEdits, editTitle, undoLast } from "../../support-edit-list.ts";
import { indexSkeleton, pickLimb, regrowFor, selectLimbs, sitesOf, type Visible } from "../../support-pick.ts";
import type { CoverageGap, SupportSkeleton } from "../../support-edits.ts";
import { chipAction, peekLine, scopeForGesture, selectionLabel } from "./support-gesture.ts";

let failed = 0;

function eq<T>(name: string, actual: T, expected: T): void {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  if (same) return;
  failed += 1;
  console.error(`FAIL ${name}: got ${JSON.stringify(actual)}`);
}

const skel: SupportSkeleton = {
  id: [1, 2],
  tree: [1, 1],
  into: [0, 1],
  live: [1, 1],
  siteX: [0, 4],
  siteY: [0, 1],
  siteZ: [12, 8],
  start: [0, 2, 4],
  xs: [0, 0, 4, 2],
  ys: [0, 0, 1, 0.5],
  zs: [12, 0, 8, 4],
  rs: [1.5, 2, 0.8, 1],
};
const index = indexSkeleton(skel);
const visible: Visible = { zLow: -1, zHigh: 30, section: null };
const ray = { origin: [0, -20, 6] as [number, number, number], dir: [0, 1, 0] as [number, number, number] };

eq("tap picks a branch", scopeForGesture("tap"), "branch");
eq("long-press picks the tree", scopeForGesture("longpress"), "tree");

const hit = pickLimb(index, ray, visible, 0.3);
eq("center ray hits the trunk", hit?.limb, 0);
const tip = pickLimb(index, { origin: [4, -20, 8], dir: [0, 1, 0] }, visible, 0.3);
eq("offset ray hits the merged tip", tip?.limb, 1);
const branchSites = sitesOf(index, selectLimbs(index, tip!.limb, scopeForGesture("tap")));
const treeSites = sitesOf(index, selectLimbs(index, tip!.limb, scopeForGesture("longpress")));
eq("a tap on the tip prunes that tip", branchSites, [{ xy: [4, 1], z: 8 }]);
eq("a long-press prunes the whole tree", treeSites, [{ xy: [0, 0], z: 12 }, { xy: [4, 1], z: 8 }]);

eq(
  "tree label names the scope and the tips",
  selectionLabel({ kind: "limb", scope: "tree", tips: treeSites.length, z: treeSites[0].z }),
  "Tree · 2 tips",
);
eq(
  "one tip names its contact height",
  selectionLabel({ kind: "limb", scope: "branch", tips: 1, z: branchSites[0].z }),
  "Branch · Z 8.00",
);
eq("a limb chips Prune", chipAction({ kind: "limb", scope: "tree", tips: 2, z: 12 }), "prune");

const gap: CoverageGap = {
  z: [8, 12],
  areaMm2: 16,
  min: [-4, -3],
  max: [4, 3],
  outline: [[[-4, -3], [4, -3], [4, 3], [-4, 3]]],
};
eq(
  "gap label names the z range",
  selectionLabel({ kind: "gap", areaMm2: gap.areaMm2, z: gap.z }),
  "Unheld · 16.0 mm² · Z 8.00–12.00",
);
eq("a gap chips Regrow", chipAction({ kind: "gap", areaMm2: 16, z: gap.z }), "regrow");
eq("nothing selected has no chip", chipAction(null), null);
eq(
  "peek quotes the coverage warning",
  peekLine({ treeSupports: true, gaps: [gap], selected: null }),
  "Supports leave 1 overhang patch unheld, 16.0 mm² in all.",
);
eq("peek is quiet with nothing to say", peekLine({ treeSupports: true, gaps: [], selected: null }), "");
eq("peek names tree supports off", peekLine({ treeSupports: false, gaps: [], selected: null }), "Tree supports are off.");
eq(
  "peek prefers the selection",
  peekLine({ treeSupports: true, gaps: [gap], selected: "Tree · 2 tips" }),
  "Tree · 2 tips",
);

const regrow = regrowFor(gap);
eq("regrow keeps the gap z range", regrow.z, [8, 12]);
eq("regrow region is the gap bounds", regrow.region, [[[-4, -3], [4, -3], [4, 3], [-4, 3]]]);

const prune = { id: 1, edit: { kind: "prune" as const, sites: treeSites }, scope: "tree" as const };
const grown = { id: 2, edit: regrow, areaMm2: gap.areaMm2 };
let list = appendEdit([], prune);
eq("prune title", editTitle(list[0]), "Delete tree · 2 tips");
list = appendEdit(list, grown);
eq("regrow title keeps z", editTitle(list[1]), "Regrow · Z 8.00–12.00");
list = undoLast(list);
eq("undo drops the regrow", list.map((entry) => entry.id), [1]);
eq("clear empties the list", clearEdits(), []);

if (failed) {
  console.error(`${failed} failed`);
  throw new Error(`${failed} failed`);
}
console.log("compact support edit: pick, chip, prune, regrow, undo ok");
