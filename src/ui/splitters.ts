import { ChevronLeft, ChevronRight, createElement } from "lucide";
import {
  dockMode,
  drawerWidth,
  dragMax,
  fitDocks,
  LEFT_MAX,
  LEFT_MIN,
  resultsOpenByDefault,
  RIGHT_MAX,
  RIGHT_MIN,
  type DockFit,
  type DockMode,
  type DockSide,
} from "./panel-budget";

const WIDTH_KEY: Record<DockSide, string> = { left: "lime-slice-panel-left", right: "lime-slice-panel-right" };
/** "1" closed, "0" open; unset follows the window's default. */
const CLOSED_KEY: Record<DockSide, string> = { left: "lime-slice-panel-left-collapsed", right: "lime-slice-panel-right-collapsed" };
const DOCK_ID: Record<DockSide, string> = { left: "#leftDock", right: "#rightDock" };
const NAME: Record<DockSide, string> = { left: "settings", right: "results" };
/** The control that opens each dock; a closing dock hands it the focus. */
const OPENER: Record<DockSide, string> = { left: "#leftToggle", right: "#timing" };
const LAST_KEY = "lime-slice-dock-last";
let fitting = false;
/** Drawers (961–1200 px) start closed each visit and are not stored, so a narrow window never rewrites the docks. */
const drawerOpen: Record<DockSide, boolean> = { left: false, right: false };
let shownMode: DockMode | "compact" | null = null;

function mode(): DockMode | "compact" {
  return compact() ? "compact" : dockMode(window.innerWidth);
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* storage off: the docks still work for this visit */
  }
}

function storedWidth(side: DockSide): number | null {
  const value = Number(read(WIDTH_KEY[side]));
  const [min, max] = side === "left" ? [LEFT_MIN, LEFT_MAX] : [RIGHT_MIN, RIGHT_MAX];
  return Number.isFinite(value) && value >= min && value <= max ? value : null;
}

/** Whether the user wants this dock open, before the window's room is counted. */
function wantsOpen(side: DockSide): boolean {
  const stored = read(CLOSED_KEY[side]);
  if (stored === "1") return false;
  if (stored === "0") return true;
  return side === "left" || resultsOpenByDefault(window.innerWidth);
}

function workspace() {
  return document.querySelector<HTMLElement>(".workspace");
}

function compact() {
  return document.documentElement.classList.contains("layout-compact");
}

/** The dock is on screen: open and not folded for room. */
export function dockShown(side: DockSide): boolean {
  const ws = workspace();
  return !!ws && !ws.classList.contains(side === "left" ? "is-left-collapsed" : "is-right-collapsed");
}

/** Open or close a dock, as its chevron, the rail foot, the estimate, Ctrl+B and Ctrl+Alt+B do. Remembered. */
export function toggleDock(side: DockSide) {
  const ws = workspace();
  // The phone layout has its own sheets.
  if (!ws || compact()) return;
  // A narrow window stacks a dock over the stage on demand; the top bar's Settings and Results buttons do the same.
  if (mode() === "narrow") {
    ws.classList.toggle(side === "left" ? "show-left" : "show-right");
    paintToggles(ws.classList.contains("show-left"), ws.classList.contains("show-right"));
    return;
  }
  setDock(side, !dockShown(side));
}

export function setDock(side: DockSide, open: boolean) {
  const dock = document.querySelector(DOCK_ID[side]);
  const hadFocus = !!dock?.contains(document.activeElement);
  if (mode() === "drawer") {
    // One drawer at a time, over the view.
    drawerOpen[side] = open;
    if (open) drawerOpen[side === "left" ? "right" : "left"] = false;
  } else {
    if (open) write(LAST_KEY, side);
    write(CLOSED_KEY[side], open ? "0" : "1");
  }
  applyFit();
  if (hadFocus && !dockShown(side)) document.querySelector<HTMLElement>(OPENER[side])?.focus();
}

function lastOpened(): DockSide {
  return read(LAST_KEY) === "left" ? "left" : "right";
}

export function mountSplitters() {
  const ws = workspace();
  if (!ws || ws.querySelector(".splitter")) return;
  const handles = { left: mountHandle(ws, "left"), right: mountHandle(ws, "right") };
  for (const side of ["left", "right"] as const) {
    const close = document.querySelector(`${DOCK_ID[side]} .dock-close`);
    close?.append(createElement(side === "left" ? ChevronLeft : ChevronRight, { width: 16, height: 16, "aria-hidden": "true", class: "ico" }));
    close?.addEventListener("click", () => setDock(side, false));
    bindDrag(ws, handles[side], side);
  }
  applyFit();
  window.addEventListener("resize", () => {
    if (!fitting) applyFit();
  });
  window.addEventListener("lime-layout", () => applyFit());
}

