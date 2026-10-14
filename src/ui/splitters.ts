import { ChevronLeft, ChevronRight, createElement, type IconNode } from "lucide";
import {
  allocatePanels,
  LEFT_DEFAULT,
  LEFT_MAX,
  LEFT_MIN,
  panelBudget,
  PANEL_COLLAPSED_PX,
  RIGHT_DEFAULT,
  RIGHT_MAX,
  RIGHT_MIN,
  type PanelFit,
} from "./panel-budget";

const LEFT_KEY = "lime-slice-panel-left";
const RIGHT_KEY = "lime-slice-panel-right";
const LEFT_COLLAPSE = "lime-slice-panel-left-collapsed";
const RIGHT_COLLAPSE = "lime-slice-panel-right-collapsed";

let leftDesired = LEFT_DEFAULT;
let rightDesired = RIGHT_DEFAULT;
/** Which open panel holds its width when the 70% stage budget is tight. */
let keep: "left" | "right" = "right";
let fitting = false;

export function mountSplitters() {
  const workspace = document.querySelector<HTMLElement>(".workspace");
  if (!workspace || workspace.querySelector(".splitter")) return;

  const left = mountHandle(workspace, "left", "Resize settings");
  const right = mountHandle(workspace, "right", "Resize blend");
  const collapseLeft = mountCollapse(workspace, "left", "Collapse settings", ChevronLeft);
  const collapseRight = mountCollapse(workspace, "right", "Collapse blend", ChevronRight);

  const storedLeft = readWidth(LEFT_KEY);
  const storedRight = readWidth(RIGHT_KEY);
  if (storedLeft) leftDesired = storedLeft;
  if (storedRight) rightDesired = storedRight;
  if (localStorage.getItem(LEFT_COLLAPSE) === "1") setCollapsed(workspace, "left", true, collapseLeft);
  // A wide window starts with the results panel folded, so the viewport is at least 70% of the width.
  // Nothing is written until the user folds it. A narrow window keeps the panel in the bottom row.
  if (window.innerWidth > 1200 && localStorage.getItem(RIGHT_COLLAPSE) !== "0") setCollapsed(workspace, "right", true, collapseRight);

  applyFit();
  bindDrag(workspace, left, "left", collapseLeft);
  bindDrag(workspace, right, "right", collapseRight);
  collapseLeft.addEventListener("click", () => toggleCollapsed(workspace, "left", collapseLeft));
  collapseRight.addEventListener("click", () => toggleCollapsed(workspace, "right", collapseRight));
  window.addEventListener("resize", () => {
    if (fitting) return;
    applyFit();
  });
}

function mountHandle(workspace: HTMLElement, side: "left" | "right", label: string) {
  const handle = document.createElement("div");
  handle.className = `splitter splitter-${side}`;
  handle.setAttribute("role", "separator");
  handle.setAttribute("aria-orientation", "vertical");
  handle.setAttribute("aria-label", label);
  workspace.append(handle);
  return handle;
}

function mountCollapse(workspace: HTMLElement, side: "left" | "right", label: string, icon: IconNode) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `btn panel-collapse panel-collapse-${side}`;
  button.setAttribute("aria-label", label);
  button.append(createElement(icon, { width: 14, height: 14, "aria-hidden": "true", class: "ico" }));
  workspace.append(button);
  return button;
}

function bindDrag(
  workspace: HTMLElement,
  handle: HTMLElement,
  side: "left" | "right",
  collapse: HTMLButtonElement,
) {
  handle.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0 || workspace.classList.contains(side === "left" ? "is-left-collapsed" : "is-right-collapsed")) return;
    ev.preventDefault();
    handle.classList.add("is-drag");
    handle.setPointerCapture(ev.pointerId);
    const move = (e: PointerEvent) => {
      const rect = workspace.getBoundingClientRect();
      const px = side === "left"
        ? clamp(e.clientX - rect.left, LEFT_MIN, LEFT_MAX)
        : clamp(rect.right - e.clientX, RIGHT_MIN, RIGHT_MAX);
      if (side === "left") {
        leftDesired = px;
        keep = "left";
      } else {
        rightDesired = px;
        keep = "right";
      }
      localStorage.setItem(side === "left" ? LEFT_KEY : RIGHT_KEY, String(px));
      applyFit();
    };
    const up = () => {
      handle.classList.remove("is-drag");
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
  });
  handle.addEventListener("dblclick", () => {
    localStorage.removeItem(side === "left" ? LEFT_KEY : RIGHT_KEY);
    if (side === "left") leftDesired = LEFT_DEFAULT;
    else rightDesired = RIGHT_DEFAULT;
    keep = "right";
    setCollapsed(workspace, side, false, collapse);
    localStorage.setItem(side === "left" ? LEFT_COLLAPSE : RIGHT_COLLAPSE, "0");
    applyFit();
  });
}

/**
 * Open the results column after a slice. A user who stored a collapse stays collapsed.
 * The automatic open does not become the stored default, so the next fresh window folds again.
 * Opening it slims both panels so the stage stays at least 70% of the window.
 */
