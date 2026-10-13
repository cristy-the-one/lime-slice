/** XY compensation sent on a slice. Each `0` is omitted so a default request stays byte-identical. */

export interface XyComp {
  xyHoleCompensationMm: number;
  xyContourCompensationMm: number;
  elephantsFootCompensationMm: number;
}

function mm(value: number, min: number, max: number): number | undefined {
  if (!Number.isFinite(value) || Math.abs(value) < 1e-9) return undefined;
  const rounded = Math.round(value * 1000) / 1000;
  return Math.min(max, Math.max(min, rounded));
}

export function xySliceFields(comp: XyComp): Partial<XyComp> {
  const out: Partial<XyComp> = {};
  const hole = mm(comp.xyHoleCompensationMm, -2, 2);
  const contour = mm(comp.xyContourCompensationMm, -2, 2);
  const foot = mm(Math.max(0, comp.elephantsFootCompensationMm), 0, 2);
  if (hole !== undefined) out.xyHoleCompensationMm = hole;
  if (contour !== undefined) out.xyContourCompensationMm = contour;
  if (foot !== undefined) out.elephantsFootCompensationMm = foot;
  return out;
}
