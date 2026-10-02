export type Detent = "peek" | "half" | "full";

export const PEEK_PX = 56;
export const TOP_PX = 44;
export const TAB_PX = 49;
/** Sheet body at the half detent. Combined with the top and tab bars this leaves ~48% for the model. */
export const HALF_SHEET_RATIO = 0.42;

export function sheetHeight(detent: Detent, viewportHeight: number): number {
  if (detent === "peek") return PEEK_PX;
  if (detent === "half") return Math.round(viewportHeight * HALF_SHEET_RATIO);
  const full = Math.round(viewportHeight - TOP_PX - TAB_PX - viewportHeight * 0.12);
  return Math.max(PEEK_PX, full);
}

/** Snap a dragged sheet height to the nearest detent. */
export function snapDetent(height: number, viewportHeight: number): Detent {
  const options: Detent[] = ["peek", "half", "full"];
  let best: Detent = "peek";
  let dist = Infinity;
  for (const name of options) {
    const next = Math.abs(height - sheetHeight(name, viewportHeight));
    if (next < dist) {
      dist = next;
      best = name;
    }
  }
  return best;
}
