/**
 * Which settings apply right now. A control the printer or the plate makes
 * meaningless is hidden, and what it holds is left out of the slice request
 * and out of the settings hash, so editing it never stales a slice.
 *
 * `OWNED` names the request and state keys each control owns. A request, a
 * hash input, and a state snapshot share those names, so one `coerce` serves
 * all three.
 */

import type { SupportMode } from "./support-source.ts";

export type Firmware = "klipper" | "marlin";

/**
 * Whether the firmware runs G2/G3, when the printer does not say. A stock Klipper
 * `printer.cfg` has no `[gcode_arcs]`, so Klipper skips each arc and the next G1
 * carries its filament; Marlin builds usually have `ARC_SUPPORT`. The engine
 * reads a request without the key the same way.
 */
export function firmwareTakesArcs(firmware: Firmware, said?: boolean): boolean {
  return said ?? firmware !== "klipper";
}

/** The Arc fit tip while the printer's firmware takes no arcs. */
export const ARCS_OFF_REASON: Record<Firmware, string> = {
  klipper: "This printer's firmware doesn't accept G2/G3 arcs, so the slice writes none. Klipper needs a [gcode_arcs] section in printer.cfg; then turn on Firmware accepts arcs under Printer.",
  marlin: "This printer's firmware doesn't accept G2/G3 arcs, so the slice writes none. Marlin needs ARC_SUPPORT in its build; then turn on Firmware accepts arcs under Printer.",
};

export interface RuleInput {
  /** The active printer: a belt or a cartesian bed, with the belt block it stores either way. */
  kind: "cartesian" | "belt";
  belt: { raftLayers: number; maxLengthMm: number | null };
  firmware: Firmware;
  /** The printer's own answer to whether its firmware runs G2/G3. Left out, the firmware's default. */
  firmwareArcs?: boolean;
  /** Objects on the plate. */
  objects: number;
  /** The Supports choice. Left out, it is Automatic. */
  supportMode?: SupportMode;
}

export type ControlId =
  | "supportAngle"
  | "adaptive"
  | "printOrder"
  | "zHop"
  | "scarf"
  | "beltFields"
  | "beltMaxLength"
  | "beltRaftLayers"
  | "klipperLimits"
  | "adhesion"
  | "elephantsFoot"
  | "supportStrictStacking"
  | "arcFit";

/** Controls `disabled` can lock. Each is a check, which the panel shows off and unclickable. */
export const LOCKABLE: ReadonlySet<ControlId> = new Set(["arcFit"]);

/** Keys a hidden control leaves out. A control with none only changes what the page shows. */
const OWNED: Record<ControlId, readonly string[]> = {
  adaptive: ["adaptive", "adaptiveMin", "adaptiveMax"],
  supportAngle: ["supportAngle"],
  printOrder: ["printOrder", "sequentialClearance", "sequentialGantry", "sequentialClearanceMm", "sequentialGantryMm"],
  zHop: ["zHop", "zHopHeight", "zHopMinTravel"],
  scarf: ["scarfSeam", "scarfLength", "scarfSteps", "scarfStartHeight", "scarfStartFlow"],
  beltFields: [],
  beltMaxLength: [],
  beltRaftLayers: [],
  // The firmware name and the limits only Klipper's toolhead reads.
  klipperLimits: ["firmware", "squareCornerVelocity", "minimumCruiseRatio", "extruderCornerVelocity", "maxVelocity", "maxZVelocity", "maxZAccel"],
  adhesion: ["adhesion", "brimWidthMm", "brimGapMm", "skirtLoops"],
  // Layer 0 on a belt is the leading slice, not the face on the belt.
  elephantsFoot: ["elephantsFootCompensationMm"],
  // The rule decides when a belt interface row counts as held; a flat bed has no such rows.
  supportStrictStacking: ["supportStrictStacking"],
  // Never hidden, only disabled; the request keeps the user's choice and the printer's `firmwareArcs` overrules it.
  arcFit: [],
};

/** The one advance control a printer shows, and the state key it edits. */
export const ADVANCE: Record<Firmware, { label: string; key: "pressureAdvance" | "linearAdvance"; max: number; step: number }> = {
  klipper: { label: "Pressure advance", key: "pressureAdvance", max: 2, step: 0.001 },
  marlin: { label: "Linear advance K", key: "linearAdvance", max: 2, step: 0.01 },
};

