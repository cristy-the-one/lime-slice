/**
 * Organic fix round, item 6: one rule decides an open sheet. A surfaces-only STEP at its root is an import, as on
 * v7.1.2 (no banner, commits); a sheet a step or a feature root built is gated.
 */
import { isOpenSheet, sheetPartNote, treeIsSheet } from "./model-sheet.ts";
import { ROOT, newTree, withNode, withoutBuilds, type ModelTree } from "./model-tree.ts";
import { readSavedTree, savedTree } from "./model-tree-file.ts";

let failed = 0;
function check(name: string, ok: boolean) {
  if (ok) {
    console.log(name);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name}`);
}

const surfaces = { editable: false, faces: [{}, {}], nakedEdges: [0, 3] };
const solid = { editable: true, faces: [{}, {}], nakedEdges: [] };
const closedShell = { editable: false, faces: [{}, {}] };
const step = { kind: "step" as const };
const feature = { kind: "feature" as const };
const primitive = { kind: "primitive" as const };

check("a surfaces-only STEP at its root is not a sheet (commits as on v7.1.2)", !isOpenSheet(surfaces, step, ROOT));
check("a step that leaves an open sheet on a STEP part is a sheet", isOpenSheet(surfaces, step, 2));
check("a step that leaves an open sheet on a primitive is a sheet", isOpenSheet(surfaces, primitive, 1));
check("a sheet feature as a new object's root is a sheet", isOpenSheet(surfaces, feature, ROOT));
check("a closed solid is never a sheet", !isOpenSheet(solid, feature, 3));
check("a non-solid with no open border is not a sheet (the viewport reads naked edges the same way)", !isOpenSheet(closedShell, feature, 3));
check("nothing on screen is not a sheet", !isOpenSheet(null, feature, ROOT));


// The plate rule: a sheet object stays on the plate, marked on its committed node; Slice and Export stop on it.
{
  const fp = { volumeMm3: 0, faces: 1, edges: 4 };
  const plain = newTree("a#1", { kind: "feature", op: { kind: "sheet", mode: "planar", curves: [{ kind: "polyline", points: [[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0]], closed: true }] } }, "Sheet", fp);
  const sheet: ModelTree = withNode(plain, ROOT, { sheet: true });
  const trees = new Map([["a#1", sheet], ["b#1", plain]]);
  check("a tree whose committed node is marked is a sheet", treeIsSheet(sheet) && !treeIsSheet(plain));
  const note = sheetPartNote([{ name: "Box" }, { name: "Lid", modelTree: "a#1" }], (key) => trees.get(key));
  check("Slice and Export stop on the first sheet object, by name, with the prompt", note === "Lid is an open sheet, not a solid. Thicken or Cap & Sew it in Model before slicing or exporting.");
  check("a plate with no sheet object slices", sheetPartNote([{ name: "Box", modelTree: "b#1" }], (key) => trees.get(key)) === null);
  // The mark is saved with the project and read back.
  const body = savedTree(sheet, ROOT, () => undefined);
  const back = readSavedTree({ ...JSON.parse(JSON.stringify(body)), rootFeature: (sheet.root as { op: unknown }).op });
  check("the sheet mark survives a save and a reload", !!back && JSON.stringify(back).includes('"sheet":true') && body.nodes[0]?.sheet === true);
  // A root edit rebuilds every node under its id: their old plate meshes and marks go.
  const mesh = { name: "a.stl", bytes: new ArrayBuffer(84), sourcePos: new Float32Array(9), token: "t" };
  const built = withNode(sheet, ROOT, { mesh });
  const cleared = withoutBuilds(built);
  const root = cleared.nodes.get(ROOT)!;
  check("withoutBuilds drops a node's stored plate mesh, sheet mark and fingerprint (a root edit's commit takes the new mesh)", root.mesh === undefined && root.sheet === undefined && root.fingerprint === null && built.nodes.get(ROOT)!.mesh === mesh);
}

if (failed) {
  console.error(`${failed} checks failed`);
  process.exit(1);
}
console.log("open sheet rule: ok");
