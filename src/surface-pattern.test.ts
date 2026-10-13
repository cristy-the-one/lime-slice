import { readPresetSettings, DEFAULT_PRESET } from "./presets.ts";
import { surfaceSliceField } from "./surface-pattern.ts";

let failed = 0;
function check(name: string, ok: boolean) {
  if (!ok) {
    failed += 1;
    console.error("FAIL", name);
  }
}

check("speed auto sends nothing", Object.keys(surfaceSliceField("auto", "single", "speed")).length === 0);
check("a blend auto sends nothing", Object.keys(surfaceSliceField("auto", "byLayer", "toughness")).length === 0);
check("toughness auto blesses monotonic", surfaceSliceField("auto", "single", "toughness").topSurfacePattern === "monotonic");
check("an explicit rectilinear stays off the request", Object.keys(surfaceSliceField("rectilinear", "single", "toughness")).length === 0);
check("concentric is sent as named", surfaceSliceField("concentric", "single", "speed").topSurfacePattern === "concentric");

const { topSurfacePattern: _later, ...old } = DEFAULT_PRESET;
const opened = readPresetSettings(old);
check("a file from before the pattern reads as auto", opened?.topSurfacePattern === "auto");

if (failed) {
  console.error(`${failed} failed`);
  throw new Error(`${failed} failed`);
}
console.log("surface pattern: auto blesses toughness, rectilinear stays off the request");
