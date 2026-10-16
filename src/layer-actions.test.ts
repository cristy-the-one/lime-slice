import { customGcodeNotice, cycleLayerAction, layerActionFields, layerMarkerText } from "./layer-actions.ts";

function check(name: string, ok: boolean) {
  if (!ok) throw new Error(name);
  console.log(name);
}

check("an empty list stays off the request", Object.keys(layerActionFields([])).length === 0);

const sent = layerActionFields([
  { zMm: 1.2, kind: "pause", note: "nut" },
  { zMm: 4, kind: "filamentChange" },
]);
check("a pause and a filament change are sent", sent.layerActions?.length === 2 && sent.layerActions[0].kind === "pause" && sent.layerActions[0].note === "nut" && sent.layerActions[1].kind === "filamentChange");

const once = cycleLayerAction([], 1);
check("the first click pauses", once.length === 1 && once[0].kind === "pause" && once[0].zMm === 1);
const twice = cycleLayerAction(once, 1);
check("the second click changes filament", twice.length === 1 && twice[0].kind === "filamentChange");
const thrice = cycleLayerAction(twice, 1);
check("the third click clears it", thrice.length === 0);
const kept = cycleLayerAction([{ zMm: 4, kind: "pause" }], 1);
check("another layer is left alone", kept.length === 2);

const shortLine = "G1 X1";
const keptLine = "G1 X" + "1".repeat(396);
const longLine = "M502 " + "X".repeat(500);
const sentCustom = layerActionFields([
  { zMm: 1, kind: "customGcode", gcode: shortLine },
  { zMm: 2, kind: "customGcode", gcode: keptLine },
  { zMm: 3, kind: "customGcode", gcode: longLine },
]);
check("a short custom line is sent whole", sentCustom.layerActions?.some((action) => action.gcode === shortLine) === true);
check("a 400 byte custom line is sent whole", sentCustom.layerActions?.some((action) => action.gcode === keptLine) === true);
check("a 500 character custom line is left out of the slice", sentCustom.layerActions?.every((action) => action.gcode !== longLine && action.gcode !== longLine.slice(0, 400)) === true);
const notice = customGcodeNotice([{ zMm: 3, kind: "customGcode", gcode: longLine }]);
check("opening lists the custom line", notice !== null && notice.includes(longLine));
check("the marker tooltip shows the custom line", layerMarkerText({ kind: "customGcode", gcode: longLine }).includes(longLine));
