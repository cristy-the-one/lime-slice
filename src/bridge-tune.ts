/**
 * Bridge tune sent on a slice. Each `0` is omitted, and a flow of 1 is omitted,
 * so a default request keeps flow 1, the 18–36 mm/s slowdown, and the layer fan.
 */

export interface BridgeTune {
  overhangControl: boolean;
  bridgeFlowRatio: number;
  bridgeSpeedMmS: number;
  bridgeFanPercent: number;
}

function flowRatio(value: number): number | undefined {
  if (!Number.isFinite(value) || value <= 1e-9) return undefined;
  const rounded = Math.round(value * 1000) / 1000;
  const clamped = Math.min(2, Math.max(0.2, rounded));
  if (Math.abs(clamped - 1) < 1e-9) return undefined;
  return clamped;
}

function speedMm(value: number): number | undefined {
  if (!Number.isFinite(value) || value <= 1e-6) return undefined;
  const rounded = Math.round(value * 10) / 10;
  return Math.min(200, Math.max(5, rounded));
}

function fanPercent(value: number): number | undefined {
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return Math.min(100, Math.max(1, Math.round(value)));
}

export function bridgeSliceFields(row: BridgeTune): Partial<BridgeTune> {
  if (!row.overhangControl) return {};
  const out: Partial<BridgeTune> = {};
  const flow = flowRatio(row.bridgeFlowRatio);
  const speed = speedMm(row.bridgeSpeedMmS);
  const fan = fanPercent(row.bridgeFanPercent);
  if (flow !== undefined) out.bridgeFlowRatio = flow;
  if (speed !== undefined) out.bridgeSpeedMmS = speed;
  if (fan !== undefined) out.bridgeFanPercent = fan;
  return out;
}
