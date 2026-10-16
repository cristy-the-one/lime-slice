/**
 * The plate slice the tools send is the same body the app's `sliceRequest` builds.
 * Retract at 45 mm/s, ironing spacing, and a region plane that misses the part
 * are the drifts a hand copy already had.
 */
import { bytesToBase64 } from "../src/base64.ts";
import { ironingSpacingMax } from "../src/ironing.ts";
import { emptyOverrides } from "../src/overrides.ts";
import { DEFAULT_PRESET } from "../src/presets.ts";
import { ID_MATRIX } from "../src/mesh-place.ts";
import { emptyOverrides as _empty, addRange } from "../src/overrides.ts";
import { settingsRules, orderFields } from "../src/settings-rules.ts";
import { sliceRequest } from "../src/slice-request.ts";
import { slicePlateFields, type PlateObject as SliceObject } from "../src/plate.ts";
import { nextSplitAt } from "../src/split-at.ts";
import { builtinLibrary, enginePrinter, heatFor } from "../src/ui/machine-library.ts";

import { blendOf, sessionSliceRequest } from "./request.ts";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(name);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name}${detail ? ` ${detail}` : ""}`);
}

const library = builtinLibrary();
const printer = library.printers.find((row) => row.id === "lime-220")!;
const filament = library.filaments.find((row) => row.id === "lime-pla")!;
const bounds = { min: [100, 100, 0] as [number, number, number], max: [120, 120, 20] as [number, number, number] };
const bytes = new Uint8Array([1, 2, 3, 4]);
const shared = {
  filename: "cube.stl",
  bytes,
  pose: null,
  printer,
  filament,
  nozzleMm: 0.4,
  actions: [],
  objects: 1,
  bounds,
  stepToleranceMm: 0.05,
};

const regionSettings = {
  ...DEFAULT_PRESET,
  retractOn: true,
  retractLength: 1.2,
  retractSpeed: 45,
  ironing: true,
  ironingSpacing: 5,
  blendKind: "byRegion",
  atMm: 10,
};
const speedSettings = { ...DEFAULT_PRESET, blendKind: "single", strategy: "speed" };

function appBody(settings: typeof regionSettings) {
  const rules = settingsRules({
    kind: printer.kind,
    belt: { raftLayers: printer.belt.raftLayers, maxLengthMm: printer.belt.maxLengthMm },
    firmware: printer.firmware,
    firmwareArcs: printer.firmwareArcs,
    objects: 1,
    supportMode: "auto",
  });
  const built = enginePrinter(printer, filament, 0.4);
  const heat = heatFor(printer, filament.nozzleTemp, filament.bedTemp);
  const { filamentDensityGCm3: _density, filamentCostPerKg: _cost, ...profile } = built;
  const lineWidth = Math.min(1.2, Math.max(0.2, 0.4 * 1.125));
  const next = { ...settings };
  if (next.blendKind === "byRegion") next.atMm = nextSplitAt("open", next.atMm, bounds, "x", false);
  return rules.coerce(sliceRequest({
    one: { filename: "cube.stl", dataB64: bytesToBase64(bytes) },
    plate: {},
    order: {},
    settings: next,
    stepToleranceMm: 0.05,
    lineWidth,
    blend: blendOf(next),
    printer: {
      ...profile,
      nozzleTemp: heat.nozzleC,
      bedTemp: heat.bedC,
      pressureAdvance: next.pressureAdvance,
      linearAdvance: next.linearAdvance,
      firmware: rules.firmware,
      firmwareArcs: rules.firmwareArcs,
    },
    onBelt: false,
    belt: null,
    layerActions: [],
    overrides: emptyOverrides(),
    includePreview: true,
  }));
}

const region = sessionSliceRequest({ ...shared, settings: regionSettings });
const speed = sessionSliceRequest({ ...shared, settings: speedSettings });
const regionJson = JSON.stringify(region);
const appJson = JSON.stringify(appBody(regionSettings));
check("the session body deep-equals the app builder", regionJson === appJson, regionJson.slice(0, 240));
check("the speed body deep-equals the app builder", JSON.stringify(speed) === JSON.stringify(appBody(speedSettings)));

const regionBody = region as { retractOn?: boolean; retractSpeed?: number; retractLength?: number; ironing?: { spacing?: number }; blend?: { mode?: string; atMm?: number }; includePreview?: boolean };
const lineWidth = Math.min(1.2, Math.max(0.2, 0.45));
check("retract at 45 mm/s is sent and clamped", regionBody.retractOn === undefined && regionBody.retractSpeed === 45 && regionBody.retractLength === 1.2);
check("ironing spacing is clamped to the line width", regionBody.ironing?.spacing === ironingSpacingMax(lineWidth) && (regionBody.ironing?.spacing ?? 1) < 5);
check("a region plane outside the cube moves onto it", regionBody.blend?.mode === "byRegion" && regionBody.blend.atMm === 110);
check("a region slice differs from speed", regionJson !== JSON.stringify(speed));
check("the tool slice asks for layer heights", regionBody.includePreview === true);

const pose = { rotation: [...ID_MATRIX] as [number, number, number, number, number, number, number, number, number], pivot: [0, 0, 0] as [number, number, number], translation: [110, 110, 0] as [number, number, number] };
function bedObject(id: string): SliceObject {
  return {
    id,
    name: `${id}.stl`,
    fileName: `${id}.stl`,
    bytes: new ArrayBuffer(0),
    sourcePos: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    orient: [...ID_MATRIX],
    partScale: 1,
    centered: true,
    offset: { x: 0, y: 0, z: 0 },
    stepTolerance: 0.05,
    supportEdits: [],
    supportPaint: [],
    seamPaint: [],
    reinforcement: [],
    settings: id === "b" ? { walls: 4 } : {},
  };
}
const plateObjects = [bedObject("a"), bedObject("b")];
const plate = slicePlateFields(plateObjects, () => pose, { supports: false, supportStyle: "grid", blendKind: "single", strategy: "speed", toughness: 0.5 });
const rules = settingsRules({
  kind: printer.kind,
  belt: { raftLayers: printer.belt.raftLayers, maxLengthMm: printer.belt.maxLengthMm },
  firmware: printer.firmware,
  firmwareArcs: printer.firmwareArcs,
  objects: 2,
  supportMode: "auto",
});
const order = orderFields(rules, { printOrder: "sequential", clearanceMm: 4, gantryMm: 30 });
const overrides = addRange(_empty(), { id: "range-1", zFrom: 0, zTo: 4, override: { walls: 6 } });
const actions = [{ zMm: 1, kind: "pause" as const }];
const plateSettings = { ...DEFAULT_PRESET };
const sessionPlate = sessionSliceRequest({
  ...shared,
  settings: plateSettings,
  objects: 2,
  order,
  plate,
  overrides,
  actions,
});
const appPlate = rules.coerce(sliceRequest({
  one: {},
  plate,
  order,
  settings: plateSettings,
  stepToleranceMm: 0.05,
  lineWidth: Math.min(1.2, Math.max(0.2, 0.4 * 1.125)),
  blend: blendOf(plateSettings),
  printer: (() => {
    const built = enginePrinter(printer, filament, 0.4);
    const heat = heatFor(printer, filament.nozzleTemp, filament.bedTemp);
    const { filamentDensityGCm3: _density, filamentCostPerKg: _cost, ...profile } = built;
    return {
      ...profile,
      nozzleTemp: heat.nozzleC,
      bedTemp: heat.bedC,
      pressureAdvance: plateSettings.pressureAdvance,
      linearAdvance: plateSettings.linearAdvance,
      firmware: rules.firmware,
      firmwareArcs: rules.firmwareArcs,
    };
  })(),
  onBelt: false,
  belt: null,
  layerActions: actions,
  overrides,
  includePreview: true,
}));
const fields = new Set([...Object.keys(sessionPlate), ...Object.keys(appPlate)]);
for (const field of fields) {
  check(
    `${field} matches the app builder`,
    JSON.stringify((sessionPlate as Record<string, unknown>)[field]) === JSON.stringify((appPlate as Record<string, unknown>)[field]),
  );
}
check("the plate body has no lone mesh beside objects", !("filename" in sessionPlate) && Array.isArray((sessionPlate as { objects?: unknown }).objects));

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("request: ok");
