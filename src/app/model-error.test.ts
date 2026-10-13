import { modelerFailure } from "./model-error.ts";

let failed = 0;

function eq(name: string, actual: string, expected: string): void {
  if (actual === expected) return;
  failed += 1;
  console.error(`FAIL ${name}: got ${JSON.stringify(actual)}`);
}

const bridge = "Could not load the Open CASCADE bridge at C:\\Lime Slice\\occt\\lib\\lime_model_occt.dll: LoadLibraryExW failed: The specified module could not be found. (os error 126)";

eq("a Tauri string rejection is the readout", modelerFailure(bridge), bridge);
eq("an Error message is the readout", modelerFailure(new Error(bridge)), bridge);
eq("an object message is the readout", modelerFailure({ message: bridge }), bridge);
eq("an object error string is the readout", modelerFailure({ error: bridge }), bridge);
eq("blank text stays the generic readout", modelerFailure("  "), "The modeler returned an error.");
eq("a number stays the generic readout", modelerFailure(404), "The modeler returned an error.");

if (failed) {
  console.error(`${failed} failed`);
  throw new Error(`${failed} failed`);
}
console.log("model-error: bridge text is shown");
