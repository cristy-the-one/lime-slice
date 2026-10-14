/** A pause or filament change sent on a slice. An empty list is omitted. */

export type LayerActionKind = "pause" | "filamentChange";

export interface LayerAction {
  zMm: number;
  kind: LayerActionKind;
  note?: string;
}

export function layerActionFields(actions: readonly LayerAction[]): { layerActions?: LayerAction[] } {
  const layerActions = actions.filter((action) => Number.isFinite(action.zMm) && action.zMm >= 0 && (action.kind === "pause" || action.kind === "filamentChange"));
  if (layerActions.length === 0) return {};
  return {
    layerActions: layerActions.map((action) => ({
      zMm: Math.round(action.zMm * 1000) / 1000,
      kind: action.kind,
      ...(action.note ? { note: action.note } : {}),
    })),
  };
}

/** None, then pause, then filament change, then none again. */
export function cycleLayerAction(actions: readonly LayerAction[], zMm: number): LayerAction[] {
  const z = Math.round(zMm * 1000) / 1000;
  const next = actions.filter((action) => Math.abs(action.zMm - z) > 0.02);
  const current = actions.find((action) => Math.abs(action.zMm - z) <= 0.02);
  if (!current) return [...next, { zMm: z, kind: "pause" }];
  if (current.kind === "pause") return [...next, { zMm: z, kind: "filamentChange" }];
  return next;
}
