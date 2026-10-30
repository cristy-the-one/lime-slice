/** The slice settings a profile or a project stores, compared with the factory defaults. */

import { BRIDGE_LIMITS, readBridgeValue, type BridgeKey } from "./bridge-tune.ts";

export interface PresetSettings {
  blendKind: string;
  strategy: string;
  toughness: number;
  bottomMm: number;
  transitionMm: number;
  axis: string;
  atMm: number;
  layerHeight: number;
  adhesion: "skirt" | "brim" | "mouseEars" | "none";
  brimWidthMm: number;
  brimGapMm: number;
  skirtLoops: number;
  /** `auto` is monotonic on Toughness and rectilinear otherwise. Omitted from a rectilinear slice. */
  topSurfacePattern: "auto" | "rectilinear" | "monotonic" | "concentric";
  /** Millimetres. `0` is omitted from a slice. Positive widens holes. */
  xyHoleCompensationMm: number;
  /** Millimetres. `0` is omitted. Positive grows the outer contour. */
  xyContourCompensationMm: number;
  /** Millimetres. `0` is omitted. Insets the first layer. */
  elephantsFootCompensationMm: number;
  adaptive: boolean;
  adaptiveMin: number;
  adaptiveMax: number;
  supports: boolean;
  supportAngle: number;
  supportStyle: string;
  /** What asks for supports while they are on: the overhang angle ("auto") or paint alone ("paint"). */
  supportSource: string;
  branchAngle: number;
  tipDiameter: number;
  trunkDiameter: number;
  /** Off unless the slice asks. Omitted from the request while off. */
  supportAvoidance: boolean;
  /** A tip under every tree interface row on a belt. Off unless the slice asks, and omitted from the request while off. */
  supportStrictStacking: boolean;
  /** Enforce paint also fills the gaps between its dabs where the part faces down. */
  supportPaintJoin: boolean;
  /** Print every support gently: slower, at a lower acceleration, and retracting off each support. Omitted while off. */
  supportSlowFragile: boolean;
  /** mm/s under gentle supports. `null` is Auto: omitted, and the engine keeps 40. */
  supportGentleSpeedMmS: number | null;
  /** mm/s² under gentle supports. `null` is Auto: omitted, and the engine keeps 2000. */
  supportGentleAccelMmS2: number | null;
  supportHeightMult: number;
  /** Millimetres. `null` is Auto: omitted, and the engine keeps the layer height, at least 0.12 mm. `0` is a real zero. */
  supportZGapMm: number | null;
  /** Millimetres. `null` is Auto: omitted, and the engine keeps 0.55 mm. `0` is a real zero. */
  supportXyGapMm: number | null;
  /** `null` is Auto: omitted, and the engine keeps 3 dense layers. `0` is sent as the fewest there can be, 1. */
  supportInterfaceLayers: number | null;
  /**
   * Tells a file that stores `null` for Auto from one written before Auto existed, where `0` meant Auto.
   * Always `true`. A settings object without it has each `0` of the three support interface keys read as Auto.
   */
  supportGapsAuto: true;
  /** Millimetres of brim under the supports, on the bed or the belt, for every style. `0` is omitted. */
  supportTreeBrimMm: number;
  infillCombine: boolean;
  /** Skin on slopes so shallow that each layer steps past the walls. Off unless asked, and omitted from the request while off. */
  shallowSkins: boolean;
  /** Solid skin under walls that stand on the interior of the layer below. Off unless asked, and omitted from the request while off. */
  solidUnderWalls: boolean;
  combing: boolean;
  featureSpeeds: boolean;
  pressureAdvance: number;
  linearAdvance: number;
  /** Extrusion multiplier. `1` is omitted from a slice. */
  flow: number;
  /** Off keeps the strategy retract length and 30 mm/s. */
  retractOn: boolean;
  retractLength: number;
  retractSpeed: number;
  variableWidth: boolean;
  arcFit: boolean;
  travelOpt: boolean;
  overhangControl: boolean;
  /** Ratio of normal flow, 0.2–2. `null` is Auto: omitted, and the engine keeps 1. Files from before Auto stored `0` for it. */
  bridgeFlowRatio: number | null;
  /** Millimetres per second, 5–200. `null` is Auto: omitted, and the engine keeps the 18–36 mm/s slowdown. Older files stored `0`. */
  bridgeSpeedMmS: number | null;
  /** Percent, 1–100. `null` is Auto: omitted, and bridges take the overhang fan. Older files stored `0`. */
  bridgeFanPercent: number | null;
  seam: string;
  /** Off until the user asks. The slice body does not carry this yet. */
  ironing: boolean;
  /** Fraction of a normal top line. 0.1 is 10%. */
  ironingFlow: number;
  /** Millimetres per second. */
  ironingSpeed: number;
  /** Millimetres between ironing lines. */
  ironingSpacing: number;
  /** Off until the user asks. Omitted from the slice body while off. */
  fuzzySkin: boolean;
  /** Peak offset either side of an outer wall, millimetres. */
  fuzzyThickness: number;
  /** Millimetres between fuzzy-skin points. */
  fuzzyPointDistance: number;
  scarfSeam: string;
  scarfLength: number;
  scarfSteps: number;
  gyroid3d: string;
  zHop: string;
  zHopHeight: number;
  zHopMinTravel: number;
  /** A layer that would print faster than this many seconds is slowed to take it. 0 is off. */
  minLayerTimeS: number;
  /** The slowest feed, mm/s, a slowed layer prints at. */
  minLayerSpeedMmS: number;
  pricePerKg: number;
  simplify: boolean;
  simplifyError: number;
}

