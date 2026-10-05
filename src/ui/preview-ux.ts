import { GIZMO_NUDGE_DEG, GIZMO_NUDGE_MM } from "../gizmo-math.ts";

export type PreviewMode = "flat" | "split" | "solid";

/** Perspective 3D until the user picks 2D or Split. */
export function freshPreviewMode(chosen: PreviewMode | null): PreviewMode {
  return chosen ?? "solid";
}

/** Blur the 3D view while a slice is running or before any result exists. */
export function viewportPending(busy: boolean, hasResult: boolean): boolean {
  return busy || !hasResult;
}

/** Layer index when the user has not scrubbed: the top layer, so the whole part shows. */
export function topLayerIndex(layerCount: number): number {
  return Math.max(0, layerCount - 1);
}

/**
 * Move by 0.1 mm, or rotate by 1° when the rotate tool is selected.
 * `sign` is -1 or +1. A zero sign nudges nothing.
 */
export function gizmoNudge(tool: string | undefined, sign: number): { kind: "move" | "rotate"; amount: number } {
  const dir = sign < 0 ? -1 : sign > 0 ? 1 : 0;
  if (tool === "rotate") return { kind: "rotate", amount: dir * GIZMO_NUDGE_DEG };
  return { kind: "move", amount: dir * GIZMO_NUDGE_MM };
}
