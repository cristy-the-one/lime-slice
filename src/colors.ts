export type ColorMode = "feature" | "weight" | "speed";

export const FEATURE_COLOR: Record<string, string> = {
  outer: "#E69F00",
  inner: "#0072B2",
  wall: "#56B4E9",
  sparse: "#009E73",
  infill: "#009E73",
  solid: "#CC79A7",
  top: "#F0E442",
  bridge: "#D55E00",
  // A bead that reaches the outline stays coral. An enclosed gap is fuchsia so
  // the legend swatch and the 3D preview (same palette) can tell them apart.
  "thin-wall": "#E85D4C",
  "gap-fill": "#D946EF",
  skirt: "#D7D2C6",
  support: "#7AA2F7",
  "support-interface": "#C6A0F6",
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
  bridge: "Bridge",
  "thin-wall": "Thin wall",
  "gap-fill": "Gap fill",
  skirt: "Skirt",
  support: "Support",
  "support-interface": "Support interface",
  travel: "Travel",
};

export const OTHER_COLOR = "#C9C3B6";

/** Blend weight 0 to 1 maps linearly between these. */
export const WEIGHT_RAMP: [string, string] = ["#E69F00", "#009E73"];
/** Effective speed across `SPEED_RANGE_MM_S` maps linearly between these. */
export const SPEED_RAMP: [string, string] = ["#0072B2", "#F0E442"];
export const SPEED_RANGE_MM_S: [number, number] = [20, 180];

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
  if (mode === "weight") return lerpHex(WEIGHT_RAMP[0], WEIGHT_RAMP[1], clamp01(toughness));
  if (mode === "speed") return lerpHex(SPEED_RAMP[0], SPEED_RAMP[1], speedT(effectiveSpeed));
  return featureColor(kind);
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