export const DEFAULT_PRESET: PresetSettings = {
  blendKind: "single",
  strategy: "speed",
  toughness: 0.5,
  bottomMm: 4,
  transitionMm: 6,
  axis: "x",
  atMm: 10,
  layerHeight: 0.2,
  adhesion: "skirt",
  brimWidthMm: 5,
  brimGapMm: 0.1,
  skirtLoops: 0,
  topSurfacePattern: "auto",
  xyHoleCompensationMm: 0,
  xyContourCompensationMm: 0,
  elephantsFootCompensationMm: 0,
  adaptive: false,
  adaptiveMin: 0.08,
  adaptiveMax: 0.2,
  supports: false,
  supportAngle: 45,
  supportStyle: "tree",
  supportSource: "auto",
  branchAngle: 40,
  tipDiameter: 0.8,
  trunkDiameter: 4.2,
  supportAvoidance: false,
  supportStrictStacking: false,
  supportPaintJoin: true,
  supportSlowFragile: false,
  supportGentleSpeedMmS: null,
  supportGentleAccelMmS2: null,
  supportHeightMult: 1,
  supportZGapMm: null,
  supportXyGapMm: null,
  supportInterfaceLayers: null,
  supportGapsAuto: true,
  supportTreeBrimMm: 0,
  infillCombine: true,
  shallowSkins: false,
  solidUnderWalls: false,
  combing: true,
  featureSpeeds: true,
  pressureAdvance: 0,
  linearAdvance: 0,
  flow: 1,
  retractOn: false,
  retractLength: 0.4,
  retractSpeed: 30,
  variableWidth: true,
  arcFit: true,
  travelOpt: true,
  overhangControl: true,
  bridgeFlowRatio: null,
  bridgeSpeedMmS: null,
  bridgeFanPercent: null,
  seam: "blend",
  ironing: false,
  ironingFlow: 0.1,
  ironingSpeed: 20,
  ironingSpacing: 0.1,
  fuzzySkin: false,
  fuzzyThickness: 0.3,
  fuzzyPointDistance: 0.8,
  scarfSeam: "blend",
  scarfLength: 10,
  scarfSteps: 8,
  gyroid3d: "blend",
  zHop: "blend",
  zHopHeight: 0.4,
  zHopMinTravel: 2,
  minLayerTimeS: 0,
  minLayerSpeedMmS: 15,
  pricePerKg: 20,
  simplify: true,
  simplifyError: 0,
};

