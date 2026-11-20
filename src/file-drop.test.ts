import { isLimeProject, planFileDrop } from "./file-drop.ts";
import { planFilePick } from "./file-pick.ts";

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

eq("no files does nothing", planFileDrop(true, true, []), null);
eq("a plain drop replaces with the first file", planFileDrop(false, true, ["a.stl", "b.stl"]), { kind: "replace", index: 0 });
eq("a plain drop on an empty plate replaces with the first file", planFileDrop(false, false, ["a.stl", "b.3mf"]), { kind: "replace", index: 0 });
eq("an empty plate ignores Shift and still replaces", planFileDrop(true, false, ["a.stl", "b.stl"]), { kind: "replace", index: 0 });
eq(
  "Shift on a loaded plate adds every file in order",
  planFileDrop(true, true, ["a.stl", "b.3mf", "c.step", "d.stp"]),
  { kind: "add", indexes: [0, 1, 2, 3] },
);
eq(
  "Shift keeps a project file in the Add list, where Add refuses it",
  planFileDrop(true, true, ["job.lime", "part.stl"]),
  { kind: "add", indexes: [0, 1] },
);
eq("one file with Shift on a loaded plate is an add", planFileDrop(true, true, ["only.stl"]), { kind: "add", indexes: [0] });

eq("a pick of no files does nothing", planFilePick("open", true, []), null);
eq("Open with one mesh replaces the plate", planFilePick("open", true, ["a.step"]), { replace: 0, add: [], skipped: [] });
eq(
  "Open with several meshes replaces with the first and adds the rest in order",
  planFilePick("open", true, ["a.step", "b.stp", "c.stl", "d.3mf"]),
  { replace: 0, add: [1, 2, 3], skipped: [] },
);
eq("Open on an empty plate is the same", planFilePick("open", false, ["a.step", "b.step"]), { replace: 0, add: [1], skipped: [] });
eq(
  "Open with a project and meshes opens the project and adds the meshes to it",
  planFilePick("open", true, ["a.step", "job.lime", "b.stl"]),
  { replace: 1, add: [0, 2], skipped: [] },
);
eq(
  "Open with two projects opens the first and skips the other",
  planFilePick("open", true, ["one.lime", "two.LIME", "a.stl"]),
  { replace: 0, add: [2], skipped: [1] },
);
eq(
  "Add on a loaded plate adds every mesh in order and never replaces",
  planFilePick("add", true, ["a.step", "b.stp", "c.stl"]),
  { replace: null, add: [0, 1, 2], skipped: [] },
);
eq("Add on a loaded plate skips a project", planFilePick("add", true, ["job.lime", "a.step"]), { replace: null, add: [1], skipped: [0] });
eq(
  "Add on an empty plate works like Open: the first mesh is the plate, the rest are added",
  planFilePick("add", false, ["a.step", "b.step"]),
  { replace: 0, add: [1], skipped: [] },
);
eq("Add on an empty plate never opens a project", planFilePick("add", false, ["job.lime", "a.step"]), { replace: 1, add: [], skipped: [0] });
eq("Add on an empty plate with only a project does nothing but skip it", planFilePick("add", false, ["job.lime"]), { replace: null, add: [], skipped: [0] });

check("a .lime project is not a mesh object", isLimeProject("plate.lime") && isLimeProject("Plate.LIME"));
check("a mesh name is not a project", !isLimeProject("part.stl") && !isLimeProject("part.3mf") && !isLimeProject("part.step") && !isLimeProject("part.stp"));
check("a name that only contains lime is still a mesh", !isLimeProject("lime-cube.stl") && !isLimeProject("notes.lime.txt"));

if (failed) {
  console.error(`${failed} failed`);
  throw new Error(`${failed} failed`);
}
console.log("file drop: plain replaces, Shift adds, empty plate ignores Shift; picks: Open replaces once and adds the rest, Add adds");
