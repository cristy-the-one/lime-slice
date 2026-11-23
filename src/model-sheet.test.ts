/**
 * Organic fix round, item 6: one rule decides an open sheet. A surfaces-only STEP at its root is an import, as on
 * v7.1.2 (no banner, commits); a sheet a step or a feature root built is gated.
 */
import { encodeStl } from "./mesh-place.ts";
import { isOpenSheet, sheetAt, sheetPartNote, sheetVerdict } from "./model-sheet.ts";
import { ROOT, newTree, withNode, withoutBuilds } from "./model-tree.ts";
import { addedCopy, addedSolid, replaceWithShells, withMendedMesh, withSheet, withoutObject } from "./plate.ts";

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


// The plate rule: the mark lives on the plate object, set from the kernel's verdict, and cannot be lost.
{
  const box = (n: number) => new Float32Array([0, 0, 0, 10 * n, 0, 0, 0, 10, 0, 0, 0, 2, 10 * n, 0, 2, 0, 10, 2]);
  const meshOf = (name: string, pos: Float32Array) => ({ name, fileName: `${name}.stl`, bytes: encodeStl(pos, `${name}.stl`), sourcePos: pos, stepTolerance: 0.05 });
  let plate = addedSolid({ objects: [], selectedId: null }, meshOf("Lid", box(1)), "lid", "lid#1", { m: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] }, 220, 220);
  const lid = plate.objects[0]!.id;
  plate = withSheet(plate, lid, sheetVerdict(surfaces));
  check("the kernel's verdict marks the plate object", plate.objects[0]!.sheet === true);
  check("an unknown verdict (a part's own file) leaves the mark as it was", withSheet(plate, lid, undefined) === plate);
  check("Slice and Export stop on a marked object, by name, with the prompt", sheetPartNote(plate.objects) === "Lid is an open sheet, not a solid. Thicken or Cap & Sew it in Model before slicing or exporting.");
  check("a solid's verdict clears the mark (thickened, sewn)", sheetPartNote(withSheet(plate, lid, sheetVerdict(solid)).objects) === null);

  // (a) Duplicate, then remove the original: the copy is still a sheet, and Slice is refused.
  const copied = addedCopy(plate)!;
  const copy = copied.objects.find((obj) => obj.id !== lid)!;
  const onlyCopy = withoutObject(copied, lid);
  check("Duplicate carries the mark", copy.sheet === true);
  check("with the original removed, Slice still stops on the copy", onlyCopy.objects.length === 1 && sheetPartNote(onlyCopy.objects) !== null);
  // Reopened, the copy's tree root is a STEP: still a sheet, because the object is marked.
  check("a marked object reopened from its STEP is still a sheet (no STEP exemption)", isOpenSheet(surfaces, step, ROOT, true));

  // (c) Split shells: each shell of a sheet is a sheet.
  const two = new Float32Array([...box(1), ...Array.from(box(1)).map((v, i) => (i % 3 === 0 ? v + 50 : v))]);
  const split = replaceWithShells(plate, lid, [two.slice(0, 18), two.slice(18)], 220, 220)!;
  check("split shells of a sheet are each marked", split.objects.length === 2 && split.objects.every((obj) => obj.sheet === true));

  // Close holes: a plain mesh after; still a sheet only while an edge is open.
  check("Close holes with edges still open keeps the mark", withMendedMesh(plate, lid, box(1), true)!.objects[0]!.sheet === true);
  check("Close holes that closed every edge clears the mark", withMendedMesh(plate, lid, box(1), false)!.objects[0]!.sheet === undefined);
}

// The History badge asks the same rule from the verdict a node keeps.
check("a node's kept verdict at a STEP root gives no badge; elsewhere it does", !sheetAt(true, step, ROOT) && sheetAt(true, step, 3) && !sheetAt(undefined, feature, 3));

// A root edit rebuilds every node under its id: their old plate meshes go (`commitModel` takes a stored mesh first).
{
  const fp = { volumeMm3: 8, faces: 6, edges: 12 };
  const tree = newTree("a#1", { kind: "primitive", solid: { primitive: "box", origin: [0, 0, 0], size: [2, 2, 2] } } as never, "Box", fp);
  const mesh = { name: "a.stl", bytes: new ArrayBuffer(84), sourcePos: new Float32Array(9), token: "t" };
  const built = withNode(tree, ROOT, { mesh });
  const cleared = withoutBuilds(built);
  const root = cleared.nodes.get(ROOT)!;
  check("withoutBuilds drops a node's stored plate mesh and fingerprint", root.mesh === undefined && root.fingerprint === null && built.nodes.get(ROOT)!.mesh === mesh);
}

if (failed) {
  console.error(`${failed} checks failed`);
  process.exit(1);
}
console.log("open sheet rule: ok");
