/** Grab: move or turn a plate object by dragging it with Ctrl (Cmd on a Mac) held. The pointer math lives here so a test can reach it. */
export type GrabAxis = "x" | "y" | "z";
export type GrabIntent = "move" | "rotate";

/** Degrees of turn for each pixel of horizontal drag: a full turn is 720 px. */
export const GRAB_DEG_PER_PX = 0.5;

interface PressLike {
  button: number;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  pointerType?: string;
}

/**
 * What a press starts. Ctrl and the left button move; Ctrl and the right button turn.
 * Alt stays out: some Linux window managers take Alt-drag for themselves. A finger has no Ctrl.
 */
export function grabIntent(press: PressLike): GrabIntent | null {
  if (press.pointerType === "touch") return null;
  if (!(press.ctrlKey || press.metaKey) || press.altKey) return null;
  if (press.button === 0) return "move";
  if (press.button === 2) return "rotate";
  return null;
}

/** The axis an X, Y or Z key locks a turn to, or null for any other key. */
export function grabAxisForKey(key: string): GrabAxis | null {
  const lower = key.toLowerCase();
  return lower === "x" || lower === "y" || lower === "z" ? lower : null;
}

/** Degrees a horizontal drag of `dxPx` turns the part: rightward is positive, as a ring drag counter-clockwise from above. */
export function grabDegrees(dxPx: number): number {
  return dxPx * GRAB_DEG_PER_PX;
}

/** The nearer of two ray hits, so a grab picks the object in front. A missing distance loses. */
export function nearerHit(selected: number | null, other: number | null): "selected" | "other" | null {
  if (selected === null && other === null) return null;
  if (selected === null) return "other";
  if (other === null) return "selected";
  return other < selected ? "other" : "selected";
}
