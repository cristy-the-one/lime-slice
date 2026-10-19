/**
 * Shared interaction for sketches and push/pull.
 * The right-hand gizmo stays for Place and Workplane; an in-place arrow is a feature handle.
 * Edge drag (P2) is the first caller: a knob on an edge fillets it, or chamfers it with Alt.
 */

export {
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
  BLEND_STEPS,
  blendGhost,
  facePrism,
  GHOST_PROBE_WAIT_MS,
  loftGhost,
  regionExtrude,
  REVOLVE_STEPS,
  revolveGhost,
  triangulate,
  type BlendSide,
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
export {
  blendDirection,
  blendRadius,
  EDGE_EDIT_MS,
  EDGE_FACE_MM,
  EDGE_KNOB_ID,
  EDGE_MIN_MM,
  EDGE_STEP_MM,
  edgeAppliedNote,
  edgeDragEdges,
  edgeDragKind,
  edgeDragNote,
  edgeDragOp,
  edgeDragRefusal,
  edgeFrame,
  edgeHoverHint,
  edgeIsSmooth,
  edgeSizeRefusal,
  facesOnEdge,
  knobAt,
  tabStillOpen,
  type BlendKind,
} from "./edge-drag.ts";
