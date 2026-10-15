/**
 * The part-cooling fan a filament carries and a slice sends on `printer`, the way it carries
 * its nozzle temperature. Percent of full fan, and whole layers.
 */
export interface FanSettings {
  /** The fan from the first layer it is on. */
  fanPercent: number;
  /** Overhang spans and bridges. A set Bridge fan % still wins on bridges. */
  overhangFanPercent: number;
  /** Layers printed with the fan off. */
  fanOffLayers: number;
  /** Support paths. Absent, they follow `fanPercent`. */
  supportFanPercent?: number;
}

export const FAN_KEYS = ["fanPercent", "overhangFanPercent", "fanOffLayers", "supportFanPercent"] as const;

export const MAX_FAN_OFF_LAYERS = 20;

/**
 * Generic values by material, from OrcaSlicer's OrcaFilamentLibrary base profiles
 * (`fan_min_speed`, `overhang_fan_speed`, `close_fan_the_first_x_layers`). PETG is also
 * IdeaFormer's own Generic PETG. Support follows the fan on all four, as their
 * `support_material_interface_fan_speed` of -1 does.
 */
const BY_MATERIAL: Record<string, FanSettings> = {
  PLA: { fanPercent: 100, overhangFanPercent: 100, fanOffLayers: 1 },
  PETG: { fanPercent: 20, overhangFanPercent: 100, fanOffLayers: 3 },
  ABS: { fanPercent: 10, overhangFanPercent: 80, fanOffLayers: 3 },
  TPU: { fanPercent: 100, overhangFanPercent: 100, fanOffLayers: 1 },
};

/** A material's generic fan. One this table does not name gets PLA's. */
export function fanDefaults(material: string): FanSettings {
  return { ...(BY_MATERIAL[material.trim().toUpperCase()] ?? BY_MATERIAL.PLA!) };
}

/** A typed percent as the engine takes it: a whole number from 0 to 100. */
export function fanPercentValue(value: number): number {
  return Number.isFinite(value) ? Math.min(100, Math.max(0, Math.round(value))) : 0;
}

export function fanLayersValue(value: number): number {
  return Number.isFinite(value) ? Math.min(MAX_FAN_OFF_LAYERS, Math.max(0, Math.round(value))) : 0;
}

/** Only the fan keys of `row`, with a support fan that follows left out. */
export function fanOf(row: FanSettings): FanSettings {
  const out: FanSettings = { fanPercent: row.fanPercent, overhangFanPercent: row.overhangFanPercent, fanOffLayers: row.fanOffLayers };
  if (typeof row.supportFanPercent === "number") out.supportFanPercent = row.supportFanPercent;
  return out;
}

/** The fan stored on a filament or a project, each key that is missing or not a number taken from `fallback`. */
export function readFan(row: Record<string, unknown>, fallback: FanSettings): FanSettings {
  const num = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
  const out: FanSettings = {
    fanPercent: num(row.fanPercent) ? fanPercentValue(row.fanPercent) : fallback.fanPercent,
    overhangFanPercent: num(row.overhangFanPercent) ? fanPercentValue(row.overhangFanPercent) : fallback.overhangFanPercent,
    fanOffLayers: num(row.fanOffLayers) ? fanLayersValue(row.fanOffLayers) : fallback.fanOffLayers,
  };
  if (num(row.supportFanPercent)) out.supportFanPercent = fanPercentValue(row.supportFanPercent);
  else if (!("supportFanPercent" in row) && typeof fallback.supportFanPercent === "number") out.supportFanPercent = fallback.supportFanPercent;
  return out;
}

/**
 * The fan a project opens with: its own when it saved one, else the active filament's, as a
 * project from before fan settings had none.
 */
export function projectFan(saved: Partial<FanSettings>, filament: FanSettings): FanSettings {
  return typeof saved.fanPercent === "number" ? fanOf(saved as FanSettings) : fanOf(filament);
}

/** The fan an undo step keeps. `null` marks a support fan that follows `fanPercent`. */
export type FanSnap = Omit<FanSettings, "supportFanPercent"> & { supportFanPercent: number | null };

export function snapFan(fan: FanSettings): FanSnap {
  return { fanPercent: fan.fanPercent, overhangFanPercent: fan.overhangFanPercent, fanOffLayers: fan.fanOffLayers, supportFanPercent: fan.supportFanPercent ?? null };
}

/** `fan` as an undo step left it. A step from before fan settings has no fan and leaves `fan` alone. */
export function restoreFan(fan: FanSettings, snap: Partial<FanSnap>): FanSettings {
  if (typeof snap.fanPercent !== "number" || typeof snap.overhangFanPercent !== "number" || typeof snap.fanOffLayers !== "number") return fanOf(fan);
  const out: FanSettings = { fanPercent: snap.fanPercent, overhangFanPercent: snap.overhangFanPercent, fanOffLayers: snap.fanOffLayers };
  if (typeof snap.supportFanPercent === "number") out.supportFanPercent = snap.supportFanPercent;
  return out;
}
