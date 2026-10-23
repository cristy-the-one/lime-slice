import { projectFileName } from "./project-file-name.ts";

let failed = 0;

function eq<T>(name: string, actual: T, expected: T): void {
  if (actual === expected) return;
  failed += 1;
  console.error(`FAIL ${name}: got ${JSON.stringify(actual)}`);
}

eq("an opened project is saved under its own name", projectFileName("telo.lime", "part-3.step"), "telo.lime");
eq("the name saved last wins over the object", projectFileName("bracket v2.lime", "bar.stl"), "bracket v2.lime");
eq("the extension is read in any case", projectFileName("Telo.LIME", "bar.stl"), "Telo.LIME");
eq("a never-saved project takes the object's name", projectFileName(null, "bar.step"), "bar.lime");
eq("an imported mesh's title is not a project name", projectFileName("bar.stl", "bar.stl"), "bar.lime");
eq("an untitled project with a bare object name", projectFileName(null, "part"), "part.lime");
eq("a title that is only the extension is no name", projectFileName(".lime", "bar.3mf"), "bar.lime");
eq("blank space is no name", projectFileName("   ", "bar.stp"), "bar.lime");

if (failed) throw new Error(`${failed} failed`);
console.log("project file name: the opened or saved name, else the object's ok");
