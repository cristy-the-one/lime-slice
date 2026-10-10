/**
 * The one table of settings controls. The left panel renders its groups from it, the search
 * reads its labels and keywords, the tier filter reads its tiers, the modified dots read its
 * preset keys, and `onSettings` stores a value through its `set`.
 *
 * `get` and `set` take the app state; nothing here touches the document, so the table is
 * checked in a plain Node test. Controls that are not a field (object list, strategy rows,
 * machine section, tool buttons) are `custom` slots the panel fills from its own renderers.
 */
import type { state } from "../app/state.ts";
import type { PresetSettings } from "../presets.ts";
import type { SettingsLevel } from "../project.ts";
import type { ControlId } from "../settings-rules.ts";
import { seamOptions } from "../seam.ts";
import { ironingFlowPercent, ironingSpacingMax, readIroningFlowPercent, readIroningSpacing, readIroningSpeed } from "../ironing.ts";
import { readFuzzyPointDistance, readFuzzyThickness } from "../fuzzy-skin.ts";
import { saveAutoSlice } from "../auto-slice-pref.ts";

export type Settings = typeof state;
export type Tier = SettingsLevel;
export type GroupId = "strategy" | "objects" | "quality" | "walls" | "infill" | "speed" | "supports" | "printer" | "calibrate" | "gear";

/** What a control's options or limits may depend on. */
export interface SchemaContext {
  belt: boolean;
  lineWidth: number;
}

export type Options = [string, string][];

export type ControlKind =
  | { type: "number"; min: number; max: number | ((ctx: SchemaContext) => number); step: number }
  | { type: "range"; min: number; max: number; step: number }
  | { type: "check" }
  | { type: "select"; options: Options | ((ctx: SchemaContext) => Options) }
  | { type: "custom" };

export interface ControlSpec {
  /** DOM id. The e2e specs address controls by it. */
  id: string;
  label: string;
  group: GroupId;
  tier: Tier;
  kind: ControlKind;
  /** Rendered indented under this control. */
  parent?: string;
  /** Rendered only while this holds. A parent that is off hides its children. */
  when?: (s: Settings) => boolean;
  /** Hidden when `settingsRules(...).hidden` has it. */
  rule?: ControlId;
  tip?: string;
  /** Extra search words. The label matches on its own. */
  keywords?: string;
  /** The preset key the control edits. The modified dot compares it with the factory default. */
  preset?: keyof PresetSettings;
  get?: (s: Settings) => number | boolean | string;
  set?: (s: Settings, value: number | boolean | string) => void;
  /** A change shows or hides other controls, so the panel is rendered again. */
  structural?: boolean;
}

export interface GroupSpec {
  id: GroupId;
  title: string;
  /** The group shows from this tier up. */
  tier: Tier;
  /** The `--group-*` token of the header tick. */
  accent: string;
  /** Closed until the user opens it. Collapse state is then remembered. */
  closed?: boolean;
  /** One line of the current values for the header. */
  summary: (s: Settings, ctx: SchemaContext) => string;
}

const TIER_RANK: Record<Tier, number> = { simple: 0, advanced: 1, expert: 2 };

export function shownAtLevel(tier: Tier, level: Tier): boolean {
  return TIER_RANK[tier] <= TIER_RANK[level];
}

const num = (min: number, max: number | ((ctx: SchemaContext) => number), step: number): ControlKind => ({ type: "number", min, max, step });
const check: ControlKind = { type: "check" };
const select = (options: Options | ((ctx: SchemaContext) => Options)): ControlKind => ({ type: "select", options });
const custom: ControlKind = { type: "custom" };

/** A control bound to one preset key of the state. */
function bound<K extends keyof PresetSettings>(key: K, spec: Omit<ControlSpec, "preset" | "get" | "set">): ControlSpec {
  return {
    ...spec,
    preset: key,
    get: (s) => s[key] as number | boolean | string,
    set: (s, value) => {
      (s as unknown as Record<string, unknown>)[key] = value;
    },
  };
}

