/**
 * A margin row in the words the legend uses, plus the change `governs` suggests.
 * The sentences match the stress guide's table.
 */
import type { SlicedMargin } from "./study.ts";

export function marginNumber(value: number): string {
  return Math.abs(value) >= 100 ? value.toFixed(1) : value.toPrecision(3);
}

function limitText(value: number): string {
  return Number.isInteger(value) ? value.toFixed(1) : marginNumber(value);
}

function named(margin: SlicedMargin): string {
  const limit = margin.limit;
  if (limit === undefined) return margin.kind;
  if (margin.kind === "minSafetyFactor") return `Safety factor ≥ ${limitText(limit)}`;
  if (margin.kind === "maxDeflectionMm") return `Deflection ≤ ${limitText(limit)} mm`;
  if (margin.kind === "maxMassG") return `Mass ≤ ${limitText(limit)} g`;
  if (margin.kind === "minMassG") return `Mass ≥ ${limitText(limit)} g`;
  return margin.kind;
}

/** "Safety factor ≥ 1.0: 2.50 (margin 1.50) · met · above the band". */
export function marginSentence(margin: SlicedMargin): string {
  const note = margin.note ? ` · ${margin.note}` : "";
  const met = margin.met ? "met" : "not met";
  return `${named(margin)}: ${marginNumber(margin.value)} (margin ${marginNumber(margin.margin)}) · ${met}${note}`;
}

/** `governs` and the change to try. The same table as the stress guide. */
export function governsSentence(governs: string, role?: string): string {
  if (governs === "across-layers" || governs === "interlayer-shear") {
    return `${governs} · Orientation. workplane_print_up or the object's orient. More walls rarely help.`;
  }
  if (governs === "across-bead") {
    return "across-bead · Wall count, line width, or an infill pattern with more crossing (settings_set).";
  }
  if (governs === "along-bead" && role === "sparse") {
    return "along-bead · Infill density or reinforcement at the hot spot (reinforce_add).";
  }
  if (governs === "along-bead" && (role === "outer" || role === "wall")) {
    return "along-bead · Geometry. A fillet or a thicker section at nearestFace (model_apply).";
  }
  return governs;
}
