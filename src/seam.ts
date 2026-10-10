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

/**
 * The Seam position choices. On a belt the engine turns a blend seam into the
 * belt edge, so the same value is offered as that and sent as nothing.
 */
export function seamOptions(belt: boolean): [SeamChoice, string][] {
  return [["blend", belt ? "Belt edge" : "Blend (strategy)"], ["nearest", "Nearest"], ["aligned", "Aligned"], ["rear", "Rear"]];
}