export function presetKeys(): (keyof PresetSettings)[] {
  return Object.keys(DEFAULT_PRESET) as (keyof PresetSettings)[];
}

/** Keys added after project and profile files were versioned. A file written before one reads its default. */
export const LATER_KEYS: ReadonlySet<keyof PresetSettings> = new Set(["seam", "ironing", "ironingFlow", "ironingSpeed", "ironingSpacing", "fuzzySkin", "fuzzyThickness", "fuzzyPointDistance", "flow", "retractOn", "retractLength", "retractSpeed", "supportAvoidance", "supportStrictStacking", "supportPaintJoin", "shallowSkins", "supportSlowFragile", "supportGentleSpeedMmS", "supportGentleAccelMmS2", "solidUnderWalls", "supportSource", "minLayerTimeS", "minLayerSpeedMmS", "adhesion", "brimWidthMm", "brimGapMm", "skirtLoops", "topSurfacePattern", "xyHoleCompensationMm", "xyContourCompensationMm", "elephantsFootCompensationMm", "supportZGapMm", "supportXyGapMm", "supportInterfaceLayers", "supportTreeBrimMm", "bridgeFlowRatio", "bridgeSpeedMmS", "bridgeFanPercent"]);

/** Settings that are Auto (`null`) until set. Before Auto existed they stored `0` for it, which `readPresetSettings` still reads that way. */
const AUTO_KEYS: ReadonlySet<keyof PresetSettings> = new Set(["supportZGapMm", "supportXyGapMm", "supportInterfaceLayers"]);

/** Settings that are Auto (`null`) until set, and were added with Auto. */
const NULLABLE_KEYS: ReadonlySet<keyof PresetSettings> = new Set(["supportGentleSpeedMmS", "supportGentleAccelMmS2"]);

function isBridgeKey(key: keyof PresetSettings): key is BridgeKey {
  return Object.hasOwn(BRIDGE_LIMITS, key);
}

/** The preset a project or profile file stores, or null when a key is missing or has the wrong type. */
export function readPresetSettings(value: unknown): PresetSettings | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const legacy = row.supportGapsAuto !== true;
  const out = { ...DEFAULT_PRESET };
  for (const key of presetKeys()) {
    const got = row[key];
    if (key === "supportGapsAuto") continue;
    if (isBridgeKey(key)) {
      const kept = readBridgeValue(key, got);
      if (kept === undefined) return null;
      out[key] = kept;
      continue;
    }
    if (AUTO_KEYS.has(key) || NULLABLE_KEYS.has(key)) {
      if (got === undefined || got === null || (legacy && got === 0 && AUTO_KEYS.has(key))) continue;
      if (typeof got !== "number" || !Number.isFinite(got)) return null;
      (out as unknown as Record<string, unknown>)[key] = got;
      continue;
    }
    if (got === undefined && LATER_KEYS.has(key)) continue;
    if (typeof got !== typeof DEFAULT_PRESET[key]) return null;
    (out as unknown as Record<string, unknown>)[key] = got;
  }
  out.supportGapsAuto = true;
  return out;
}

/** Where presets lived before settings profiles. Read once, migrated, then removed. */
export const LEGACY_PRESETS_KEY = "lime-slice-presets";

/** The presets a pre-profile store held, by name. Rows that are not a preset are left out. */
export function parseLegacyPresets(text: string | null): Record<string, PresetSettings> {
  if (!text) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, PresetSettings> = {};
    for (const [name, row] of Object.entries(parsed as Record<string, unknown>)) {
      const preset = readPresetSettings({ ...DEFAULT_PRESET, supportGapsAuto: undefined, ...(row && typeof row === "object" ? (row as object) : {}) });
      if (preset && name.trim()) out[name.trim()] = preset;
    }
    return out;
  } catch {
    return {};
  }
}

export function changedPresetKeys(current: PresetSettings, base: PresetSettings = DEFAULT_PRESET): (keyof PresetSettings)[] {
  return presetKeys().filter((key) => current[key] !== base[key]);
}
