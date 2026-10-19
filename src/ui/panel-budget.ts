/**
 * Dock widths for the desktop shell. The tool rail is a fixed column at the far left; the settings dock sits beside
 * it and the results dock at the right edge. Together they take at most `floor(width * 0.30)`, so the stage keeps at
 * least 70% of the window.
 */

export type DockSide = "left" | "right";

export const RAIL_PX = 48;
export const LEFT_MIN = 240;
export const LEFT_MAX = 600;
export const RIGHT_MIN = 240;
export const RIGHT_MAX = 560;
/** At and below this width the docks leave the row beside the stage and open as drawers over it. */
export const DESKTOP_MIN_PX = 1200;
/** At and below this width the docks stack over the stage on demand, as before the drawers. */
export const NARROW_MAX_PX = 960;
/** From this width both docks open by themselves. */
export const WIDE_PX = 2400;
/** From this width settings take two columns. */
export const ULTRA_PX = 3000;
/** A drawer's width, leaving the stage a strip to click back into. */
export function drawerWidth(width: number): number {
  return Math.min(320, width - 120);
}

export type DockMode = "dock" | "drawer" | "narrow";

/** How the docks sit for a window width outside the phone layout. */
export function dockMode(width: number): DockMode {
  if (width <= NARROW_MAX_PX) return "narrow";
  return width <= DESKTOP_MIN_PX ? "drawer" : "dock";
}

export interface DockWish {
  width: number;
  leftOpen: boolean;
  rightOpen: boolean;
  /** A width the user dragged, or null for the width's default. */
  leftDesired: number | null;
  rightDesired: number | null;
  /** The dock opened last stays when both cannot. */
  last: DockSide;
}

/** Shown widths; 0 is a dock that is closed or folded for room. */
export interface DockFit {
  left: number;
  right: number;
}

/** Settings and results widths for the window: wider on large screens, two settings columns from 3000 px. */
export function dockDefaults(width: number): DockFit {
  if (width >= ULTRA_PX) return { left: 600, right: 340 };
  if (width >= WIDE_PX) return { left: 360, right: 340 };
  return width >= 1600 ? { left: 320, right: 280 } : { left: 288, right: 300 };
}

/** Whether results start open when the user has not chosen: only where both docks fit beside a large stage. */
export function resultsOpenByDefault(width: number): boolean {
  return width >= WIDE_PX;
}

/** What the rail and the two docks may take, or null when the window is not a desktop layout. */
export function dockBudget(width: number): number | null {
  if (width <= DESKTOP_MIN_PX) return null;
  return Math.floor(width * 0.3) - RAIL_PX;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

/**
 * Fit the open docks into the budget. Results keep their width and settings yield down to {@link LEFT_MIN}; when the
 * two still do not fit, the dock opened last stays and the other folds to the rail. A lone dock is capped at the
 * budget. Null below the desktop breakpoint.
 */
export function fitDocks(wish: DockWish): DockFit | null {
  const budget = dockBudget(wish.width);
  if (budget === null) return null;
  const base = dockDefaults(wish.width);
  const leftWant = clamp(wish.leftDesired ?? base.left, LEFT_MIN, LEFT_MAX);
  const rightWant = clamp(wish.rightDesired ?? base.right, RIGHT_MIN, RIGHT_MAX);
  let left = wish.leftOpen;
  let right = wish.rightOpen;
  let leftPx = leftWant;
  if (left && right && leftPx + rightWant > budget) {
    leftPx = Math.max(LEFT_MIN, budget - rightWant);
    if (leftPx + rightWant > budget) {
      if (wish.last === "left") right = false;
      else left = false;
      leftPx = leftWant;
    }
  }
  return {
    left: left ? Math.min(leftPx, budget) : 0,
    right: right ? Math.min(rightWant, budget) : 0,
  };
}

/**
 * The widest a dragged dock may go. Settings stop where results begin; results may squeeze settings to their floor,
 * not past it, so a drag never folds the other dock.
 */
export function dragMax(side: DockSide, width: number, otherShown: number): number {
  const max = side === "left" ? LEFT_MAX : RIGHT_MAX;
  const min = side === "left" ? LEFT_MIN : RIGHT_MIN;
  const budget = dockBudget(width);
  if (budget === null) return max;
  const other = otherShown > 0 ? (side === "left" ? otherShown : LEFT_MIN) : 0;
  return clamp(budget - other, min, max);
}

/** Stage width implied by a fit. */
export function stageWidth(width: number, fit: DockFit): number {
  return width - RAIL_PX - fit.left - fit.right;
}
