/**
 * Desktop panel widths that leave the centre stage at least 70% of the window.
 * The tool rail is a fixed 40px column between settings and the stage, so the
 * two panels share `floor(width * 0.30) - 40`.
 */

export const PANEL_RAIL_PX = 40;
export const PANEL_COLLAPSED_PX = 28;
export const LEFT_MIN = 180;
export const LEFT_MAX = 480;
export const LEFT_DEFAULT = 300;
/** Preferred results rail. The drag range starts here and the budget may slim it further. */
export const RIGHT_MIN = 200;
export const RIGHT_MAX = 560;
export const RIGHT_DEFAULT = 240;
/** Narrowest docked results rail before it floats over the stage. */
export const RIGHT_FLOOR = 140;
export const DESKTOP_MIN_PX = 1200;

export interface PanelWish {
  /** Combined pixel budget for the two panels, or null when the window is not a desktop layout. */
  budget: number | null;
  leftCollapsed: boolean;
  rightCollapsed: boolean;
  leftDesired: number;
  rightDesired: number;
  /** Which open panel keeps its width when both cannot. Defaults to the results rail. */
  keep?: "left" | "right";
}

export interface PanelFit {
  left: number;
  right: number;
  /** Results take no grid column and draw as a floating drawer. */
  hud: boolean;
}

export function panelBudget(windowWidth: number): number | null {
  if (windowWidth <= DESKTOP_MIN_PX) return null;
  return Math.max(PANEL_COLLAPSED_PX * 2, Math.floor(windowWidth * 0.3) - PANEL_RAIL_PX);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

/**
 * Fit the two panels into `budget`. The panel named by `keep` holds its width and the
 * other one yields: settings down to {@link LEFT_MIN}, the results rail down to
 * {@link RIGHT_FLOOR}. The default keeps the results rail, so opening it after a slice
 * slims settings first. If the floors still overflow, the results panel floats and the
 * stage keeps the whole budget.
 */
export function allocatePanels(input: PanelWish): PanelFit {
  const leftWant = clamp(input.leftDesired, LEFT_MIN, LEFT_MAX);
  const rightWant = clamp(input.rightDesired, RIGHT_MIN, RIGHT_MAX);
  if (input.budget === null) {
    return {
      left: input.leftCollapsed ? PANEL_COLLAPSED_PX : leftWant,
      right: input.rightCollapsed ? PANEL_COLLAPSED_PX : rightWant,
      hud: false,
    };
  }

  let left = input.leftCollapsed ? PANEL_COLLAPSED_PX : leftWant;
  let right = input.rightCollapsed ? PANEL_COLLAPSED_PX : rightWant;
  const budget = input.budget;
  if (left + right <= budget) return { left, right, hud: false };

  const leftFloor = input.leftCollapsed ? PANEL_COLLAPSED_PX : LEFT_MIN;
  const rightFloor = input.rightCollapsed ? PANEL_COLLAPSED_PX : RIGHT_FLOOR;
  const shed = (side: "left" | "right") => {
    const floor = side === "left" ? leftFloor : rightFloor;
    const current = side === "left" ? left : right;
    if (current <= floor || left + right <= budget) return;
    const next = current - Math.min(current - floor, left + right - budget);
    if (side === "left") left = next;
    else right = next;
  };
  if (input.keep === "left") {
    shed("right");
    shed("left");
  } else {
    shed("left");
    shed("right");
  }
  if (left + right <= budget) return { left, right, hud: false };

  if (!input.rightCollapsed) {
    const leftSized = input.leftCollapsed ? PANEL_COLLAPSED_PX : Math.min(leftWant, budget);
    return { left: leftSized, right: 0, hud: true };
  }
  return { left: Math.max(PANEL_COLLAPSED_PX, budget - PANEL_COLLAPSED_PX), right: PANEL_COLLAPSED_PX, hud: false };
}

/** Stage width implied by a fit, used by tests and the viewport budget. */
export function stageWidth(windowWidth: number, fit: PanelFit): number {
  return windowWidth - fit.left - fit.right - PANEL_RAIL_PX;
}
