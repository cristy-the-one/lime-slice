// Lettering on a face: a single-stroke font, each stroke a box raised from the face or cut into it, so text is a
// composite edit like texture or ribs, checked step by step. Letters are drawn on a 4 × 6 grid, cap height 6.

type UV = [number, number];

/** Each glyph's strokes, as polylines on the 4 wide, 6 tall grid. Lowercase reads as capitals. */
const GLYPHS: Record<string, UV[][]> = {
  A: [[[0, 0], [0, 4], [2, 6], [4, 4], [4, 0]], [[0, 3], [4, 3]]],
  B: [[[0, 0], [0, 6], [3, 6], [4, 5], [4, 4], [3, 3], [0, 3]], [[3, 3], [4, 2], [4, 1], [3, 0], [0, 0]]],
  C: [[[4, 6], [1, 6], [0, 5], [0, 1], [1, 0], [4, 0]]],
  D: [[[0, 0], [0, 6], [2, 6], [4, 4], [4, 2], [2, 0], [0, 0]]],
  E: [[[4, 6], [0, 6], [0, 0], [4, 0]], [[0, 3], [3, 3]]],
  F: [[[4, 6], [0, 6], [0, 0]], [[0, 3], [3, 3]]],
  G: [[[4, 5], [3, 6], [1, 6], [0, 5], [0, 1], [1, 0], [3, 0], [4, 1], [4, 3], [2, 3]]],
  H: [[[0, 0], [0, 6]], [[4, 0], [4, 6]], [[0, 3], [4, 3]]],
  I: [[[1, 6], [3, 6]], [[2, 6], [2, 0]], [[1, 0], [3, 0]]],
  J: [[[4, 6], [4, 1], [3, 0], [1, 0], [0, 1]]],
  K: [[[0, 0], [0, 6]], [[4, 6], [0, 2]], [[1.5, 3.5], [4, 0]]],
  L: [[[0, 6], [0, 0], [4, 0]]],
  M: [[[0, 0], [0, 6], [2, 3], [4, 6], [4, 0]]],
  N: [[[0, 0], [0, 6], [4, 0], [4, 6]]],
  O: [[[1, 0], [0, 1], [0, 5], [1, 6], [3, 6], [4, 5], [4, 1], [3, 0], [1, 0]]],
  P: [[[0, 0], [0, 6], [3, 6], [4, 5], [4, 4], [3, 3], [0, 3]]],
  Q: [[[1, 0], [0, 1], [0, 5], [1, 6], [3, 6], [4, 5], [4, 1], [3, 0], [1, 0]], [[2.5, 1.5], [4, 0]]],
  R: [[[0, 0], [0, 6], [3, 6], [4, 5], [4, 4], [3, 3], [0, 3]], [[2, 3], [4, 0]]],
  S: [[[4, 5], [3, 6], [1, 6], [0, 5], [0, 4], [1, 3], [3, 3], [4, 2], [4, 1], [3, 0], [1, 0], [0, 1]]],
  T: [[[0, 6], [4, 6]], [[2, 6], [2, 0]]],
  U: [[[0, 6], [0, 1], [1, 0], [3, 0], [4, 1], [4, 6]]],
  V: [[[0, 6], [2, 0], [4, 6]]],
  W: [[[0, 6], [1, 0], [2, 3], [3, 0], [4, 6]]],
  X: [[[0, 0], [4, 6]], [[0, 6], [4, 0]]],
  Y: [[[0, 6], [2, 3], [4, 6]], [[2, 3], [2, 0]]],
  Z: [[[0, 6], [4, 6], [0, 0], [4, 0]]],
  "0": [[[1, 0], [0, 1], [0, 5], [1, 6], [3, 6], [4, 5], [4, 1], [3, 0], [1, 0]], [[0.5, 1], [3.5, 5]]],
  "1": [[[1, 5], [2, 6], [2, 0]], [[1, 0], [3, 0]]],
  "2": [[[0, 5], [1, 6], [3, 6], [4, 5], [4, 4], [0, 0], [4, 0]]],
  "3": [[[0, 5], [1, 6], [3, 6], [4, 5], [4, 4], [3, 3], [1.5, 3]], [[3, 3], [4, 2], [4, 1], [3, 0], [1, 0], [0, 1]]],
  "4": [[[3, 0], [3, 6], [0, 2], [4, 2]]],
  "5": [[[4, 6], [0, 6], [0, 3.5], [3, 3.5], [4, 2.5], [4, 1], [3, 0], [0, 0]]],
  "6": [[[4, 5], [3, 6], [1, 6], [0, 5], [0, 1], [1, 0], [3, 0], [4, 1], [4, 2], [3, 3], [0, 3]]],
  "7": [[[0, 6], [4, 6], [1, 0]]],
  "8": [[[1, 3], [0, 4], [0, 5], [1, 6], [3, 6], [4, 5], [4, 4], [3, 3], [1, 3], [0, 2], [0, 1], [1, 0], [3, 0], [4, 1], [4, 2], [3, 3]]],
  "9": [[[4, 3], [1, 3], [0, 4], [0, 5], [1, 6], [3, 6], [4, 5], [4, 1], [3, 0], [1, 0]]],
  "-": [[[1, 3], [3, 3]]],
  "+": [[[0, 3], [4, 3]], [[2, 1], [2, 5]]],
  ".": [[[2, 0], [2, 0.01]]],
  ",": [[[2, 0.5], [1.5, -0.8]]],
  ":": [[[2, 4.5], [2, 4.51]], [[2, 1.5], [2, 1.51]]],
  "!": [[[2, 6], [2, 2]], [[2, 0], [2, 0.01]]],
  "?": [[[0, 5], [1, 6], [3, 6], [4, 5], [4, 4], [2, 2.5], [2, 1.8]], [[2, 0], [2, 0.01]]],
  "/": [[[0, 0], [4, 6]]],
  "'": [[[2, 6], [2, 4.5]]],
  "&": [[[4, 0], [1, 4], [1, 5], [2, 6], [3, 5], [3, 4], [0, 2], [0, 1], [1, 0], [2, 0], [4, 2]]],
};

