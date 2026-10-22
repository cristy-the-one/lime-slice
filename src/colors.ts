export type ColorMode = "feature" | "weight" | "speed" | "stress" | "safety";

/**
 * Mid-tone hues on the dark stage. `colors.test.ts` holds the minimum CIEDE2000 distance
 * between every pair of features that touch in a print, so a new color has to keep them apart.
 */
export const FEATURE_COLOR: Record<string, string> = {
  outer: "#E0690E",
  inner: "#2A5FD6",
  wall: "#4FA8E8",
  sparse: "#2FA36B",
  infill: "#2FA36B",
  solid: "#E06FB0",
  top: "#DCCB12",
  // Ironing runs over the top skin, so it is a cool cyan that reads against the top's yellow.
  ironing: "#6CD0E8",
  bridge: "#C41E3A",
  // A bead that reaches the outline is teal. An enclosed gap is near white, the one feature
  // that stays pale, so a sliver of it still shows between walls.
  "thin-wall": "#19B5A5",
  "gap-fill": "#E6E8EE",
  skirt: "#9AA0AA",
  // Support is a quiet slate that recedes behind the part. Its interface sheet is aqua.
  support: "#7D8DB8",
  "support-interface": "#62DCC6",
  travel: "#4D5668",
};

export const FEATURE_LABEL: Record<string, string> = {
  outer: "Outer wall",
  inner: "Inner wall",
  wall: "Wall",
  sparse: "Sparse infill",
  infill: "Infill",
  solid: "Solid infill",
  top: "Top / bottom",
  ironing: "Ironing",
  bridge: "Bridge",
  "thin-wall": "Thin wall",
  "gap-fill": "Gap fill",
  skirt: "Skirt",
  support: "Support",
  "support-interface": "Support interface",
  travel: "Travel",
};

export const OTHER_COLOR = "#9AA0AA";

/** Stops spread evenly over 0 to 1. A middle stop keeps the ramp from passing through grey. */
export type Ramp = [string, string, string];
/** Blend weight 0 to 1 maps along these, orange to pink to indigo. */
export const WEIGHT_RAMP: Ramp = ["#F0922B", "#D1478C", "#5A4BD8"];
/** Effective speed across `SPEED_RANGE_MM_S` maps along these, slow blue to fast yellow. */
export const SPEED_RAMP: Ramp = ["#3A4FD8", "#22A85A", "#F0D22A"];
export const SPEED_RANGE_MM_S: [number, number] = [20, 180];
/** Bead stress over the result's peak, cool to hot. */
export const STRESS_RAMP: Ramp = ["#2A5FD6", "#F0D22A", "#C41E3A"];
/** Safety factor, worst first: `SAFETY_RANGE[0]` and under is red, `SAFETY_RANGE[1]` and over is green. */
export const SAFETY_RAMP: Ramp = ["#C41E3A", "#F0D22A", "#2FA36B"];
export const SAFETY_RANGE: [number, number] = [1, 3];

/** The colour modes that read a sliced stress result. */
export function readsStress(mode: ColorMode): boolean {
  return mode === "stress" || mode === "safety";
}

export function stressT(mpa: number, peakMpa: number): number {
  return peakMpa > 0 ? clamp01(mpa / peakMpa) : 0;
}

export function safetyT(safety: number): number {
  const [lo, hi] = SAFETY_RANGE;
  return clamp01((safety - lo) / (hi - lo));
}

/** A bead's colour from the stress cell it sits in. No cell is the neutral grey. */
export function colorForReading(mode: ColorMode, reading: { stressMpa: number; safety: number } | null, peakMpa: number): string {
  if (!reading) return OTHER_COLOR;
  if (mode === "safety") return rampColor(SAFETY_RAMP, safetyT(reading.safety));
  return rampColor(STRESS_RAMP, stressT(reading.stressMpa, peakMpa));
}

export function featureColor(kind: string): string {
  return FEATURE_COLOR[kind] ?? OTHER_COLOR;
}

export function speedT(effectiveSpeed: number): number {
  const [lo, hi] = SPEED_RANGE_MM_S;
  return clamp01((effectiveSpeed - lo) / (hi - lo));
}

export function colorForPath(
  kind: string,
  mode: ColorMode,
  toughness = 0,
  effectiveSpeed = 0,
): string {
  if (kind === "travel") return FEATURE_COLOR.travel;
  if (mode === "weight") return rampColor(WEIGHT_RAMP, clamp01(toughness));
  if (mode === "speed") return rampColor(SPEED_RAMP, speedT(effectiveSpeed));
  // A path with no stress reading is grey; one that has them is coloured bead by bead.
  if (readsStress(mode)) return OTHER_COLOR;
  return featureColor(kind);
}

export function rampColor(ramp: Ramp, t: number): string {
  return t < 0.5 ? lerpHex(ramp[0], ramp[1], t * 2) : lerpHex(ramp[1], ramp[2], t * 2 - 1);
}

export function lerpHex(a: string, b: string, t: number): string {
  const ca = hexRgb(a);
  const cb = hexRgb(b);
  const mix = ca.map((v, i) => Math.round(v + (cb[i] - v) * t));
  return `#${mix.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

export function hexRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function clamp01(v: number) {
  return Math.max(0, Math.min(1, v));
}
