import { isLimeProject, planFileDrop } from "./file-drop.ts";

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

check("a .lime project is not a mesh object", isLimeProject("plate.lime") && isLimeProject("Plate.LIME"));
check("a mesh name is not a project", !isLimeProject("part.stl") && !isLimeProject("part.3mf") && !isLimeProject("part.step") && !isLimeProject("part.stp"));
check("a name that only contains lime is still a mesh", !isLimeProject("lime-cube.stl") && !isLimeProject("notes.lime.txt"));

if (failed) {
  console.error(`${failed} failed`);
  throw new Error(`${failed} failed`);
}
console.log("file drop: plain replaces, Shift adds, empty plate ignores Shift");
