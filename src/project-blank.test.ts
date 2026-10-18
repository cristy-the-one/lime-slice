import { readFileSync } from "node:fs";
import { DEFAULT_PRESET } from "./presets.ts";
import { blankDocument, LAUNCH_CALIBRATION, replaceChoice } from "./project-blank.ts";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) return;
  failed += 1;
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}

check("a clean project does not ask", replaceChoice(false, null) === "discard");
check("a clean project ignores a stray cancel", replaceChoice(false, "cancel") === "discard");
check("save keeps the dirty project long enough to write it", replaceChoice(true, "save") === "save");
check("don't save drops the dirty project", replaceChoice(true, "discard") === "discard");
check("cancel leaves the dirty project", replaceChoice(true, "cancel") === "cancel");
check("closing the dialog cancels", replaceChoice(true, null) === "cancel");

const launch = { stage: "preview", layerHeight: DEFAULT_PRESET.layerHeight, profileName: "Lime 220" };
const blank = blankDocument(launch);
check("the plate is empty", blank.mesh === null && blank.plateCount === 0 && blank.selectedId === null);
check("the slice is gone", blank.result === null && blank.layer === 0 && blank.slicedHash === "");
check("undo, paint, and search are clear", blank.historySteps === 0 && blank.paint === 0 && blank.query === "");
check("the title is untitled", blank.title === null && blank.dirty === false);
check("settings are the launch defaults", blank.layerHeight === 0.2 && blank.profileName === "Lime 220");
check("preview goes back to Preview", blank.stage === "preview");
check("Model stays in Model", blankDocument({ ...launch, stage: "model" }).stage === "model");
check("G-code does not stay on an empty file", blankDocument({ ...launch, stage: "gcode" }).stage === "preview");
check("a calibration tower is not kept", LAUNCH_CALIBRATION.paBands.length === 0 && LAUNCH_CALIBRATION.paGcode === "");

const markup = readFileSync(new URL("./app/markup.ts", import.meta.url), "utf8");
const compact = readFileSync(new URL("./ui/compact/mount.ts", import.meta.url), "utf8");
const commands = readFileSync(new URL("./ui/commands.ts", import.meta.url), "utf8");
check("File menu has New beside Open and Save", markup.includes('data-file-action="new"') && markup.indexOf('data-file-action="new"') < markup.indexOf('data-file-action="open"'));
check("the compact menu has New project", compact.includes("New project"));
check("Ctrl+N is the New project command", commands.includes('id: "new-project"') && commands.includes('keys: ["Ctrl+N"]'));

if (failed) {
  console.error(`${failed} failed`);
  throw new Error(`${failed} failed`);
}
console.log("project-blank: new document choice and blank state ok");