/** A control bound to one number of the printer profile. */
function profile(key: "bedX" | "bedY" | "bedZ" | "maxVolumetricMm3S" | "maxAccel" | "filamentDensityGCm3" | "filamentCostPerKg", spec: Omit<ControlSpec, "get" | "set">): ControlSpec {
  return { ...spec, get: (s) => s.profile[key], set: (s, value) => { s.profile[key] = value as number; } };
}

const blendOptions: Options = [["blend", "Blend default"], ["off", "Off"], ["outer", "Outer walls"], ["all", "Outer and inner"]];

export const GROUPS: GroupSpec[] = [
  {
    id: "strategy",
    title: "Strategy",
    tier: "simple",
    accent: "--group-strategy",
    summary: (s) => STRATEGY_ROWS.find((row) => row.id === strategyCard(s))?.name ?? "",
  },
  {
    id: "objects",
    title: "Objects",
    tier: "simple",
    accent: "--group-objects",
    summary: (s) => {
      const n = Math.max(1, s.plate.objects.length);
      return s.placed ? `${n} on plate` : "";
    },
  },
  {
    id: "quality",
    title: "Quality",
    tier: "simple",
    accent: "--group-quality",
    summary: (s) => `${s.layerHeight.toFixed(2)} mm${s.adaptive ? " · adaptive" : ""}`,
  },
  {
    id: "walls",
    title: "Walls & surface",
    tier: "simple",
    accent: "--group-walls",
    summary: (s) => {
      const on = [s.ironing && "ironing", s.fuzzySkin && "fuzzy"].filter(Boolean);
      return `${s.seam} seam${on.length === 1 ? ` · ${on[0]}` : on.length > 1 ? ` · +${on.length}` : ""}`;
    },
  },
  {
    id: "infill",
    title: "Infill",
    tier: "advanced",
    accent: "--group-infill",
    summary: (s) => {
      const gyroid = s.gyroid3d === "on" ? "3D gyroid" : s.gyroid3d === "off" ? "2D sine" : "";
      return [gyroid, s.infillCombine ? "combined" : ""].filter(Boolean).join(" · ") || "auto";
    },
  },
  {
    id: "speed",
    title: "Speed & travel",
    tier: "simple",
    accent: "--group-speed",
    summary: (s) => `${s.featureSpeeds ? "per feature" : "one speed"}${s.zHop !== "blend" && s.zHop !== "off" ? " · z-hop" : ""}`,
  },
  {
    id: "supports",
    title: "Supports",
    tier: "simple",
    accent: "--group-supports",
    summary: (s) => (s.supports ? `${s.supportStyle} · ${s.supportAngle}°` : "off"),
  },
  {
    id: "printer",
    title: "Printer details",
    tier: "advanced",
    accent: "--group-printer",
    closed: true,
    summary: (s, ctx) => `${ctx.belt ? "belt" : `${s.profile.bedX} × ${s.profile.bedY}`} · ${s.profile.maxVolumetricMm3S} mm³/s`,
  },
];

/** Groups the left panel renders, in order. Calibrate and gear controls live elsewhere. */
export const PANEL_GROUPS: GroupId[] = GROUPS.map((group) => group.id);

export type StrategyCard = "speed" | "efficiency" | "toughness" | "layer" | "region";

/** `copy` fits the row at the default panel width; `tip` is the full description. */
export const STRATEGY_ROWS: { id: StrategyCard; name: string; copy: string; tip: string; command: string }[] = [
  { id: "speed", name: "Speed", copy: "2 walls · lightning", tip: "2 walls, lightning infill, fast feeds", command: "strategy-speed" },
  { id: "efficiency", name: "Efficiency", copy: "lines, then grid", tip: "A mid weight blend: lines, then grid", command: "strategy-efficiency" },
  { id: "toughness", name: "Toughness", copy: "5 walls · gyroid", tip: "5 walls, 48% 3D gyroid, scarf seam", command: "strategy-toughness" },
  { id: "layer", name: "By layer", copy: "tough base, fast top", tip: "Toughness at the bed, then speed", command: "strategy-layer" },
  { id: "region", name: "By region", copy: "tough side, fast side", tip: "Low side toughness, high side speed", command: "strategy-region" },
];

