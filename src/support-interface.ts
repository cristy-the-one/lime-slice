/**
 * Support interface sent on a slice. A `null` is Auto and is omitted, so a default request keeps the engine's gap,
 * its three interface layers, and trunks with no brim. A `0` gap is a real zero and is sent. Zero interface layers
 * is sent as 1, the fewest the engine prints. The tree brim has no Auto: its `0` means no brim and is omitted.
 */

export interface SupportInterface {
  supports: boolean;
  supportStyle: string;
  supportZGapMm: number | null;
  supportXyGapMm: number | null;
  supportInterfaceLayers: number | null;
  supportTreeBrimMm: number;
}

export const SUPPORT_Z_GAP_MAX = 2;
export const SUPPORT_XY_GAP_MAX = 3;
export const SUPPORT_INTERFACE_LAYERS_MAX = 8;

/** The fewest dense layers the engine prints. A typed 0 shows as this. */
export const SUPPORT_INTERFACE_LAYERS_MIN = 1;

function round3(value: number, max: number): number {
  return Math.min(max, Math.max(0, Math.round(value * 1000) / 1000));
}

function gap(value: number | null, max: number): number | undefined {
  if (value === null || !Number.isFinite(value)) return undefined;
  return round3(value, max);
}

function brim(value: number, max: number): number | undefined {
  if (!Number.isFinite(value) || value <= 1e-9) return undefined;
  return round3(value, max);
}

/** The interface layer count a typed value sends: 0 is 1, and the most is 8. `null` is Auto. */
export function interfaceLayersSent(value: number | null): number | undefined {
  if (value === null || !Number.isFinite(value)) return undefined;
  return Math.min(SUPPORT_INTERFACE_LAYERS_MAX, Math.max(SUPPORT_INTERFACE_LAYERS_MIN, Math.round(value)));
}

export function supportSliceFields(row: SupportInterface): Partial<{ [K in keyof SupportInterface]: number }> {
  if (!row.supports) return {};
  const out: Partial<{ [K in keyof SupportInterface]: number }> = {};
  const z = gap(row.supportZGapMm, SUPPORT_Z_GAP_MAX);
  const xy = gap(row.supportXyGapMm, SUPPORT_XY_GAP_MAX);
  const layers = interfaceLayersSent(row.supportInterfaceLayers);
  const trunkBrim = row.supportStyle === "tree" ? brim(row.supportTreeBrimMm, 20) : undefined;
  if (z !== undefined) out.supportZGapMm = z;
  if (xy !== undefined) out.supportXyGapMm = xy;
  if (layers !== undefined) out.supportInterfaceLayers = layers;
  if (trunkBrim !== undefined) out.supportTreeBrimMm = trunkBrim;
  return out;
}
