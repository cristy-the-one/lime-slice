/**
 * Bed offset for a sliced preview.
 *
 * A reply to a posed request carries `offset` (`[x, y]` mm): rotation and Z
 * stay in the slice and X/Y translation is that offset. Every path, patch,
 * gap, skeleton, and in-air mark stays in the reply frame. Draw them at reply
 * coordinates plus the offset, as a group matrix. Do not rewrite the buffers.
 *
 * A plate reply carries one `offset` per object in `objects` instead, and each
 * object's paths are in that object's part frame. The preview draws each
 * object under its own group at its offset (`setObjectOffsets` in
 * `src/view3d.ts`), and the support editor works in the selected object's frame.
 *
 * A reply with no `offset` is in print space: the offset is [0, 0] and a later
 * move is only the change since that pose.
 */

export type Xy = readonly [number, number];

/** Pose and reply the buffers on screen were built from. */
export interface SlicedBed {
  /** Pose translation XY that was sent for this reply. */
  translation: Xy;
  /** `offset` from the reply, or [0, 0] when the engine omitted it. */
  offset: Xy;
  /** Rotation that reply sliced. A change is a real re-slice, not a slide. */
  orientKey: string;
  scale: number;
  meshEpoch: number;
}

export interface BedMotion {
  translation: Xy;
  orientKey: string;
  scale: number;
  meshEpoch: number;
}

/** `[x, y]` mm from the reply. Absent, short, or non-finite means [0, 0]. */
export function replyOffset(offset: readonly number[] | undefined | null): [number, number] {
  if (!offset || offset.length < 2) return [0, 0];
  const x = offset[0];
  const y = offset[1];
  if (!Number.isFinite(x) || !Number.isFinite(y)) return [0, 0];
  return [x, y];
}

/**
 * Where to draw the reply: its offset, plus an X/Y move since the sliced pose.
 * Rotation, scale, Z, and a different mesh do not slide the old paths.
 */
export function shownBedOffset(sliced: SlicedBed | null, current: BedMotion): [number, number] {
  if (!sliced) return [0, 0];
  const base = replyOffset(sliced.offset);
  if (sliced.meshEpoch !== current.meshEpoch) return base;
  if (sliced.orientKey !== current.orientKey || sliced.scale !== current.scale) return base;
  return [
    base[0] + (current.translation[0] - sliced.translation[0]),
    base[1] + (current.translation[1] - sliced.translation[1]),
  ];
}

/** Print XY offset as a scene translation. Print Y is scene −Z. Vertices stay put. */
export function sceneShift(offset: Xy): [number, number, number] {
  return [offset[0], 0, -offset[1]];
}

/** Pointer in the reply frame: subtract the offset that was added for drawing. */
export function replyFrameRay(origin: readonly [number, number, number], offset: Xy): [number, number, number] {
  return [origin[0] - offset[0], origin[1] - offset[1], origin[2]];
}

/**
 * Support-edit sites and regrow regions are already in the reply frame.
 * The drawn offset is not added, so an edit still names the same place after a move.
 */
export function replyFrameEdit<T>(value: T): T {
  return value;
}
