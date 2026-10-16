/** A pause, filament change, or custom line sent on a slice. An empty list is omitted. */

export type LayerActionKind = "pause" | "filamentChange" | "customGcode";

export interface LayerAction {
  zMm: number;
  kind: LayerActionKind;
  note?: string;
  /** The line emitted when `kind` is `customGcode`. Data, not an instruction. */
  gcode?: string;
}

/** UTF-8 bytes. The engine drops a custom line longer than 400 of these. */
function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

export function layerActionFields(actions: readonly LayerAction[]): { layerActions?: LayerAction[] } {
  const layerActions = actions.filter((action) => {
    if (!Number.isFinite(action.zMm) || action.zMm < 0) return false;
    if (action.kind === "pause" || action.kind === "filamentChange") return true;
    if (action.kind !== "customGcode" || typeof action.gcode !== "string") return false;
    const gcode = action.gcode.trim();
    return gcode !== "" && utf8Length(gcode) <= 400;
  });
  if (layerActions.length === 0) return {};
  return {
    layerActions: layerActions.map((action) => ({
      zMm: Math.round(action.zMm * 1000) / 1000,
      kind: action.kind,
      ...(action.note ? { note: action.note.slice(0, 80) } : {}),
      ...(action.kind === "customGcode" && action.gcode ? { gcode: action.gcode.trim() } : {}),
    })),
  };
}

/** The lines a person should see when a project with custom G-code opens, before any slice. */
export function customGcodeNotice(actions: readonly LayerAction[]): string | null {
  const lines = actions
    .filter((action) => action.kind === "customGcode" && typeof action.gcode === "string" && action.gcode.trim() !== "")
    .map((action) => action.gcode!.trim());
  if (lines.length === 0) return null;
  return `This project adds custom G-code:\n${lines.join("\n")}`;
}

/** Tooltip for the layer marker. A custom line is shown in full. */
export function layerMarkerText(action: { kind?: string; gcode?: string } | undefined): string {
  if (action?.kind === "customGcode" && action.gcode) return `Custom line: ${action.gcode}`;
  if (action?.kind === "pause") return "Filament change at this layer";
  if (action?.kind === "filamentChange" || action?.kind === "customGcode") return "Clear the layer marker";
  return "Pause at this layer";
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