export function strategyCard(s: Pick<Settings, "blendKind" | "strategy">): StrategyCard {
  if (s.blendKind === "byLayer") return "layer";
  if (s.blendKind === "byRegion") return "region";
  if (s.blendKind === "weight") return "efficiency";
  return s.strategy === "toughness" ? "toughness" : "speed";
}

export const CONTROLS: ControlSpec[] = [
  // Strategy: the rows are a custom slot; the blend parameters are fields under them.
  { id: "strategyRows", label: "Strategy", group: "strategy", tier: "simple", kind: custom },
  {
    id: "weight",
    label: "Toughness weight %",
    group: "strategy",
    tier: "simple",
    kind: { type: "range", min: 0, max: 100, step: 1 },
    when: (s) => s.blendKind === "weight",
    preset: "toughness",
    get: (s) => Math.round(s.toughness * 100),
    set: (s, value) => { s.toughness = (value as number) / 100; },
    keywords: "blend efficiency mix",
  },
  { ...bound("bottomMm", { id: "bottom", label: "Toughness from the bed mm", group: "strategy", tier: "simple", kind: num(0, 200, 0.2), when: (s) => s.blendKind === "byLayer", keywords: "blend layer band" }) },
  { ...bound("transitionMm", { id: "trans", label: "Transition into speed mm", group: "strategy", tier: "simple", kind: num(0, 200, 0.2), when: (s) => s.blendKind === "byLayer", keywords: "blend layer" }) },
  { ...bound("axis", { id: "axis", label: "Split axis", group: "strategy", tier: "simple", kind: select([["x", "X"], ["y", "Y"]]), when: (s) => s.blendKind === "byRegion", keywords: "blend region plane" }) },
  {
    id: "at",
    label: "Split at mm",
    group: "strategy",
    tier: "simple",
    kind: num(-500, 500, 0.1),
    when: (s) => s.blendKind === "byRegion",
    preset: "atMm",
    get: (s) => Number(s.atMm.toFixed(1)),
    set: (s, value) => { s.atMm = value as number; },
    keywords: "blend region plane",
  },

  // Objects
  { id: "objectTools", label: "Objects", group: "objects", tier: "simple", kind: custom },
  { id: "objectList", label: "Object list", group: "objects", tier: "simple", kind: custom },
  { id: "objectPlace", label: "Position and scale", group: "objects", tier: "simple", kind: custom },
  { id: "objectOverrides", label: "Object settings", group: "objects", tier: "advanced", kind: custom },
  { id: "printOrderFields", label: "Print order", group: "objects", tier: "advanced", kind: custom },
  { id: "modifiers", label: "Modifiers", group: "objects", tier: "advanced", kind: custom },

  // Quality
  bound("layerHeight", { id: "lh", label: "Layer height mm", group: "quality", tier: "simple", kind: num(0.08, 0.4, 0.02), keywords: "quality resolution thickness" }),
  bound("adaptive", { id: "adaptive", label: "Adaptive layers", group: "quality", tier: "advanced", kind: check, rule: "adaptive", structural: true, keywords: "variable layer height" }),
  bound("adaptiveMin", { id: "amin", label: "Min mm", group: "quality", tier: "advanced", kind: num(0.04, 0.28, 0.02), parent: "adaptive", when: (s) => s.adaptive, rule: "adaptive", keywords: "variable layer adaptive" }),
  bound("adaptiveMax", { id: "amax", label: "Max mm", group: "quality", tier: "advanced", kind: num(0.08, 0.4, 0.02), parent: "adaptive", when: (s) => s.adaptive, rule: "adaptive", keywords: "variable layer adaptive" }),
  bound("simplify", { id: "simplify", label: "Simplify outlines", group: "quality", tier: "advanced", kind: check, structural: true, keywords: "mesh vertices tolerance" }),
  {
    ...bound("simplifyError", {
      id: "simperr",
      label: "Outline tolerance mm",
      group: "quality",
      tier: "expert",
      kind: num(0, 0.2, 0.005),
      parent: "simplify",
      when: (s) => s.simplify,
      tip: "0 is auto. Every triangle is cut. Each layer's outline then drops vertices closer than this to the line through their neighbors. Auto is a sixteenth of the nozzle, 0.025 mm for 0.4 mm, so a gap the nozzle can print never closes.",
      keywords: "simplify auto",
    }),
    set: (s, value) => { s.simplifyError = Math.max(0, value as number); },
  },

  // Walls & surface
  bound("variableWidth", { id: "vwidth", label: "Variable walls", group: "walls", tier: "simple", kind: check, keywords: "line width thin" }),
  bound("seam", { id: "seam", label: "Seam position", group: "walls", tier: "advanced", kind: select((ctx) => seamOptions(ctx.belt)), keywords: "rear aligned nearest start belt edge" }),
  { id: "seamTools", label: "Paint seam", group: "walls", tier: "advanced", kind: custom },
  bound("scarfSeam", { id: "scarf", label: "Scarf seam", group: "walls", tier: "advanced", kind: select(blendOptions), rule: "scarf", structural: true, keywords: "seam joint" }),
  bound("scarfLength", { id: "scarflen", label: "Scarf length mm", group: "walls", tier: "expert", kind: num(1, 30, 1), parent: "scarf", when: (s) => s.scarfSeam !== "off", rule: "scarf", keywords: "seam" }),
  bound("scarfSteps", { id: "scarfsteps", label: "Scarf steps", group: "walls", tier: "expert", kind: num(2, 32, 1), parent: "scarf", when: (s) => s.scarfSeam !== "off", rule: "scarf", keywords: "seam" }),
  bound("ironing", {
    id: "ironing",
    label: "Ironing",
    group: "walls",
    tier: "advanced",
    kind: check,
    structural: true,
    tip: "A second pass over each top surface at low flow, inset half a line from the outline. Spacing stays below the line width. Defaults are 10% flow, 20 mm/s, and 0.1 mm spacing.",
    keywords: "top skin flow speed spacing",
  }),
  {
    id: "ironflow",
    label: "Ironing flow %",
    group: "walls",
    tier: "advanced",
    kind: num(1, 100, 1),
    parent: "ironing",
    when: (s) => s.ironing,
    preset: "ironingFlow",
    get: (s) => ironingFlowPercent(s.ironingFlow),
    set: (s, value) => { s.ironingFlow = readIroningFlowPercent(String(value)); },
    keywords: "ironing percent",
  },
  {
    id: "ironspeed",
    label: "Ironing speed mm/s",
    group: "walls",
    tier: "advanced",
    kind: num(1, 200, 1),
    parent: "ironing",
    when: (s) => s.ironing,
    preset: "ironingSpeed",
    get: (s) => s.ironingSpeed,
    set: (s, value) => { s.ironingSpeed = readIroningSpeed(String(value)); },
    keywords: "ironing",
  },
  {
    id: "ironspace",
    label: "Ironing spacing mm",
    group: "walls",
    tier: "advanced",
    kind: num(0.05, (ctx) => ironingSpacingMax(ctx.lineWidth), 0.01),
    parent: "ironing",
    when: (s) => s.ironing,
    preset: "ironingSpacing",
    get: (s) => s.ironingSpacing,
    set: (s, value) => { s.ironingSpacing = readIroningSpacing(String(value), ironingSpacingMax(Math.min(1.2, Math.max(0.2, s.profile.nozzleDiameter * 1.125)))); },
    keywords: "ironing line gap",
  },
  bound("fuzzySkin", {
    id: "fuzzy",
    label: "Fuzzy skin",
    group: "walls",
    tier: "advanced",
    kind: check,
    structural: true,
    tip: "A stable sideways noise on the outer walls. Endpoints stay put, so a loop still meets. Defaults are 0.3 mm thickness and 0.8 mm between points.",
    keywords: "outer wall noise texture",
  }),
  {
    id: "fuzzythick",
    label: "Fuzzy thickness mm",
    group: "walls",
    tier: "advanced",
    kind: num(0.05, 1, 0.05),
    parent: "fuzzy",
    when: (s) => s.fuzzySkin,
    preset: "fuzzyThickness",
    get: (s) => s.fuzzyThickness,
    set: (s, value) => { s.fuzzyThickness = readFuzzyThickness(String(value)); },
    keywords: "fuzzy skin",
  },
  {
    id: "fuzzydist",
    label: "Fuzzy point spacing mm",
    group: "walls",
    tier: "advanced",
    kind: num(0.1, 5, 0.1),
    parent: "fuzzy",
    when: (s) => s.fuzzySkin,
    preset: "fuzzyPointDistance",
    get: (s) => s.fuzzyPointDistance,
    set: (s, value) => { s.fuzzyPointDistance = readFuzzyPointDistance(String(value)); },
    keywords: "fuzzy skin spacing",
  },

  // Infill
  bound("infillCombine", { id: "combine", label: "Combine sparse infill", group: "infill", tier: "advanced", kind: check, keywords: "sparse thick layers" }),
  bound("gyroid3d", { id: "gyroid3d", label: "3D gyroid", group: "infill", tier: "expert", kind: select([["blend", "Blend default"], ["off", "2D sine"], ["on", "Force 3D"]]), structural: true, keywords: "infill lattice" }),

  // Speed & travel
  bound("featureSpeeds", { id: "feeds", label: "Per-feature speeds", group: "speed", tier: "simple", kind: check, keywords: "speed feature" }),
  bound("overhangControl", { id: "overhang", label: "Overhang and bridges", group: "speed", tier: "simple", kind: check, keywords: "slow bridge fan" }),
  bound("arcFit", { id: "arcs", label: "Arc fit (G2/G3)", group: "speed", tier: "advanced", kind: check, keywords: "curves gcode" }),
  bound("travelOpt", { id: "travelopt", label: "Travel and seam", group: "speed", tier: "advanced", kind: check, keywords: "order route" }),
  bound("combing", { id: "combing", label: "Hole-aware combing", group: "speed", tier: "advanced", kind: check, keywords: "travel inside walls" }),
  bound("zHop", { id: "zhop", label: "Z-hop", group: "speed", tier: "advanced", kind: select([["blend", "Blend default"], ["off", "Off"], ["smart", "Smart"], ["always", "Always"]]), rule: "zHop", structural: true, keywords: "travel lift" }),
  bound("zHopHeight", { id: "zhopht", label: "Hop height mm", group: "speed", tier: "expert", kind: num(0.1, 2, 0.1), parent: "zhop", when: (s) => s.zHop !== "off", rule: "zHop", keywords: "z-hop lift" }),
  bound("zHopMinTravel", { id: "zhopmin", label: "Hop above travel mm", group: "speed", tier: "expert", kind: num(0.5, 20, 0.5), parent: "zhop", when: (s) => s.zHop !== "off", rule: "zHop", keywords: "z-hop lift" }),
  bound("retractOn", {
    id: "retractset",
    label: "Custom retraction",
    group: "speed",
    tier: "expert",
    kind: check,
    structural: true,
    tip: "Off, a slice keeps the strategy length: 0.35 mm on speed, 0.9 mm on toughness, at 30 mm/s.",
    keywords: "retract filament pull",
  }),
  bound("retractLength", { id: "retractlen", label: "Retract length mm", group: "speed", tier: "expert", kind: num(0, 5, 0.05), parent: "retractset", when: (s) => s.retractOn, keywords: "retraction" }),
  bound("retractSpeed", { id: "retractspd", label: "Retract speed mm/s", group: "speed", tier: "expert", kind: num(5, 80, 1), parent: "retractset", when: (s) => s.retractOn, keywords: "retraction" }),

  // Supports
  bound("supports", { id: "supports", label: "Smart supports", group: "supports", tier: "simple", kind: check, structural: true, keywords: "overhang brace tree" }),
  bound("supportStyle", { id: "sstyle", label: "Style", group: "supports", tier: "advanced", kind: select([["grid", "Sparse grid"], ["tree", "Organic tree"]]), parent: "supports", when: (s) => s.supports, structural: true, keywords: "tree grid organic" }),
  bound("supportAngle", { id: "sangle", label: "Overhang angle °", group: "supports", tier: "advanced", kind: num(20, 70, 5), parent: "supports", when: (s) => s.supports, keywords: "overhang" }),
  bound("supportHeightMult", { id: "shmult", label: "Shaft height ×", group: "supports", tier: "advanced", kind: num(1, 4, 1), parent: "supports", when: (s) => s.supports, keywords: "support column" }),
  bound("branchAngle", { id: "bangle", label: "Branch angle °", group: "supports", tier: "expert", kind: num(15, 60, 5), parent: "sstyle", when: (s) => s.supports && s.supportStyle === "tree", keywords: "tree" }),
  bound("tipDiameter", { id: "tipd", label: "Tip diameter mm", group: "supports", tier: "expert", kind: num(0.4, 2, 0.1), parent: "sstyle", when: (s) => s.supports && s.supportStyle === "tree", keywords: "tree" }),
  bound("trunkDiameter", { id: "trunkd", label: "Trunk diameter mm", group: "supports", tier: "expert", kind: num(1.5, 12, 0.2), parent: "sstyle", when: (s) => s.supports && s.supportStyle === "tree", keywords: "tree" }),
  { id: "supportTools", label: "Paint and edit supports", group: "supports", tier: "simple", kind: custom },

  // Printer details
  { id: "machine", label: "Printer", group: "printer", tier: "advanced", kind: custom },
  profile("bedX", { id: "bedx", label: "Bed X mm", group: "printer", tier: "advanced", kind: num(50, 1000, 1), keywords: "printer volume size" }),
  profile("bedY", { id: "bedy", label: "Bed Y mm", group: "printer", tier: "advanced", kind: num(50, 1000, 1), keywords: "printer volume size" }),
  profile("bedZ", { id: "bedz", label: "Bed Z mm", group: "printer", tier: "advanced", kind: num(20, 1000, 1), keywords: "printer volume height" }),
  profile("maxVolumetricMm3S", { id: "vol", label: "Max flow mm³/s", group: "printer", tier: "advanced", kind: num(1, 60, 0.5), keywords: "volumetric hotend" }),
  profile("maxAccel", { id: "accel", label: "Max accel mm/s²", group: "printer", tier: "advanced", kind: num(100, 20000, 100), keywords: "acceleration" }),
  profile("filamentDensityGCm3", { id: "density", label: "Density g/cm³", group: "printer", tier: "advanced", kind: num(0.8, 2.5, 0.01), keywords: "filament weight grams" }),
  profile("filamentCostPerKg", { id: "cost", label: "Filament €/kg", group: "printer", tier: "advanced", kind: num(0, 200, 1), keywords: "price estimate" }),

  // Calibrate sheet. Towers are not part of the recipe, so none has a preset key.
  { id: "pastart", label: "K start", group: "calibrate", tier: "expert", kind: num(0, 1, 0.005), get: (s) => s.paStart, set: (s, v) => { s.paStart = v as number; } },
  { id: "paend", label: "K end", group: "calibrate", tier: "expert", kind: num(0, 1, 0.005), get: (s) => s.paEnd, set: (s, v) => { s.paEnd = v as number; } },
  { id: "pastep", label: "K step", group: "calibrate", tier: "expert", kind: num(0.001, 0.2, 0.005), get: (s) => s.paStep, set: (s, v) => { s.paStep = v as number; } },
  { id: "flowstart", label: "Flow start", group: "calibrate", tier: "expert", kind: num(0.5, 1.5, 0.01), get: (s) => s.flowStart, set: (s, v) => { s.flowStart = v as number; } },
  { id: "flowend", label: "Flow end", group: "calibrate", tier: "expert", kind: num(0.5, 1.5, 0.01), get: (s) => s.flowEnd, set: (s, v) => { s.flowEnd = v as number; } },
  { id: "flowstep", label: "Flow step", group: "calibrate", tier: "expert", kind: num(0.01, 0.2, 0.01), get: (s) => s.flowStep, set: (s, v) => { s.flowStep = v as number; } },
  { id: "tempstart", label: "°C start", group: "calibrate", tier: "expert", kind: num(150, 320, 1), get: (s) => s.tempStart, set: (s, v) => { s.tempStart = v as number; } },
  { id: "tempend", label: "°C end", group: "calibrate", tier: "expert", kind: num(150, 320, 1), get: (s) => s.tempEnd, set: (s, v) => { s.tempEnd = v as number; } },
  { id: "tempstep", label: "°C step", group: "calibrate", tier: "expert", kind: num(1, 50, 1), get: (s) => s.tempStep, set: (s, v) => { s.tempStep = v as number; } },
  { id: "retractstart", label: "Tower start mm", group: "calibrate", tier: "expert", kind: num(0, 5, 0.05), get: (s) => s.retractStart, set: (s, v) => { s.retractStart = v as number; } },
  { id: "retractend", label: "Tower end mm", group: "calibrate", tier: "expert", kind: num(0, 5, 0.05), get: (s) => s.retractEnd, set: (s, v) => { s.retractEnd = v as number; } },
  { id: "retractstep", label: "Tower step mm", group: "calibrate", tier: "expert", kind: num(0.05, 1, 0.05), get: (s) => s.retractStep, set: (s, v) => { s.retractStep = v as number; } },

  // Gear panel
  {
    ...bound("autoSlice", { id: "autoslice", label: "Auto-slice when a slice takes under 20 s", group: "gear", tier: "simple", kind: check, keywords: "automatic" }),
    set: (s, v) => {
      s.autoSlice = v as boolean;
      saveAutoSlice(s.autoSlice);
    },
  },
];

