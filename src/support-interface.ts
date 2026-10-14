/**
 * Support interface sent on a slice. Each `0` is omitted so a default request
 * keeps the engine's gap, its three interface layers, and trunks with no brim.
 */

export interface SupportInterface {
  supports: boolean;
  supportStyle: string;
  supportZGapMm: number;
  supportXyGapMm: number;
  supportInterfaceLayers: number;
  supportTreeBrimMm: number;
}

function mm(value: number, max: number): number | undefined {
  if (!Number.isFinite(value) || value <= 1e-9) return undefined;
  const rounded = Math.round(value * 1000) / 1000;
  return Math.min(max, Math.max(0, rounded));
}

export function supportSliceFields(row: SupportInterface): Partial<SupportInterface> {
  if (!row.supports) return {};
  const out: Partial<SupportInterface> = {};
  const z = mm(row.supportZGapMm, 2);
  const xy = mm(row.supportXyGapMm, 3);
  const layers = Number.isFinite(row.supportInterfaceLayers) ? Math.round(row.supportInterfaceLayers) : 0;
  const brim = row.supportStyle === "tree" ? mm(row.supportTreeBrimMm, 20) : undefined;
  if (z !== undefined) out.supportZGapMm = z;
  if (xy !== undefined) out.supportXyGapMm = xy;
  if (layers >= 1) out.supportInterfaceLayers = Math.min(8, layers);
  if (brim !== undefined) out.supportTreeBrimMm = brim;
  return out;
}
