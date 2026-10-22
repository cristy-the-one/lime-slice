/**
 * The toughness a print-pattern patch sends. `mix` turns it into the pattern:
 * below 0.20 lightning, below 0.45 lines, below 0.75 grid, and gyroid after that.
 */
export const PATTERN_TOUGHNESS = {
  lightning: 0,
  lines: 0.3,
  grid: 0.6,
  gyroid: 0.9,
} as const;

export type PatternName = keyof typeof PATTERN_TOUGHNESS;

/** The blend a pattern patch puts on the slice request. */
export function patternBlend(pattern: PatternName): { mode: "weight"; toughness: number } {
  return { mode: "weight", toughness: PATTERN_TOUGHNESS[pattern] };
}
