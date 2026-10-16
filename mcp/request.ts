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
import { adhesionSliceFields } from "../src/adhesion.ts";
import { bytesToBase64 } from "../src/base64.ts";
import { beltSliceField } from "../src/belt.ts";
import { bridgeSliceFields } from "../src/bridge-tune.ts";
import { flowSliceField } from "../src/flow.ts";
import { sliceFuzzyFields } from "../src/fuzzy-skin.ts";
import { sliceIroningFields } from "../src/ironing.ts";
import { layerActionFields, type LayerAction } from "../src/layer-actions.ts";
import { encodeStl, scaledCanonical, type Mat3, type RigidPose } from "../src/mesh-place.ts";
import type { PresetSettings } from "../src/presets.ts";
import { seamSliceField } from "../src/seam.ts";
import { settingsRules } from "../src/settings-rules.ts";
import { supportSourceSliceField } from "../src/support-source.ts";
import { avoidanceSliceField } from "../src/support-avoidance.ts";
import { supportSliceFields } from "../src/support-interface.ts";
import { surfaceSliceField } from "../src/surface-pattern.ts";
import { enginePrinter, heatFor, type FilamentRecord, type PrinterRecord } from "../src/ui/machine-library.ts";
import { xySliceFields } from "../src/xy-comp.ts";

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
  const settings = input.settings;
  const libraryBelt = input.printer.kind === "belt" ? input.printer.belt : null;
  return rules.coerce({
    filename: input.filename,
    dataB64: bytesToBase64(input.bytes),
    ...(input.pose ? { pose: input.pose } : {}),
    stepToleranceMm: 0.05,
    layerHeight: settings.layerHeight,
    lineWidth,
    blend: blendOf(settings),
    ...adhesionSliceFields(
      { adhesion: settings.adhesion, brimWidthMm: settings.brimWidthMm, brimGapMm: settings.brimGapMm, skirtLoops: settings.skirtLoops },
      libraryBelt !== null,
    ),
    ...surfaceSliceField(settings.topSurfacePattern, settings.blendKind, settings.strategy),
    ...xySliceFields({
      xyHoleCompensationMm: settings.xyHoleCompensationMm,
      xyContourCompensationMm: settings.xyContourCompensationMm,
      elephantsFootCompensationMm: settings.elephantsFootCompensationMm,
    }),
    adaptive: settings.adaptive,
    adaptiveMin: settings.adaptiveMin,
    adaptiveMax: settings.adaptiveMax,
    supports: settings.supports,
    supportAngle: settings.supportAngle,
    supportStyle: settings.supportStyle,
    branchAngle: settings.branchAngle,
    tipDiameter: settings.tipDiameter,
    trunkDiameter: settings.trunkDiameter,
    supportHeightMult: settings.supportHeightMult,
    ...avoidanceSliceField(settings.supports && settings.supportStyle === "tree" && settings.supportAvoidance),
    ...supportSliceFields({
      supports: settings.supports,
      supportStyle: settings.supportStyle,
      supportZGapMm: settings.supportZGapMm,
      supportXyGapMm: settings.supportXyGapMm,
      supportInterfaceLayers: settings.supportInterfaceLayers,
      supportTreeBrimMm: settings.supportTreeBrimMm,
    }),
    ...supportSourceSliceField(settings.supports, settings.supportSource),
    infillCombine: settings.infillCombine,
    combing: settings.combing,
    featureSpeeds: settings.featureSpeeds,
    printer: {
      ...profile,
      nozzleTemp: heat.nozzleC,
      bedTemp: heat.bedC,
      pressureAdvance: settings.pressureAdvance,
      linearAdvance: settings.linearAdvance,
      firmware: rules.firmware,
      firmwareArcs: rules.firmwareArcs,
    },
    ...flowSliceField(settings.flow),
    ...(settings.retractOn ? { retractLength: settings.retractLength } : {}),
    minLayerTimeS: Math.min(600, Math.max(0, settings.minLayerTimeS)),
    minLayerSpeedMmS: Math.min(300, Math.max(1, settings.minLayerSpeedMmS)),
    ...beltSliceField(libraryBelt, settings.supports),
    variableWidth: settings.variableWidth,
    arcFit: settings.arcFit,
    travelOpt: settings.travelOpt,
    overhangControl: settings.overhangControl,
    ...bridgeSliceFields({
      overhangControl: settings.overhangControl,
      bridgeFlowRatio: settings.bridgeFlowRatio,
      bridgeSpeedMmS: settings.bridgeSpeedMmS,
      bridgeFanPercent: settings.bridgeFanPercent,
    }),
    ...layerActionFields(input.actions),
    ...seamSliceField(settings.seam),
    ...sliceIroningFields({
      on: settings.ironing,
      flow: settings.ironingFlow,
      speed: settings.ironingSpeed,
      spacing: settings.ironingSpacing,
    }),
    ...sliceFuzzyFields({ on: settings.fuzzySkin, thickness: settings.fuzzyThickness, pointDistance: settings.fuzzyPointDistance }),
    scarfSeam: settings.scarfSeam,
    scarfLength: settings.scarfLength,
    scarfSteps: settings.scarfSteps,
    scarfStartHeight: 0.15,
    scarfStartFlow: 0.55,
    gyroid3d: settings.gyroid3d,
    zHop: settings.zHop,
    zHopHeight: settings.zHopHeight,
    zHopMinTravel: settings.zHopMinTravel,
    baseline: false,
    compare: false,
    includeGcode: false,
    includePreview: false,
    simplify: settings.simplify,
    simplifyErrorMm: settings.simplifyError,
  });
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
