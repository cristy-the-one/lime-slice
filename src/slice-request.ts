/**
 * The slice body the app and the MCP server both send.
 * `payload()` in the app fills this from the open plate. The server fills it from the session.
 */
import { adhesionSliceFields } from "./adhesion.ts";
import type { BeltSettings } from "./belt.ts";
import { beltSliceField } from "./belt.ts";
import { bridgeSliceFields } from "./bridge-tune.ts";
import { flowSliceField } from "./flow.ts";
import { sliceFuzzyFields } from "./fuzzy-skin.ts";
import { ironingSpacingMax, sliceIroningFields } from "./ironing.ts";
import { layerActionFields, type LayerAction } from "./layer-actions.ts";
import { sliceOverrideFields, type OverrideDocument } from "./overrides.ts";
import type { PresetSettings } from "./presets.ts";
import { seamSliceField, type SeamChoice } from "./seam.ts";
import { avoidanceSliceField } from "./support-avoidance.ts";
import { supportSliceFields } from "./support-interface.ts";
import { supportSourceSliceField } from "./support-source.ts";
import { surfaceSliceField } from "./surface-pattern.ts";
import { xySliceFields } from "./xy-comp.ts";

function seamChoice(value: string): SeamChoice {
  if (value === "nearest" || value === "aligned" || value === "rear") return value;
  return "blend";
}

/** Retraction as the slice request sends it. Off is omitted. Speed is omitted at the 30 mm/s default. */
export function retractFields(on: boolean, length: number, speed: number): { retractLength?: number; retractSpeed?: number } {
  if (!on) return {};
  const clamped = Math.min(5, Math.max(0, Math.round(length * 1000) / 1000));
  const out: { retractLength: number; retractSpeed?: number } = { retractLength: clamped };
  if (Number.isFinite(speed) && Math.abs(speed - 30) > 1e-6) out.retractSpeed = Math.min(80, Math.max(5, Math.round(speed)));
  return out;
}

export interface SliceRequestInput {
  /** The mesh, and any paint or support edits that belong on a one-object slice. */
  one: Record<string, unknown>;
  /** A multi-object plate. Empty for one object. */
  plate: Record<string, unknown>;
  /** Print order fields, already passed through the machine's rules. */
  order: { printOrder?: string; sequentialClearanceMm?: number; sequentialGantryMm?: number };
  settings: PresetSettings;
  stepToleranceMm: number;
  lineWidth: number;
  blend: unknown;
  printer: unknown;
  onBelt: boolean;
  belt: BeltSettings | null;
  layerActions: readonly LayerAction[];
  overrides: OverrideDocument;
  includePreview: boolean;
}

/** The object `rules.coerce` turns into the engine's request. Field order matches the app's previous body. */
export function sliceRequest(input: SliceRequestInput): Record<string, unknown> {
  const settings = input.settings;
  const lineWidth = input.lineWidth;
  return {
    ...input.one,
    stepToleranceMm: input.stepToleranceMm,
    layerHeight: settings.layerHeight,
    ...adhesionSliceFields(
      { adhesion: settings.adhesion, brimWidthMm: settings.brimWidthMm, brimGapMm: settings.brimGapMm, skirtLoops: settings.skirtLoops },
      input.onBelt,
    ),
    ...surfaceSliceField(settings.topSurfacePattern, settings.blendKind, settings.strategy),
    ...xySliceFields({
      xyHoleCompensationMm: settings.xyHoleCompensationMm,
      xyContourCompensationMm: settings.xyContourCompensationMm,
      elephantsFootCompensationMm: settings.elephantsFootCompensationMm,
    }),
    lineWidth,
    blend: input.blend,
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
    printer: input.printer,
    ...flowSliceField(settings.flow),
    ...retractFields(settings.retractOn, settings.retractLength, settings.retractSpeed),
    minLayerTimeS: Math.min(600, Math.max(0, settings.minLayerTimeS)),
    minLayerSpeedMmS: Math.min(300, Math.max(1, settings.minLayerSpeedMmS)),
    ...beltSliceField(input.belt, settings.supports),
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
    ...layerActionFields(input.layerActions),
    ...seamSliceField(seamChoice(settings.seam)),
    ...sliceIroningFields({
      on: settings.ironing,
      flow: settings.ironingFlow,
      speed: settings.ironingSpeed,
      spacing: Math.min(settings.ironingSpacing, ironingSpacingMax(lineWidth)),
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
    includePreview: input.includePreview,
    simplify: settings.simplify,
    simplifyErrorMm: settings.simplifyError,
    ...sliceOverrideFields(input.overrides),
    ...input.plate,
    ...input.order,
  };
}
