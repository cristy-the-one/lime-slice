/** Bed adhesion sent on a slice. Skirt with no loop override is omitted, so the engine keeps its strategy skirt. */

export type AdhesionKind = "skirt" | "brim" | "mouseEars" | "none";

export interface AdhesionChoice {
  adhesion: AdhesionKind;
  brimWidthMm: number;
  brimGapMm: number;
  /** `0` keeps the strategy: 1 loop on speed, 2 on toughness. */
  skirtLoops: number;
}

export interface AdhesionFields {
  adhesion?: "brim" | "mouseEars" | "none";
  brimWidthMm?: number;
  brimGapMm?: number;
  skirtLoops?: number;
}

const WARP = /^(ABS|ASA|PC)([-_ ]|$)/;

/** ABS, ASA, and PC, including a grade suffix such as `ABS-GF`. */
export function warps(material: string): boolean {
  return WARP.test(material.trim().toUpperCase());
}

export function adhesionSliceFields(choice: AdhesionChoice, belt: boolean): AdhesionFields {
  if (belt) return {};
  if (choice.adhesion === "none") return { adhesion: "none" };
  if (choice.adhesion === "brim" || choice.adhesion === "mouseEars") {
    return {
      adhesion: choice.adhesion,
      brimWidthMm: Math.min(30, Math.max(0.4, round(choice.brimWidthMm, 100))),
      brimGapMm: Math.min(2, Math.max(0, round(choice.brimGapMm, 1000))),
    };
  }
  const loops = Math.round(choice.skirtLoops);
  if (loops >= 1) return { skirtLoops: Math.min(20, loops) };
  return {};
}

function round(value: number, scale: number): number {
  const n = Number.isFinite(value) ? value : 0;
  return Math.round(n * scale) / scale;
}
