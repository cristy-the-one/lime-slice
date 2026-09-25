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
  "thin-wall": "#E85D4C",
  "gap-fill": "#E85D4C",
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

export function featureColor(kind: string): string {
  return FEATURE_COLOR[kind] ?? "#C9C3B6";
}

export function colorForPath(
  kind: string,
  mode: ColorMode,
  toughness = 0,
  effectiveSpeed = 0,
): string {
  if (kind === "travel") return FEATURE_COLOR.travel;
  if (mode === "weight") return lerpHex("#E69F00", "#009E73", clamp01(toughness));
  if (mode === "speed") return lerpHex("#0072B2", "#F0E442", clamp01((effectiveSpeed - 20) / 160));
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