/**
 * Preset keys no single field edits: the strategy rows set `blendKind` and `strategy`,
 * the machine section's one advance field writes the key the firmware uses, and
 * `pricePerKg` stays in files from before the filament carried its own price.
 */
export const UNFIELDED_PRESET_KEYS: ReadonlySet<keyof PresetSettings> = new Set(["blendKind", "strategy", "pressureAdvance", "linearAdvance", "flow", "pricePerKg"]);

const BY_ID = new Map(CONTROLS.map((spec) => [spec.id, spec]));

export function controlById(id: string): ControlSpec | undefined {
  return BY_ID.get(id);
}

export function controlsOf(group: GroupId): ControlSpec[] {
  return CONTROLS.filter((spec) => spec.group === group);
}

export function groupById(id: GroupId): GroupSpec {
  return GROUPS.find((group) => group.id === id)!;
}

/** Search words of a control: the extra keywords, with the id looked up for rows the panel renders itself. */
export function keywordsOf(id: string): string {
  return BY_ID.get(id)?.keywords ?? "";
}

/** Fields of a group that render as rows (not custom slots). */
export function fieldControls(): ControlSpec[] {
  return CONTROLS.filter((spec) => spec.kind.type !== "custom");
}

/** Controls whose change rebuilds the panel. */
export function isStructural(id: string): boolean {
  return BY_ID.get(id)?.structural === true;
}

export function resolveMax(kind: ControlKind, ctx: SchemaContext): number | undefined {
  if (kind.type !== "number" && kind.type !== "range") return undefined;
  return typeof kind.max === "function" ? kind.max(ctx) : kind.max;
}

export function resolveOptions(kind: ControlKind, ctx: SchemaContext): Options {
  if (kind.type !== "select") return [];
  return typeof kind.options === "function" ? kind.options(ctx) : kind.options;
}
