import { fanDefaults, type FanSettings } from "./fan.ts";
import { prefs } from "./prefs.ts";

/** What a slice sends as `printer`. The fan comes from the filament, as the temperatures do. */
export interface PrinterProfile extends FanSettings {
  name: string;
  nozzleDiameter: number;
  filamentDiameter: number;
  nozzleTemp: number;
  bedTemp: number;
  bedX: number;
  bedY: number;
  bedZ: number;
  maxVolumetricMm3S: number;
  maxAccel: number;
  filamentDensityGCm3: number;
  filamentCostPerKg: number;
  pressureAdvance: number;
  linearAdvance: number;
  /** Klipper `[printer]` and `[extruder]` limits. Sent to the engine only for a Klipper printer. */
  squareCornerVelocity: number;
  minimumCruiseRatio: number;
  extruderCornerVelocity: number;
  /** 0 leaves the feeds uncapped. */
  maxVelocity: number;
  /** The belt axis on a belt printer. 0 adds no limit. */
  maxZVelocity: number;
  maxZAccel: number;
  /** The printer's own feature speeds and accelerations. Left out, the blend's numbers. Sent as `printer.speeds`. */
  speeds?: PrinterSpeeds;
}

/**
 * A printer's own speeds (mm/s) and accelerations (mm/s²). Each is what the default blend prints that feature at on
 * this printer; the slider's ends move by the same ratio. The engine reads the same names (`PrinterSpeeds` in Rust).
 */
export interface PrinterSpeeds {
  outerWall?: number;
  innerWall?: number;
  sparseInfill?: number;
  solidInfill?: number;
  topSurface?: number;
  gapInfill?: number;
  support?: number;
  supportInterface?: number;
  travel?: number;
  /** Walls, skirt and supports on the first layer, and a belt printer's belt-contact edge. Left out, 30. */
  firstLayer?: number;
  /** Infill, solid and top on the first layer. Left out, `firstLayer`. */
  firstLayerInfill?: number;
  accel?: number;
  outerWallAccel?: number;
  innerWallAccel?: number;
  sparseInfillAccel?: number;
  solidInfillAccel?: number;
  topSurfaceAccel?: number;
  travelAccel?: number;
  /** Every move on the first layer. Left out, no first-layer limit. */
  firstLayerAccel?: number;
}

export const PRINTER_SPEED_KEYS: readonly (keyof PrinterSpeeds)[] = [
  "outerWall",
  "innerWall",
  "sparseInfill",
  "solidInfill",
  "topSurface",
  "gapInfill",
  "support",
  "supportInterface",
  "travel",
  "firstLayer",
  "firstLayerInfill",
  "accel",
  "outerWallAccel",
  "innerWallAccel",
  "sparseInfillAccel",
  "solidInfillAccel",
  "topSurfaceAccel",
  "travelAccel",
  "firstLayerAccel",
];

/** The positive, finite numbers of a stored speeds block; `undefined` when it holds none. */
export function readPrinterSpeeds(value: unknown): PrinterSpeeds | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  const out: PrinterSpeeds = {};
  for (const key of PRINTER_SPEED_KEYS) {
    const n = row[key];
    if (typeof n === "number" && Number.isFinite(n) && n > 0 && n <= 100000) out[key] = n;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export type KlipperLimits = Pick<PrinterProfile, "squareCornerVelocity" | "minimumCruiseRatio" | "extruderCornerVelocity" | "maxVelocity" | "maxZVelocity" | "maxZAccel">;

/** Klipper's own defaults for the three it names, and no cap or Z limit. */
export const KLIPPER_NUMBERS: KlipperLimits = {
  squareCornerVelocity: 5,
  minimumCruiseRatio: 0.5,
  extruderCornerVelocity: 1,
  maxVelocity: 0,
  maxZVelocity: 0,
  maxZAccel: 0,
};

const KEY = "lime-slice.profile.v1";

export function defaultProfile(): PrinterProfile {
  return {
    name: "Generic Marlin 0.4 mm PLA",
    nozzleDiameter: 0.4,
    filamentDiameter: 1.75,
    nozzleTemp: 200,
    bedTemp: 60,
    bedX: 220,
    bedY: 220,
    bedZ: 250,
    maxVolumetricMm3S: 12,
    maxAccel: 10000,
    filamentDensityGCm3: 1.24,
    filamentCostPerKg: 20,
    pressureAdvance: 0,
    linearAdvance: 0,
    ...KLIPPER_NUMBERS,
    ...fanDefaults("PLA"),
  };
}

export function loadProfile(): PrinterProfile {
  try {
    const raw = prefs.get(KEY);
    if (!raw) return defaultProfile();
    return { ...defaultProfile(), ...JSON.parse(raw) };
  } catch {
    return defaultProfile();
  }
}

export function saveProfile(profile: PrinterProfile) {
  prefs.set(KEY, JSON.stringify(profile));
}

export function profileJson(profile: PrinterProfile) {
  return JSON.stringify(profile, null, 2);
}
