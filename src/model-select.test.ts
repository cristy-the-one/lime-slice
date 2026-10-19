import { faceBoundarySegments, lastEdge, modelApplyReady, nextModelPicks, selectionCountLabel, shellFacesLabel } from "./model-select.ts";

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

const face = (index: number) => ({ kind: "face" as const, index });
const edge = (index: number) => ({ kind: "edge" as const, index });

eq("a click replaces", nextModelPicks([face(1)], face(2), false), [face(2)]);
eq("shift-click adds", nextModelPicks([face(1)], face(2), true), [face(1), face(2)]);
eq("shift-click removes", nextModelPicks([face(1), edge(4)], face(1), true), [edge(4)]);
eq("a miss clears", nextModelPicks([face(1), edge(4)], null, false), []);
eq("shift on empty space still clears", nextModelPicks([face(1)], null, true), []);
eq("the same face clicked again stays the only selection", nextModelPicks([face(3), edge(1)], face(3), false), [face(3)]);

eq("one face", selectionCountLabel([face(0)]), "1 face");
eq("faces and an edge", selectionCountLabel([face(0), face(1), edge(2)]), "2 faces · 1 edge");
eq("nothing selected has no chip", selectionCountLabel([]), "");

eq("the last edge wins", lastEdge([edge(1), face(0), edge(4)]), 4);
eq("no edge", lastEdge([face(2)]), null);

check("fillet waits for an edge", modelApplyReady("fillet", [face(1)], 2) === false);
check("fillet applies to the last edge", modelApplyReady("fillet", [edge(3)], 2));
check("fillet waits while the dry-run says it will not fit", modelApplyReady("fillet", [edge(3)], 2, true, false) === false);
check("scale of 1 is not an edit", modelApplyReady("scale", [], 1) === false);
check("scale of 2 is an edit", modelApplyReady("scale", [], 2));
check("a boolean can apply with nothing picked", modelApplyReady("boolean", [], 1));
check("a hole waits while the dry-run says it misses", modelApplyReady("hole", [], 1, true, false) === false);
check("split applies when the plane is inside the part", modelApplyReady("split", [], 1, true));
check("split waits when the plane would shave a face", modelApplyReady("split", [], 1, false) === false);
check("a pocket applies when the dry-run says it fits", modelApplyReady("pocket", [], 1));
check("a pocket waits while the dry-run says it will not fit", modelApplyReady("pocket", [], 1, true, false) === false);
check("a shell applies once the dry-run says it fits, with or without a face", modelApplyReady("shell", [], 1) && modelApplyReady("shell", [face(1)], 1));
check("a shell waits while the dry-run says the wall is too thick", modelApplyReady("shell", [face(1)], 1, true, false) === false);
check("a pattern applies when the dry-run says it fits", modelApplyReady("pattern", [], 1));
check("a pattern waits while the dry-run says it will not fit", modelApplyReady("pattern", [], 1, true, false) === false);
check("a mirror applies when the dry-run says it fits", modelApplyReady("mirror", [], 1));
eq("a closed shell says so", shellFacesLabel(2, true), "Closed inside.");
eq("no open face", shellFacesLabel(0, false), "No face open.");
eq("one open face", shellFacesLabel(1, false), "1 face open");
eq("two open faces", shellFacesLabel(2, false), "2 faces open");


// A square face, two triangles. The shared diagonal is not part of the outline.
const positions = [
  0, 0, 0, 1, 0, 0, 1, 1, 0,
  0, 0, 0, 1, 1, 0, 0, 1, 0,
];
const outline = faceBoundarySegments(positions, [7, 7]);
eq("one face keeps its boundary", outline.size, 1);
eq("the diagonal is dropped", (outline.get(7)?.length ?? 0) / 6, 4);

if (failed) {
  console.error(`${failed} failed`);
  throw new Error(`${failed} failed`);
}
console.log("model-select: click, shift, colors, outline ok");
