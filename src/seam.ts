/**
 * REAL. `seam` is on `SliceRequest` (`crates/lime-slice-core/src/slice.rs`).
 * Blend is the strategy's own placement and is left out of the body, so a
 * default slice keeps its recipe key and its G-code bytes.
 */

export type SeamChoice = "blend" | "nearest" | "aligned" | "rear";

export function seamSliceField(seam: SeamChoice): { seam: Exclude<SeamChoice, "blend"> } | Record<string, never> {
  if (seam === "blend") return {};
  return { seam };
}