function mountHandle(ws: HTMLElement, side: DockSide) {
  const handle = document.createElement("div");
  handle.className = `splitter splitter-${side}`;
  handle.setAttribute("role", "separator");
  handle.setAttribute("aria-orientation", "vertical");
  handle.setAttribute("aria-label", `Resize ${NAME[side]}`);
  ws.append(handle);
  return handle;
}

function bindDrag(ws: HTMLElement, handle: HTMLElement, side: DockSide) {
  handle.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0 || !dockShown(side)) return;
    ev.preventDefault();
    handle.classList.add("is-drag");
    handle.setPointerCapture(ev.pointerId);
    const other = side === "left" ? "right" : "left";
    const move = (e: PointerEvent) => {
      const rect = ws.getBoundingClientRect();
      const dock = document.querySelector<HTMLElement>(DOCK_ID[side])?.getBoundingClientRect();
      const raw = side === "left" ? e.clientX - (dock?.left ?? rect.left) : rect.right - e.clientX;
      const shownOther = dockShown(other) ? (document.querySelector<HTMLElement>(DOCK_ID[other])?.offsetWidth ?? 0) : 0;
      const max = dragMax(side, window.innerWidth, shownOther);
      const px = Math.round(Math.min(max, Math.max(side === "left" ? LEFT_MIN : RIGHT_MIN, raw)));
      write(WIDTH_KEY[side], String(px));
      applyFit();
    };
    const up = () => {
      handle.classList.remove("is-drag");
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  });
  handle.addEventListener("dblclick", () => {
    write(WIDTH_KEY[side], null);
    applyFit();
  });
}

/**
 * Widths and folds for the current window: docks beside the stage, drawers over it from 961 to 1200 px, and below
 * that the stylesheet's stacked layout.
 */
function currentFit(): DockFit {
  if (mode() === "drawer") {
    const width = drawerWidth(window.innerWidth);
    return { left: drawerOpen.left ? width : 0, right: drawerOpen.right ? width : 0 };
  }
  const leftOpen = wantsOpen("left");
  const rightOpen = wantsOpen("right");
  const fit = mode() === "compact"
    ? null
    : fitDocks({
      width: window.innerWidth,
      leftOpen,
      rightOpen,
      leftDesired: storedWidth("left"),
      rightDesired: storedWidth("right"),
      last: lastOpened(),
    });
  if (fit) return fit;
  return { left: leftOpen ? (storedWidth("left") ?? -1) : 0, right: rightOpen ? (storedWidth("right") ?? -1) : 0 };
}

function applyFit() {
  const ws = workspace();
  if (!ws || fitting) return;
  const fit = currentFit();
  const next = {
    left: fit.left > 0 ? `${fit.left}px` : fit.left === 0 ? "0px" : "",
    right: fit.right > 0 ? `${fit.right}px` : fit.right === 0 ? "0px" : "",
  };
  const leftClosed = fit.left === 0;
  const rightClosed = fit.right === 0;
  for (const [side, closed] of [["left", leftClosed], ["right", rightClosed]] as const) {
    if (closed && document.querySelector(DOCK_ID[side])?.contains(document.activeElement)) document.querySelector<HTMLElement>(OPENER[side])?.focus();
  }
  paintToggles(!leftClosed, !rightClosed);
  const now = mode();
  const drawers = now === "drawer";
  const modeChanged = now !== shownMode;
  shownMode = now;
  if (
    !modeChanged
    && ws.style.getPropertyValue("--panel-left") === next.left
    && ws.style.getPropertyValue("--panel-right") === next.right
    && ws.classList.contains("is-left-collapsed") === leftClosed
    && ws.classList.contains("is-right-collapsed") === rightClosed
  ) return;
  fitting = true;
  ws.classList.toggle("is-drawers", drawers);
  ws.classList.toggle("is-left-collapsed", leftClosed);
  ws.classList.toggle("is-right-collapsed", rightClosed);
  for (const side of ["left", "right"] as const) {
    const prop = side === "left" ? "--panel-left" : "--panel-right";
    if (next[side]) ws.style.setProperty(prop, next[side]);
    else ws.style.removeProperty(prop);
  }
  // A drawer opens over the view, so the canvas keeps its size and nothing needs to fit again.
  if (!drawers || modeChanged) window.dispatchEvent(new Event("resize"));
  fitting = false;
}

function paintToggles(leftShown: boolean, rightShown: boolean) {
  document.querySelector("#leftToggle")?.setAttribute("aria-expanded", String(leftShown));
  document.querySelector("#timing")?.setAttribute("aria-expanded", String(rightShown));
}
