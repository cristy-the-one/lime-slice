export interface Box {
  width: number;
  height: number;
}

/** Visible canvas area divided by the screen. 1 is the whole viewport. */
export function canvasShare(canvas: Box, viewport: Box): number {
  if (viewport.width <= 0 || viewport.height <= 0) return 0;
  const width = Math.max(0, canvas.width);
  const height = Math.max(0, canvas.height);
  return (width * height) / (viewport.width * viewport.height);
}

export function chromeCanvasShare(
  viewport: Box,
  chrome: { top: number; sheet: number; tab: number },
): number {
  return canvasShare(
    { width: viewport.width, height: viewport.height - chrome.top - chrome.sheet - chrome.tab },
    viewport,
  );
}
