/**
 * Slice bodies.
 *
 * `cliSliceRequest` is the JSON form of the request `lime-slice slice` builds
 * for the six `tools/golden.sh` configs. The CLI constructs that struct in
 * Rust; this object deserializes to the same one. Omitted fields use the
 * engine's serde defaults, which `SliceSettings::from_request` reads the same
 * way, except `supportHeightMult`: the CLI sends 1 and a missing field is 0.
 * The golden config named `grid` is `--blend speed --supports`. The CLI's
 * support style stays `tree` unless `--support-style grid` is passed, and
 * that flag is not in `tools/golden.sh`.
 *
 * `sessionSliceRequest` is the plate slice the tools send. It uses the same
 * field helpers as the app (`settingsRules`, adhesion, seam, flow, layer
 * actions) and the built-in machine library. That request is not the CLI's:
 * the app centres a posed mesh and sends the library printer, fan, and firmware.
 */
import { bytesToBase64 } from "../src/base64.ts";
import { encodeStl, type Mat3, type RigidPose } from "../src/mesh-place.ts";
import { emptyOverrides } from "../src/overrides.ts";
import type { PresetSettings } from "../src/presets.ts";
import { settingsRules } from "../src/settings-rules.ts";
import { sliceRequest } from "../src/slice-request.ts";
import { nextSplitAt, type AxisBounds } from "../src/split-at.ts";
import type { LayerAction } from "../src/layer-actions.ts";
import { enginePrinter, heatFor, type FilamentRecord, type PrinterRecord } from "../src/ui/machine-library.ts";

export type GoldenConfig = "speed" | "tough" | "region" | "grid" | "tree" | "adaptive";

const CLI_PRINTER = {
  name: "Generic Marlin 0.4 mm PLA",
  nozzleDiameter: 0.4,
  filamentDiameter: 1.75,
  nozzleTemp: 200,
  bedTemp: 60,
  bedX: 220,
  bedY: 220,
};

export function cliBlend(config: GoldenConfig, atMm: number): Record<string, unknown> {
  if (config === "speed" || config === "grid") return { mode: "single", strategy: "speed" };
  if (config === "tough" || config === "tree") return { mode: "single", strategy: "toughness" };
  if (config === "adaptive") return { mode: "byLayer", bottomMm: 4, transitionMm: 6 };
  return { mode: "byRegion", axis: "x", atMm };
}

/** The request body whose G-code matches `lime-slice slice` for one golden config. */
export function cliSliceRequest(filename: string, dataB64: string, config: GoldenConfig, atMm: number): Record<string, unknown> {
  return {
    filename,
    dataB64,
    blend: cliBlend(config, atMm),
    printer: CLI_PRINTER,
    supports: config === "grid" || config === "tree",
    ...(config === "adaptive" ? { adaptive: true } : {}),
    supportHeightMult: 1,
    baseline: false,
    includeGcode: true,
    includePreview: true,
  };
}

export function sessionSliceRequest(input: {
  filename: string;
  bytes: Uint8Array;
  pose: RigidPose | null;
  settings: PresetSettings;
  printer: PrinterRecord;
  filament: FilamentRecord;
  nozzleMm: number;
  actions: readonly LayerAction[];
  objects: number;
  bounds: AxisBounds | null;
  stepToleranceMm: number;
}): Record<string, unknown> {
  const rules = settingsRules({
    kind: input.printer.kind,
    belt: { raftLayers: input.printer.belt.raftLayers, maxLengthMm: input.printer.belt.maxLengthMm },
    firmware: input.printer.firmware,
    firmwareArcs: input.printer.firmwareArcs,
    objects: input.objects,
    supportMode: input.settings.supportSource === "paint" ? "paint" : "auto",
  });
  const built = enginePrinter(input.printer, input.filament, input.nozzleMm);
  const heat = heatFor(input.printer, input.filament.nozzleTemp, input.filament.bedTemp);
  const { filamentDensityGCm3: _density, filamentCostPerKg: _cost, ...profile } = built;
  const lineWidth = Math.min(1.2, Math.max(0.2, input.nozzleMm * 1.125));
  const settings = { ...input.settings };
  if (settings.blendKind === "byRegion" && input.bounds) {
    settings.atMm = nextSplitAt("open", settings.atMm, input.bounds, settings.axis === "y" ? "y" : "x", false);
  }
  const libraryBelt = input.printer.kind === "belt" ? input.printer.belt : null;
  return rules.coerce(sliceRequest({
    one: {
      filename: input.filename,
      dataB64: bytesToBase64(input.bytes),
      ...(input.pose ? { pose: input.pose } : {}),
    },
    plate: {},
    order: {},
    settings,
    stepToleranceMm: input.stepToleranceMm,
    lineWidth,
    blend: blendOf(settings),
    printer: {
      ...profile,
      nozzleTemp: heat.nozzleC,
      bedTemp: heat.bedC,
      pressureAdvance: settings.pressureAdvance,
      linearAdvance: settings.linearAdvance,
      firmware: rules.firmware,
      firmwareArcs: rules.firmwareArcs,
    },
    onBelt: libraryBelt !== null,
    belt: libraryBelt,
    layerActions: input.actions,
    overrides: emptyOverrides(),
    includePreview: true,
  }));
}

export function blendOf(settings: PresetSettings): Record<string, unknown> {
  if (settings.blendKind === "single") return { mode: "single", strategy: settings.strategy };
  if (settings.blendKind === "weight") return { mode: "weight", toughness: settings.toughness };
  if (settings.blendKind === "byLayer") return { mode: "byLayer", bottomMm: settings.bottomMm, transitionMm: settings.transitionMm };
  return { mode: "byRegion", axis: settings.axis, atMm: settings.atMm };
}

export function applyPreset(settings: PresetSettings, preset: string): PresetSettings {
  const next = { ...settings };
  if (preset === "speed") {
    next.blendKind = "single";
    next.strategy = "speed";
  } else if (preset === "toughness") {
    next.blendKind = "single";
    next.strategy = "toughness";
  } else if (preset === "efficiency") {
    next.blendKind = "weight";
    next.toughness = 0.5;
  } else if (preset === "layer") {
    next.blendKind = "byLayer";
  } else if (preset === "region") {
    next.blendKind = "byRegion";
  }
  return next;
}

export function stlBytes(positions: Float32Array, name: string): Uint8Array {
  return new Uint8Array(encodeStl(positions, name));
}

export type { Mat3 };