/** One stroke's box on the face: centre, length along the stroke, and its angle from U, in face units (mm). */
export interface StrokeBox {
  centre: UV;
  length: number;
  angleDeg: number;
}

export const TEXT_CHARS = Object.keys(GLYPHS).join("");

/**
 * The boxes that draw `text` at cap `height`, centred on [0, 0] (or starting there with align "left"), strokes `width`
 * wide, letters `spacing` apart (default a third of the height). Null with the first character the font lacks.
 */
export function textStrokes(text: string, height: number, width: number, spacing: number | undefined, align: "centre" | "left" = "centre"): StrokeBox[] | { reason: string } {
  const k = height / 6;
  const gap = spacing ?? height / 3;
  const advance = 4 * k + gap;
  const chars = [...text];
  const missing = chars.find((ch) => ch !== " " && !GLYPHS[ch.toUpperCase()]);
  if (missing) return { reason: `The font has no "${missing}". It has A-Z, 0-9, space, and ${TEXT_CHARS.replace(/[A-Z0-9]/g, "")}.` };
  const total = chars.length * advance - gap;
  const u0 = align === "left" ? 0 : -total / 2;
  const v0 = align === "left" ? 0 : -height / 2;
  const out: StrokeBox[] = [];
  chars.forEach((ch, index) => {
    const glyph = GLYPHS[ch.toUpperCase()];
    if (!glyph) return;
    const left = u0 + index * advance;
    for (const line of glyph) {
      for (let i = 0; i + 1 < line.length; i += 1) {
        const a: UV = [left + line[i]![0] * k, v0 + line[i]![1] * k];
        const b: UV = [left + line[i + 1]![0] * k, v0 + line[i + 1]![1] * k];
        const du = b[0] - a[0];
        const dv = b[1] - a[1];
        // Each stroke runs half a width past both ends, so strokes meet without a notch.
        out.push({ centre: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], length: Math.hypot(du, dv) + width, angleDeg: (Math.atan2(dv, du) * 180) / Math.PI });
      }
    }
  });
  return out;
}
