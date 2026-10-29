/**
 * Bridge tune sent on a slice. A `null` is Auto and is omitted, and a flow of 1 is omitted,
 * so a default request keeps flow 1, the 18–36 mm/s slowdown, and the overhang fan.
 * A set value lies inside `BRIDGE_LIMITS`, the same range the engine clamps to.
 */

export interface BridgeTune {
  overhangControl: boolean;
  bridgeFlowRatio: number | null;
  bridgeSpeedMmS: number | null;
  bridgeFanPercent: number | null;
}

export type BridgeKey = "bridgeFlowRatio" | "bridgeSpeedMmS" | "bridgeFanPercent";

/** The range each field takes: the engine's own clamp, so a value the box accepts is the value that prints. */
export const BRIDGE_LIMITS: Readonly<Record<BridgeKey, { min: number; max: number }>> = {
  bridgeFlowRatio: { min: 0.2, max: 2 },
  bridgeSpeedMmS: { min: 5, max: 200 },
  bridgeFanPercent: { min: 1, max: 100 },
};

/** Below this a stored number was Auto before Auto existed: the request left it out. */
const AUTO_BELOW: Readonly<Record<BridgeKey, number>> = { bridgeFlowRatio: 1e-9, bridgeSpeedMmS: 1e-6, bridgeFanPercent: 0 };

/**
 * The value a project or profile file stores, as this app keeps it: `null` (Auto) for a missing value, `null`, or
 * the `0` older files wrote for Auto, and a number held to `BRIDGE_LIMITS`, which is what the engine printed for it.
 * `undefined` when the value is not a number.
 */
export function readBridgeValue(key: BridgeKey, value: unknown): number | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (value <= AUTO_BELOW[key]) return null;
  const { min, max } = BRIDGE_LIMITS[key];
  return Math.min(max, Math.max(min, value));
}

function held(key: BridgeKey, value: number | null, round: (value: number) => number): number | undefined {
  if (value === null || !Number.isFinite(value) || value <= AUTO_BELOW[key]) return undefined;
  const { min, max } = BRIDGE_LIMITS[key];
  return Math.min(max, Math.max(min, round(value)));
}

function flowRatio(value: number | null): number | undefined {
  const ratio = held("bridgeFlowRatio", value, (v) => Math.round(v * 1000) / 1000);
  return ratio === undefined || Math.abs(ratio - 1) < 1e-9 ? undefined : ratio;
}

export function bridgeSliceFields(row: BridgeTune): Partial<{ [K in BridgeKey]: number }> {
  if (!row.overhangControl) return {};
  const out: Partial<{ [K in BridgeKey]: number }> = {};
  const flow = flowRatio(row.bridgeFlowRatio);
  const speed = held("bridgeSpeedMmS", row.bridgeSpeedMmS, (v) => Math.round(v * 10) / 10);
  const fan = held("bridgeFanPercent", row.bridgeFanPercent, Math.round);
  if (flow !== undefined) out.bridgeFlowRatio = flow;
  if (speed !== undefined) out.bridgeSpeedMmS = speed;
  if (fan !== undefined) out.bridgeFanPercent = fan;
  return out;
}
