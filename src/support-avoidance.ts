/** Tree avoidance sent on a slice. Off is omitted so the recipe key holds. */

export function avoidanceSliceField(on: boolean): { supportAvoidance?: true } {
  return on ? { supportAvoidance: true } : {};
}

/** A tip under every belt interface row. Off is omitted so the recipe key holds. */
export function strictStackingSliceField(on: boolean): { supportStrictStacking?: true } {
  return on ? { supportStrictStacking: true } : {};
}

/**
 * Gaps between enforce dabs filled. Sent only while supports are on and something is painted,
 * so an unpainted slice keeps its recipe key.
 */
export function paintJoinSliceField(on: boolean, painted: boolean): { supportPaintJoin?: true } {
  return on && painted ? { supportPaintJoin: true } : {};
}

/** Every support printed gently. Off is omitted so the recipe key holds. */
export function slowFragileSliceField(on: boolean): { supportSlowFragile?: true } {
  return on ? { supportSlowFragile: true } : {};
}

/** The gentle feed and acceleration a set value asks for. Auto, and either value while gentle printing is off, is omitted. */
export function gentleSliceFields(
  on: boolean,
  speedMmS: number | null,
  accelMmS2: number | null,
): { supportGentleSpeedMmS?: number; supportGentleAccelMmS2?: number } {
  if (!on) return {};
  const out: { supportGentleSpeedMmS?: number; supportGentleAccelMmS2?: number } = {};
  if (speedMmS !== null && Number.isFinite(speedMmS) && speedMmS > 0) out.supportGentleSpeedMmS = Math.min(200, Math.max(5, Math.round(speedMmS)));
  if (accelMmS2 !== null && Number.isFinite(accelMmS2) && accelMmS2 > 0) out.supportGentleAccelMmS2 = Math.min(20000, Math.max(100, Math.round(accelMmS2)));
  return out;
}

/** The belt anchor spacing the engine takes, mm along the belt. */
export const BELT_ANCHOR_LIMITS = { min: 2, max: 200, default: 10 } as const;

/**
 * Anchor lines across the belt where supports stand on it. Sent only on a belt whose supports stand on the
 * belt (supports on, no raft pad), so a flat bed and a belt without supports keep their recipe key.
 */
export function beltAnchorSliceField(on: boolean, belt: { raftLayers: number } | null, supports: boolean, spacingMm: number): { supportBeltAnchorMm?: number } {
  if (!on || !belt || !supports || belt.raftLayers > 0) return {};
  const mm = Number.isFinite(spacingMm) && spacingMm > 0 ? spacingMm : BELT_ANCHOR_LIMITS.default;
  return { supportBeltAnchorMm: Math.min(BELT_ANCHOR_LIMITS.max, Math.max(BELT_ANCHOR_LIMITS.min, Math.round(mm * 10) / 10)) };
}
