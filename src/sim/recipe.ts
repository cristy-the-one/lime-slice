/**
 * The numbers the solver smears. Walls, infill, and the pattern come from the
 * strategy, then from the object, the same way a slice already resolves them.
 * A height range or a modifier wins on a field it sets, inside that region.
 * Reinforcement can raise the infill in its region and cannot lower it.
 * No DOM. The slicer's toughness heuristic on patterns is not read.
 */
import { clampWalls, type OverrideDocument, type SettingOverride } from "../overrides.ts";
import { normalInfillDensity } from "../reinforcement.ts";
import { resolved } from "../strategy.ts";

export const SKIN_LAYERS = 3;

export type SimPattern = "lines" | "grid" | "gyroid" | "lightning";

export interface SimRecipe {
  walls: number;
  lineWidthMm: number;
  layerHeightMm: number;
  skinLayers: number;
  /** Core fraction the smear uses, before a local reinforcement. */
  infill: number;
  pattern: SimPattern;
  patternFactor: number;
  patternMeasured: boolean;
  /** The highest core fraction after reinforcement. Never below `infill`. */
  reinforcedInfill: number;
  /** Fields a range or a volume sets, on top of the base recipe. */
  regions: SimRegion[];
}

export interface SimRegion {
  id: string;
  kind: "range" | "box" | "cylinder" | "sphere";
  walls?: number;
  infill?: number;
}

export interface RecipeInput {
  toughness: number;
  layerHeightMm: number;
  lineWidthMm: number;
  blendKind?: "single" | "weight" | "byLayer" | "byRegion";
  strategy?: "speed" | "toughness";
  /** The object's own walls and infill. Absent keeps the strategy. */
  object?: { walls?: number; infill?: number };
  overrides?: OverrideDocument;
  /** Densities of reinforcement regions. Each one can only raise infill. */
  reinforcementDensities?: readonly number[];
}

const PATTERNS = new Set<SimPattern>(["lines", "grid", "gyroid", "lightning"]);

function patternOf(name: string): SimPattern {
  return PATTERNS.has(name as SimPattern) ? (name as SimPattern) : "grid";
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** A reinforcement density replaces the core only when it is higher. */
export function raisedInfill(base: number, regionDensity: number): number {
  return Math.max(clamp01(base), clamp01(regionDensity));
}

function regionFields(baseWalls: number, baseInfill: number, override: SettingOverride): { walls?: number; infill?: number } {
  const out: { walls?: number; infill?: number } = {};
  if (override.walls !== undefined) out.walls = clampWalls(override.walls);
  if (override.infill !== undefined) out.infill = clamp01(override.infill);
  if (out.walls === baseWalls) delete out.walls;
  if (out.infill !== undefined && Math.abs(out.infill - baseInfill) < 1e-9) delete out.infill;
  return out;
}

/** One recipe for a study. The solver receives these numbers and does not plan a bead. */
export function simRecipe(input: RecipeInput): SimRecipe {
  const blend = input.blendKind ?? "weight";
  // A single strategy is the speed card or the toughness card. A weight uses the slider.
  const toughness = blend === "single" ? ((input.strategy ?? "speed") === "toughness" ? 1 : 0) : input.toughness;
  const card = resolved(toughness, input.layerHeightMm, input.lineWidthMm);
  const pattern = patternOf(card.pattern);
  const walls = input.object?.walls !== undefined ? clampWalls(input.object.walls) : card.walls;
  const infill = normalInfillDensity({
    blendKind: blend,
    strategy: input.strategy ?? "speed",
    toughness: input.toughness,
    objectInfill: input.object?.infill,
  });
  const regions: SimRegion[] = [];
  for (const range of input.overrides?.ranges ?? []) {
    const fields = regionFields(walls, infill, range.override);
    if (fields.walls !== undefined || fields.infill !== undefined) regions.push({ id: range.id, kind: "range", ...fields });
  }
  for (const volume of input.overrides?.volumes ?? []) {
    const fields = regionFields(walls, infill, volume.override);
    if (fields.walls !== undefined || fields.infill !== undefined) regions.push({ id: volume.id, kind: volume.kind, ...fields });
  }
  let reinforcedInfill = infill;
  for (const density of input.reinforcementDensities ?? []) reinforcedInfill = raisedInfill(reinforcedInfill, density);
  return {
    walls,
    lineWidthMm: input.lineWidthMm,
    layerHeightMm: input.layerHeightMm,
    skinLayers: SKIN_LAYERS,
    infill,
    pattern,
    patternFactor: 1,
    patternMeasured: pattern === "grid",
    reinforcedInfill,
    regions,
  };
}
