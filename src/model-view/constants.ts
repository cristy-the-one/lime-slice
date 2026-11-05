/** Constants the view's modules share. */
import { HANDLE_ARROW_TIP } from "../gizmo-math";


/** A press on the open solid becomes a grab only once the pointer has moved this far, so a Ctrl-click stays a click. */
export const GRAB_SLOP_PX = 4;
export const GRAB_ROTATE_SNAP_DEG = 15;
export const GRAB_MOVE_SNAP_MM = 1;
/** A snapped move is sent for any change this size or more, so it lands exactly instead of stopping 0.02 mm short. */
export const SNAP_EXACT_MM = 1e-9;
/** P2. The edge drag's ghost is rebuilt when its size changes by this much. */
export const BLEND_GHOST_STEP_MM = 0.05;

/** P1. The push/pull arrow's handle id (`pullHandles` in `model-drag.ts`). */
export const PULL_HANDLE_ID = "pull";

export const EDGE_PX = 16;
/** On-screen length of one handle unit. An arrow is about this long. */
export const HANDLE_PX = 92;
export const IDLE_EDGE = 0x8d9780;
/** Where an arrow's head is centred, in handle units. */
export const ARROW_HEAD = HANDLE_ARROW_TIP - 0.15;
/** Facets of a round primitive's ghost meet at up to 22.5 degrees; its real edges at more. Below this they shade smooth and draw no line. */
export const PRIMITIVE_CREASE_DEG = 25;
/** A join's tool past this many triangles is drawn without its outline, which would take a noticeable while to find. */
export const OBJECT_OUTLINE_MAX_TRIANGLES = 150_000;
/** The load arrow, and the faces it pushes on. */
export const STRESS_LOAD = 0xc2410c;

/** Frames the view still draws after its last change, for anything that settles a frame late. */
export const STILL_FRAMES = 3;
