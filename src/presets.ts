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
  variableWidth: boolean;
  arcFit: boolean;
  travelOpt: boolean;
  overhangControl: boolean;
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
  variableWidth: true,
  arcFit: true,
  travelOpt: true,
  overhangControl: true,
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
  variableWidth: "Variable walls",
  arcFit: "Arc fit",
  travelOpt: "Travel and seam",
  overhangControl: "Overhang control",
  scarfSeam: "Scarf seam",
  scarfLength: "Scarf length",
  scarfSteps: "Scarf steps",
  gyroid3d: "3D gyroid",
  zHop: "Z-hop",
  zHopHeight: "Hop height",
  zHopMinTravel: "Hop travel",
  pricePerKg: "Filament €/kg",
  autoSlice: "Auto-slice",
  simplify: "Simplify to nozzle",
  simplifyError: "Simplify error mm",
};

export function presetKeys(): (keyof PresetSettings)[] {
  return Object.keys(DEFAULT_PRESET) as (keyof PresetSettings)[];
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

export function diffPreset(current: PresetSettings, base: PresetSettings = DEFAULT_PRESET): string[] {
  const lines: string[] = [];
  for (const key of presetKeys()) {
    if (current[key] === base[key]) continue;
    lines.push(`${LABELS[key]}: ${formatVal(current[key])} (default ${formatVal(base[key])})`);
  }
  return lines;
}

function formatVal(value: string | number | boolean) {
  if (typeof value === "boolean") return value ? "on" : "off";
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
  return value;
}
