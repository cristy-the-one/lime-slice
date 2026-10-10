/**
 * Which settings apply right now. A control the printer or the plate makes
 * meaningless is hidden, and what it holds is left out of the slice request
 * and out of the settings hash, so editing it never stales a slice.
 *
 * `OWNED` names the request and state keys each control owns. A request, a
 * hash input, and a state snapshot share those names, so one `coerce` serves
 * all three.
 */

export type Firmware = "klipper" | "marlin";

export interface RuleInput {
  /** The active printer: a belt or a cartesian bed, with the belt block it stores either way. */
  kind: "cartesian" | "belt";
  belt: { raftLayers: number; maxLengthMm: number | null };
  firmware: Firmware;
  /** Objects on the plate. */
  objects: number;
}

export type ControlId =
  | "adaptive"
  | "printOrder"
  | "blendCompare"
  | "zHop"
  | "scarf"
  | "beltFields"
  | "beltMaxLength"
  | "beltRaftLayers";

/** Keys a hidden control leaves out. A control with none only changes what the page shows. */
const OWNED: Record<ControlId, readonly string[]> = {
  adaptive: ["adaptive", "adaptiveMin", "adaptiveMax"],
  printOrder: ["printOrder", "sequentialClearance", "sequentialGantry", "sequentialClearanceMm", "sequentialGantryMm"],
  blendCompare: [],
  zHop: ["zHop", "zHopHeight", "zHopMinTravel"],
  scarf: ["scarfSeam", "scarfLength", "scarfSteps", "scarfStartHeight", "scarfStartFlow"],
  beltFields: [],
  beltMaxLength: [],
  beltRaftLayers: [],
};

/** The one advance control a printer shows, and the state key it edits. */
export const ADVANCE: Record<Firmware, { label: string; key: "pressureAdvance" | "linearAdvance"; max: number; step: number }> = {
  klipper: { label: "Pressure advance", key: "pressureAdvance", max: 2, step: 0.001 },
  marlin: { label: "Linear advance K", key: "linearAdvance", max: 2, step: 0.01 },
};

export interface Rules {
  hidden: ReadonlySet<ControlId>;
  /** The printer is a belt. */
  belt: boolean;
  firmware: Firmware;
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
  if (belt || input.objects < 2) hidden.add("printOrder");
  if (belt) hidden.add("blendCompare");
  if (belt) hidden.add("zHop").add("scarf");
  if (!belt) hidden.add("beltFields");
  if (input.belt.maxLengthMm == null) hidden.add("beltMaxLength");
  if (input.belt.raftLayers <= 0) hidden.add("beltRaftLayers");

  const unused: string = ADVANCE[input.firmware === "klipper" ? "marlin" : "klipper"].key;
  const dropped = new Set<string>([unused]);
  for (const id of hidden) for (const key of OWNED[id]) dropped.add(key);

  const without = (record: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(record).filter(([key]) => !dropped.has(key)));
  return {
    hidden,
    belt,
    firmware: input.firmware,
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
