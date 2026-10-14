import { DEFAULT_PRESET, readPresetSettings } from "./presets.ts";
import { xySliceFields } from "./xy-comp.ts";

let failed = 0;
function check(name: string, ok: boolean) {
  if (!ok) {
    failed += 1;
    console.error("FAIL", name);
  }
}

const zero = { xyHoleCompensationMm: 0, xyContourCompensationMm: 0, elephantsFootCompensationMm: 0 };
check("zeros stay off the request", Object.keys(xySliceFields(zero)).length === 0);
const sent = xySliceFields({ xyHoleCompensationMm: 0.2, xyContourCompensationMm: -0.1, elephantsFootCompensationMm: 0.15 });
check("a hole offset is sent", sent.xyHoleCompensationMm === 0.2);
check("a contour offset is sent", sent.xyContourCompensationMm === -0.1);
check("elephant's foot is sent", sent.elephantsFootCompensationMm === 0.15);
check("a negative foot is omitted", xySliceFields({ ...zero, elephantsFootCompensationMm: -0.2 }).elephantsFootCompensationMm === undefined);

const { xyHoleCompensationMm: _h, xyContourCompensationMm: _c, elephantsFootCompensationMm: _f, ...old } = DEFAULT_PRESET;
check("a file from before compensation reads as zero", readPresetSettings(old)?.xyHoleCompensationMm === 0 && readPresetSettings(old)?.elephantsFootCompensationMm === 0);

if (failed) {
  console.error(`${failed} failed`);
  throw new Error(`${failed} failed`);
}
console.log("xy compensation: zeros stay off the request");
