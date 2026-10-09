import { alignOutcomes, appendEdit, badgeOf, clearEdits, editRequestFields, editTitle, gapsToShow, gapZ, outcomeText, removeEdit, undoLast, type EditEntry } from "./support-edit-list.ts";
import { recipeKey } from "./slice-action.ts";
import type { CoverageGap, EditOutcome } from "./support-edits.ts";

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

const site = (x: number) => ({ xy: [x, 1] as [number, number], z: 4.123456789 });
const tree: EditEntry = { id: 1, edit: { kind: "prune", sites: Array.from({ length: 36 }, (_, i) => site(i)) }, scope: "tree" };
const regrow: EditEntry = { id: 2, edit: { kind: "regrow", region: [[[0, 0], [2, 0], [2, 2], [0, 2]]], z: [4.2, 6.4] }, areaMm2: 59.9 };
const branch: EditEntry = { id: 3, edit: { kind: "prune", sites: [site(7)] }, scope: "branch" };
const gapA: CoverageGap = { z: [4.2, 6.4], areaMm2: 59.9, min: [0.5, 0.5], max: [1.5, 1.5], outline: [] };
const gapB: CoverageGap = { z: [8, 9], areaMm2: 3, min: [10, 10], max: [11, 11], outline: [] };
const outcome = (over: Partial<EditOutcome> & Pick<EditOutcome, "status">): EditOutcome =>
  ({ changedLayers: 12, newlyFloatingMm2: 0, floating: [], ...over }) as EditOutcome;
const applied = outcome({ status: "applied", newlyFloatingMm2: 59.94, floating: [gapA] });
const held = outcome({ status: "applied", newlyFloatingMm2: -59.94 });
const quiet = outcome({ status: "applied", newlyFloatingMm2: 0.01 });

eq("append keeps order", appendEdit(appendEdit([], tree), regrow).map((e) => e.id), [1, 2]);
eq("undo drops the newest", undoLast([tree, regrow, branch]).map((e) => e.id), [1, 2]);
eq("undo of nothing is nothing", undoLast([]), []);
eq("remove by id", removeEdit([tree, regrow, branch], 2).map((e) => e.id), [1, 3]);
eq("clear", clearEdits(), []);

eq("pending tail after a cancel", alignOutcomes([tree, regrow, branch], [tree, regrow], [applied, held]), [applied, held, undefined]);
eq("remove in the middle pends the rest", alignOutcomes([tree, branch], [tree, regrow, branch], [applied, held, quiet]), [applied, undefined]);
eq("same list lines up", alignOutcomes([tree, regrow], [tree, regrow], [applied, held]), [applied, held]);
eq("badges", [badgeOf(applied), badgeOf(outcome({ status: "rebound", movedMm: 0.4 })), badgeOf(outcome({ status: "stale", missed: 1 })), badgeOf(undefined)], ["applied", "rebound", "stale", "pending"]);

eq("no edits, tree supports off", editRequestFields([], false), {});
eq("no edits, tree supports on", editRequestFields([], true), { includeSkeleton: true });
eq("edits, tree supports on", editRequestFields([tree, regrow], true), { supportEdits: [tree.edit, regrow.edit], includeSkeleton: true });
eq("edits, tree supports off", editRequestFields([tree], false), {});
const base = { layerHeight: 0.2, supports: false };
eq("off fields leave the recipe key alone", recipeKey({ ...base, ...editRequestFields([], false) }, "mesh"), recipeKey(base, "mesh"));
eq("sites reach the recipe unrounded", recipeKey(editRequestFields([branch], true), "m").includes("4.123456789"), true);

eq("tree title", editTitle(tree), "Delete tree · 36 tips");
eq("branch title", editTitle(branch), "Delete branch · 1 tip");
eq("regrow title", editTitle(regrow), "Regrow · Z 4.20–6.40");
eq("belt regrow title leaves out the slice-frame z", editTitle(regrow, true), "Regrow · 59.9 mm²");
eq("belt prune title is as on a flat bed", editTitle(tree, true), "Delete tree · 36 tips");
eq("a flat gap's z is its own", gapZ(gapA), [4.2, 6.4]);
eq("a belt gap's z is its layers' belt positions", gapZ({ ...gapA, z: [19.4, 19.8], tilted: { ls: [15.27, 15.84], outline: [] } }), [15.27, 15.84]);

eq("applied prune", outcomeText(tree, applied), "Removed 1 tree (36 tips). 59.9 mm² of overhang now unheld.");
eq("applied prune that unholds nothing", outcomeText(branch, quiet), "Removed 1 branch (1 tip). Nothing new is unheld.");
eq(
  "rebound prune",
  outcomeText(tree, outcome({ status: "rebound", movedMm: 0.4213, newlyFloatingMm2: 59.94 })),
  "Removed 1 tree (36 tips), matched 0.42 mm from where it was picked. 59.9 mm² of overhang now unheld.",
);
eq(
  "stale prune, some missed",
  outcomeText(tree, outcome({ status: "stale", missed: 2, newlyFloatingMm2: 59.94 })),
  "2 of 36 tips no longer exist, the rest were removed. 59.9 mm² of overhang now unheld.",
);
eq("stale prune, all missed", outcomeText(tree, outcome({ status: "stale", missed: 36 })), "Nothing matched: the supports changed since this edit.");
eq("stale prune, nothing changed", outcomeText(tree, outcome({ status: "stale", missed: 1, changedLayers: 0 })), "Nothing matched: the supports changed since this edit.");
eq("regrow that holds", outcomeText(regrow, held), "Regrew supports. 59.9 mm² of overhang held again.");
eq("stale regrow", outcomeText(regrow, outcome({ status: "stale", missed: 1 })), "Nothing unheld to regrow here.");

eq("prune gaps plus coverage, deduplicated", gapsToShow([gapA, gapB], [tree], [applied]), [gapA, gapB]);
eq("a regrow replaces the gaps in its region", gapsToShow([gapB], [tree, regrow], [applied, held]), [gapB]);
eq("a regrow keeps what it still leaves", gapsToShow([], [tree, regrow], [applied, outcome({ status: "applied", floating: [gapA] })]), [gapA]);
eq("no result", gapsToShow(undefined, [], undefined), []);

if (failed) {
  console.error(`${failed} failed`);
  throw new Error(`${failed} failed`);
}
console.log("support-edit-list: list, request fields, and copy ok");
