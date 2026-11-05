import type { Vec3 } from "./model-tree.ts";

/**
 * One patch of the slice's `partHold` (the MCP's `standsOnNothing.largest`): `at` is where its first layer starts and
 * `first` a spread of that layer's unheld beads, both on the plate, on a flat bed or a belt.
 */
export interface HoldPatch {
  mm: number;
  longestSpanMm: number;
  layers: [number, number];
  at: Vec3;
  first: Vec3[];
}

/**
 * The patches of a slice reply's `partHold` (or the MCP's `standsOnNothing`), largest first; malformed ones are left out.
 * Its own file so a slice reply reads without the print transitions' code.
 */
export function readHoldPatches(raw: unknown): HoldPatch[] {
  if (!raw || typeof raw !== "object") return [];
  const rows = (raw as { largest?: unknown }).largest;
  if (!Array.isArray(rows)) return [];
  const point = (value: unknown): Vec3 | null => (Array.isArray(value) && value.length === 3 && value.every((v) => typeof v === "number" && Number.isFinite(v)) ? [value[0], value[1], value[2]] : null);
  return rows.flatMap((row): HoldPatch[] => {
    if (!row || typeof row !== "object") return [];
    const r = row as Record<string, unknown>;
    const at = point(r.at);
    const layers = Array.isArray(r.layers) && r.layers.length === 2 && r.layers.every((v) => Number.isInteger(v)) ? (r.layers as number[]) : null;
    if (!at || !layers || typeof r.mm !== "number") return [];
    const first = Array.isArray(r.first) ? r.first.map(point).filter((p): p is Vec3 => p !== null) : [];
    return [{ mm: r.mm, longestSpanMm: typeof r.longestSpanMm === "number" ? r.longestSpanMm : 0, layers: [layers[0]!, layers[1]!], at, first }];
  });
}