export interface Rules {
  hidden: ReadonlySet<ControlId>;
  /** Controls shown but not editable, each with the reason its row shows as a tip. */
  disabled: ReadonlyMap<ControlId, string>;
  /** The printer is a belt. */
  belt: boolean;
  firmware: Firmware;
  /** The printer's firmware runs G2/G3. Sent as `printer.firmwareArcs`; off, the engine writes no arcs. */
  firmwareArcs: boolean;
  /**
   * `record` without the keys of hidden controls and without the advance key
   * the firmware does not use. A slice request keeps its advance keys inside
   * `printer`; a state or profile record keeps them at the top, so both are
   * looked at.
   */
  coerce<T extends Record<string, unknown>>(record: T): T;
}

export function settingsRules(input: RuleInput): Rules {
  const belt = input.kind === "belt";
  const hidden = new Set<ControlId>();
  if (belt && input.belt.raftLayers > 0) hidden.add("adaptive");
  if (input.supportMode === "paint") hidden.add("supportAngle");
  if (belt || input.objects < 2) hidden.add("printOrder");
  if (belt) hidden.add("zHop").add("scarf");
  if (!belt) hidden.add("beltFields").add("supportStrictStacking");
  if (belt) hidden.add("adhesion").add("elephantsFoot");
  if (input.belt.maxLengthMm == null) hidden.add("beltMaxLength");
  if (input.belt.raftLayers <= 0) hidden.add("beltRaftLayers");
  if (input.firmware !== "klipper") hidden.add("klipperLimits");
  const firmwareArcs = firmwareTakesArcs(input.firmware, input.firmwareArcs);
  const disabled = new Map<ControlId, string>();
  if (!firmwareArcs) disabled.set("arcFit", ARCS_OFF_REASON[input.firmware]);

  const unused: string = ADVANCE[input.firmware === "klipper" ? "marlin" : "klipper"].key;
  const dropped = new Set<string>([unused]);
  for (const id of hidden) for (const key of OWNED[id]) dropped.add(key);

  const without = (record: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(record).filter(([key]) => !dropped.has(key)));
  return {
    hidden,
    disabled,
    belt,
    firmware: input.firmware,
    firmwareArcs,
    coerce<T extends Record<string, unknown>>(record: T): T {
      const out = without(record);
      const printer = out.printer;
      if (printer && typeof printer === "object" && !Array.isArray(printer)) out.printer = without(printer as Record<string, unknown>);
      return out as T;
    },
  };
}

/** What the engine assumes when a sequential request leaves them out. */
export const SEQUENTIAL_CLEARANCE_MM = 35;
export const SEQUENTIAL_GANTRY_MM = 20;

export interface PrintOrder {
  printOrder: "all-at-once" | "sequential";
  /** 0 is the engine's 35 mm. */
  clearanceMm: number;
  /** 0 is the engine's 20 mm. */
  gantryMm: number;
}

export interface SequentialFields {
  printOrder?: "sequential";
  sequentialClearanceMm?: number;
  sequentialGantryMm?: number;
}

/** The order fields of a request. All-at-once, and a plate the order does not apply to, send none. */
export function orderFields(rules: Rules, order: PrintOrder): SequentialFields {
  if (rules.hidden.has("printOrder") || order.printOrder !== "sequential") return {};
  const out: SequentialFields = { printOrder: "sequential" };
  if (Number.isFinite(order.clearanceMm) && order.clearanceMm > 0) out.sequentialClearanceMm = Math.min(100, Math.round(order.clearanceMm * 1000) / 1000);
  if (Number.isFinite(order.gantryMm) && order.gantryMm > 0) out.sequentialGantryMm = Math.min(500, Math.round(order.gantryMm * 1000) / 1000);
  return out;
}

/** The clearance a sequential plate must keep between objects, or null when the plate prints all at once. */
export function sequentialClearance(rules: Rules, order: PrintOrder): number | null {
  const fields = orderFields(rules, order);
  if (!fields.printOrder) return null;
  return fields.sequentialClearanceMm ?? SEQUENTIAL_CLEARANCE_MM;
}

/** Shortest first, so the engine's gantry rule (every object but the last must be low) holds. Equal heights keep their order. */
export function tallestLast<T>(items: readonly T[], height: (item: T) => number): T[] {
  return [...items].sort((a, b) => height(a) - height(b));
}
