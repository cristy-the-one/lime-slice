/** Named slice presets in localStorage, compared with the factory defaults. */

export interface PresetSettings {
  blendKind: string;
  strategy: string;
  toughness: number;
  bottomMm: number;
  transitionMm: number;
  axis: string;
  atMm: number;
  layerHeight: number;
  adaptive: boolean;
  adaptiveMin: number;
  adaptiveMax: number;
  supports: boolean;
  supportAngle: number;
  supportStyle: string;
  branchAngle: number;
  tipDiameter: number;
  trunkDiameter: number;
  supportHeightMult: number;
  infillCombine: boolean;
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
  pricePerKg: number;
  autoSlice: boolean;
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
  adaptive: false,
  adaptiveMin: 0.08,
  adaptiveMax: 0.2,
  supports: false,
  supportAngle: 45,
  supportStyle: "tree",
  branchAngle: 40,
  tipDiameter: 0.8,
  trunkDiameter: 4.2,
  supportHeightMult: 1,
  infillCombine: true,
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
  pricePerKg: 20,
  autoSlice: false,
  simplify: true,
  simplifyError: 0,
};

const KEY = "lime-slice-presets";
const LABELS: Record<keyof PresetSettings, string> = {
  blendKind: "Blend",
  strategy: "Strategy",
  toughness: "Toughness weight",
  bottomMm: "Toughness band mm",
  transitionMm: "Transition mm",
  axis: "Split axis",
  atMm: "Split at mm",
  layerHeight: "Layer height",
  adaptive: "Adaptive layers",
  adaptiveMin: "Adaptive min",
  adaptiveMax: "Adaptive max",
  supports: "Supports",
  supportAngle: "Support angle",
  supportStyle: "Support style",
  branchAngle: "Branch angle",
  tipDiameter: "Tip diameter",
  trunkDiameter: "Trunk diameter",
  supportHeightMult: "Shaft height ×",
  infillCombine: "Combine infill",
  combing: "Combing",
  featureSpeeds: "Feature speeds",
  pressureAdvance: "Pressure advance",
  linearAdvance: "Linear advance",
  flow: "Flow",
  retractOn: "Custom retraction",
  retractLength: "Retract length",
  retractSpeed: "Retract speed",
  variableWidth: "Variable walls",
  arcFit: "Arc fit",
  travelOpt: "Travel and seam",
  overhangControl: "Overhang control",
  seam: "Seam position",
  ironing: "Ironing",
  ironingFlow: "Ironing flow",
  ironingSpeed: "Ironing speed",
  ironingSpacing: "Ironing spacing",
  fuzzySkin: "Fuzzy skin",
  fuzzyThickness: "Fuzzy thickness",
  fuzzyPointDistance: "Fuzzy point spacing",
  scarfSeam: "Scarf seam",
  scarfLength: "Scarf length",
  scarfSteps: "Scarf steps",
  gyroid3d: "3D gyroid",
  zHop: "Z-hop",
  zHopHeight: "Hop height",
  zHopMinTravel: "Hop travel",
  pricePerKg: "Filament €/kg",
  autoSlice: "Auto-slice",
  simplify: "Simplify outlines",
  simplifyError: "Outline tolerance mm",
};

export function presetKeys(): (keyof PresetSettings)[] {
  return Object.keys(DEFAULT_PRESET) as (keyof PresetSettings)[];
}

/** Keys added after project and profile files were versioned. A file written before one reads its default. */
const LATER_KEYS: ReadonlySet<keyof PresetSettings> = new Set(["seam", "ironing", "ironingFlow", "ironingSpeed", "ironingSpacing", "fuzzySkin", "fuzzyThickness", "fuzzyPointDistance", "flow", "retractOn", "retractLength", "retractSpeed"]);

/** The preset a project or profile file stores, or null when a key is missing or has the wrong type. */
export function readPresetSettings(value: unknown): PresetSettings | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const out = { ...DEFAULT_PRESET };
  for (const key of presetKeys()) {
    const got = row[key];
    if (got === undefined && LATER_KEYS.has(key)) continue;
    if (typeof got !== typeof DEFAULT_PRESET[key]) return null;
    (out as unknown as Record<string, unknown>)[key] = got;
  }
  return out;
}

export function readPresets(): Record<string, PresetSettings> {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, PresetSettings>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function writePresets(all: Record<string, PresetSettings>) {
  localStorage.setItem(KEY, JSON.stringify(all));
}

export function changedPresetKeys(current: PresetSettings, base: PresetSettings = DEFAULT_PRESET): (keyof PresetSettings)[] {
  return presetKeys().filter((key) => current[key] !== base[key]);
}

export function diffPreset(current: PresetSettings, base: PresetSettings = DEFAULT_PRESET): string[] {
  return changedPresetKeys(current, base).map(
    (key) => `${LABELS[key]}: ${formatVal(current[key])} (default ${formatVal(base[key])})`,
  );
}

function formatVal(value: string | number | boolean) {
  if (typeof value === "boolean") return value ? "on" : "off";
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
  return value;
}
