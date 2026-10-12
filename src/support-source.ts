/**
 * Where supports come from. The Supports control has three choices, kept as two preset keys:
 * `supports` (on or off) and `supportSource` (what asks for them while on). Off keeps the
 * source at "auto", so one pair of values stands for each choice.
 */

export type SupportSource = "auto" | "paint";
export type SupportMode = "off" | "auto" | "paint";

export const SUPPORT_MODES: [SupportMode, string][] = [["off", "Off"], ["auto", "Automatic"], ["paint", "Painted only"]];

/** The choice a pair of keys stands for. A source the app does not know reads as Automatic. */
export function supportModeOf(s: { supports: boolean; supportSource: string }): SupportMode {
  if (!s.supports) return "off";
  return s.supportSource === "paint" ? "paint" : "auto";
}

/** The pair of keys a choice sets. */
export function supportModeState(mode: SupportMode): { supports: boolean; supportSource: SupportSource } {
  return { supports: mode !== "off", supportSource: mode === "paint" ? "paint" : "auto" };
}

/** Only Painted only is sent, so Off and Automatic keep their recipe key and their bytes. */
export function supportSourceSliceField(supports: boolean, source: string): { supportSource?: "paint" } {
  return supports && source === "paint" ? { supportSource: "paint" } : {};
}
