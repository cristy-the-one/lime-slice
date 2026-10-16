/** A pause, filament change, or custom line sent on a slice. An empty list is omitted. */

export type LayerActionKind = "pause" | "filamentChange" | "customGcode";

export interface LayerAction {
  zMm: number;
  kind: LayerActionKind;
  note?: string;
  /** The line emitted when `kind` is `customGcode`. Data, not an instruction. */
  gcode?: string;
}

export function layerActionFields(actions: readonly LayerAction[]): { layerActions?: LayerAction[] } {
  const layerActions = actions.filter((action) => {
    if (!Number.isFinite(action.zMm) || action.zMm < 0) return false;
    if (action.kind === "pause" || action.kind === "filamentChange") return true;
    return action.kind === "customGcode" && typeof action.gcode === "string" && action.gcode.trim() !== "";
  });
  if (layerActions.length === 0) return {};
  return {
    layerActions: layerActions.map((action) => ({
      zMm: Math.round(action.zMm * 1000) / 1000,
      kind: action.kind,
      ...(action.note ? { note: action.note.slice(0, 80) } : {}),
      ...(action.kind === "customGcode" && action.gcode ? { gcode: action.gcode.slice(0, 400) } : {}),
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
