/** Top-skin fill. `auto` blesses monotonic on the Toughness strategy and leaves every other strategy on the engine's rectilinear default. */

export type SurfacePattern = "auto" | "rectilinear" | "monotonic" | "concentric";

export function surfaceSliceField(
  pattern: SurfacePattern,
  blendKind: string,
  strategy: string,
): { topSurfacePattern?: "monotonic" | "concentric" } {
  const chosen =
    pattern === "auto"
      ? blendKind === "single" && strategy === "toughness"
        ? "monotonic"
        : "rectilinear"
      : pattern;
  if (chosen === "rectilinear") return {};
  return { topSurfacePattern: chosen };
}