export function openResultsAfterSlice() {
  if (window.innerWidth <= 1200) return;
  if (localStorage.getItem(RIGHT_COLLAPSE) === "1") return;
  const workspace = document.querySelector<HTMLElement>(".workspace");
  if (!workspace?.classList.contains("is-right-collapsed")) return;
  const pref = localStorage.getItem(RIGHT_COLLAPSE);
  document.querySelector<HTMLButtonElement>(".panel-collapse-right")?.click();
  if (pref === null) localStorage.removeItem(RIGHT_COLLAPSE);
}

function toggleCollapsed(workspace: HTMLElement, side: "left" | "right", button: HTMLButtonElement) {
  const collapsed = !workspace.classList.contains(side === "left" ? "is-left-collapsed" : "is-right-collapsed");
  setCollapsed(workspace, side, collapsed, button);
  localStorage.setItem(side === "left" ? LEFT_COLLAPSE : RIGHT_COLLAPSE, collapsed ? "1" : "0");
  applyFit();
}

function setCollapsed(workspace: HTMLElement, side: "left" | "right", collapsed: boolean, button: HTMLButtonElement) {
  workspace.classList.toggle(side === "left" ? "is-left-collapsed" : "is-right-collapsed", collapsed);
  button.setAttribute(
    "aria-label",
    collapsed
      ? side === "left" ? "Expand settings" : "Expand blend"
      : side === "left" ? "Collapse settings" : "Collapse blend",
  );
}

function applyFit() {
  const workspace = document.querySelector<HTMLElement>(".workspace");
  if (!workspace || fitting) return;
  const compact = document.documentElement.classList.contains("layout-compact");
  const budget = compact ? null : panelBudget(window.innerWidth);
  // Below the desktop breakpoint the results panel is a bottom row. Leave the stylesheet widths alone
  // unless the user stored one or a panel is folded, so a narrow window does not inherit a desktop clamp.
  if (budget === null) {
    restoreFlexible(workspace);
    return;
  }
  const fit = allocatePanels({
    budget,
    leftCollapsed: workspace.classList.contains("is-left-collapsed"),
    rightCollapsed: workspace.classList.contains("is-right-collapsed"),
    leftDesired,
    rightDesired,
    keep,
  });
  const slim = !fit.hud && !workspace.classList.contains("is-right-collapsed") && fit.right > 0 && fit.right < RIGHT_DEFAULT;
  if (
    workspace.classList.contains("is-right-hud") === fit.hud
    && workspace.classList.contains("is-slim-results") === slim
    && readPx(workspace, "--panel-left") === fit.left
    && readPx(workspace, "--panel-right") === fit.right
  ) return;
  fitting = true;
  workspace.classList.toggle("is-right-hud", fit.hud);
  workspace.classList.toggle("is-slim-results", slim);
  writeFit(workspace, fit);
  window.dispatchEvent(new Event("resize"));
  fitting = false;
}

function restoreFlexible(workspace: HTMLElement) {
  const leftCollapsed = workspace.classList.contains("is-left-collapsed");
  const rightCollapsed = workspace.classList.contains("is-right-collapsed");
  const nextLeft = leftCollapsed ? `${PANEL_COLLAPSED_PX}px` : (readWidth(LEFT_KEY) ? `${leftDesired}px` : "");
  const nextRight = rightCollapsed ? `${PANEL_COLLAPSED_PX}px` : (readWidth(RIGHT_KEY) ? `${rightDesired}px` : "");
  const same = workspace.style.getPropertyValue("--panel-left") === nextLeft
    && workspace.style.getPropertyValue("--panel-right") === nextRight
    && !workspace.classList.contains("is-right-hud")
    && !workspace.classList.contains("is-slim-results");
  if (same) return;
  fitting = true;
  workspace.classList.remove("is-right-hud", "is-slim-results");
  if (nextLeft) workspace.style.setProperty("--panel-left", nextLeft);
  else workspace.style.removeProperty("--panel-left");
  if (nextRight) workspace.style.setProperty("--panel-right", nextRight);
  else workspace.style.removeProperty("--panel-right");
  window.dispatchEvent(new Event("resize"));
  fitting = false;
}

function writeFit(workspace: HTMLElement, fit: PanelFit) {
  workspace.style.setProperty("--panel-left", `${fit.left}px`);
  workspace.style.setProperty("--panel-right", `${fit.right}px`);
}

function readPx(workspace: HTMLElement, prop: "--panel-left" | "--panel-right") {
  const value = Number.parseFloat(workspace.style.getPropertyValue(prop));
  return Number.isFinite(value) ? value : -1;
}

function readWidth(key: string) {
  const value = Number(localStorage.getItem(key));
  if (!Number.isFinite(value)) return 0;
  if (key === LEFT_KEY) return value >= LEFT_MIN && value <= LEFT_MAX ? value : 0;
  return value >= RIGHT_MIN && value <= RIGHT_MAX ? value : 0;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
