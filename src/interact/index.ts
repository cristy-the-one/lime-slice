/**
 * Shared interaction for sketches and push/pull. No tool calls these yet.
 * The right-hand gizmo stays for Place and Workplane; an in-place arrow is a feature handle.
 */

export {
  ARROW_CLEARANCE,
  arrowShaftStart,
  inPlaceArrow,
  type InPlaceArrowHandle,
  type InPlaceArrowSpec,
} from "./in-place-arrow.ts";
export {
  dragAxis,
  FACE_SNAP_PX,
  repeatClick,
  REPEAT_MS,
  REPEAT_PX,
  type AxisDrag,
  type AxisDragInput,
  type AxisLine,
  type ClickAt,
  type FaceLevel,
  type Ray,
} from "./drag-axis.ts";
export {
  FILLET_AROUND,
  facePrism,
  filletGhost,
  GHOST_PROBE_WAIT_MS,
  previewIsGhost,
  regionExtrude,
  REVOLVE_STEPS,
  revolveGhost,
  triangulate,
  type FilletGhost,
  type PlaneFrame,
  type RevolveGhost,
} from "./ghosts.ts";
export {
  emptyHud,
  formatDimension,
  formatNumber,
  HUD_HINT,
  HUD_MAX_FIELDS,
  hudKey,
  hudSetValues,
  hudText,
  mountHud,
  placeHud,
  type HudBox,
  type HudCommit,
  type HudField,
  type HudModel,
  type HudMount,
  type HudResult,
  type Params,
} from "./hud.ts";
export {
  GRID_MIN_PX,
  gridSpacing,
  SNAP_PX,
  snapHint,
  snapPoint,
  type Pt,
  type SnapContext,
  type SnapEntity,
  type SnapHit,
  type SnapKind,
  type SnapPoint,
} from "./snap.ts";
