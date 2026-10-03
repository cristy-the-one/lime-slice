export type Detent = "peek" | "half" | "full";

const DETENT_ORDER: Detent[] = ["peek", "half", "full"];

/** ArrowUp grows the sheet. ArrowDown shrinks it. Home is full, End is peek. */
export function moveDetent(current: Detent, key: string): Detent | null {
  const index = DETENT_ORDER.indexOf(current);
  if (key === "ArrowUp") return DETENT_ORDER[Math.min(DETENT_ORDER.length - 1, index + 1)] ?? current;
  if (key === "ArrowDown") return DETENT_ORDER[Math.max(0, index - 1)] ?? current;
  if (key === "Home") return "full";
  if (key === "End") return "peek";
  return null;
}

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
